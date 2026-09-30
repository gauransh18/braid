// Desktop window for braid. The window shows the dashboard served by the bundled `braid` executable,
// which runs in the background as `braid watch` inside the repository you pick.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs,
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{
    menu::{Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, Url, Wry,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

mod monitor;
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

/// Repository whose runs are being watched for notifications.
struct Watched(Mutex<Option<PathBuf>>);

/// Tray pieces the monitor updates as runs come and go.
struct TrayState {
    status: MenuItem<Wry>,
    tray: TrayIcon<Wry>,
}

/// The running `braid watch` process, so it can be replaced when you open another repository and killed on exit.
struct Server(Mutex<Option<CommandChild>>);

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("repo.txt"))
}

fn saved_repo(app: &AppHandle) -> Option<PathBuf> {
    let text = fs::read_to_string(config_file(app)?).ok()?;
    let path = PathBuf::from(text.trim());
    path.is_dir().then_some(path)
}

fn save_repo(app: &AppHandle, repo: &Path) {
    if let Some(file) = config_file(app) {
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, repo.to_string_lossy().as_bytes());
    }
}

/// 192 random bits as hex. The page uses it to authorize start/stop/resume requests to the local server.
fn session_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Start `braid watch` in `repo` and point the window at it.
fn open_repo(app: &AppHandle, repo: &Path) -> Result<(), String> {
    if let Some(old) = app.state::<Server>().0.lock().unwrap().take() {
        let _ = old.kill();
    }
    let port = free_port()?;
    let token = session_token()?;
    let (mut rx, child) = app
        .shell()
        .sidecar("braid")
        .map_err(|e| e.to_string())?
        // The token goes in the environment, not argv, so it does not show up in `ps`.
        .env("BRAID_CONTROL_TOKEN", &token)
        .args(["watch", "--control", "--port", &port.to_string()])
        .current_dir(repo)
        .spawn()
        .map_err(|e| e.to_string())?;

    // Keep the last lines the process printed so a failure can say why.
    let output = Arc::new(Mutex::new(String::new()));
    let sink = output.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let mut text = sink.lock().unwrap();
                    text.push_str(&String::from_utf8_lossy(&line));
                    if text.len() > 2000 {
                        let cut = text.len() - 2000;
                        text.drain(..cut);
                    }
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
    });

    if !wait_for_port(port, Duration::from_secs(15)) {
        let _ = child.kill();
        let why = output.lock().unwrap().trim().to_string();
        return Err(if why.is_empty() {
            "braid did not start".to_string()
        } else {
            why
        });
    }

    *app.state::<Server>().0.lock().unwrap() = Some(child);
    *app.state::<Watched>().0.lock().unwrap() = Some(repo.to_path_buf());
    save_repo(app, repo);
    // The token rides in the URL fragment, which is never sent to the server or written to logs.
    let url = Url::parse(&format!("http://127.0.0.1:{port}/#token={token}")).map_err(|e| e.to_string())?;
    let window = app.get_webview_window("main").ok_or("no window")?;
    window.navigate(url).map_err(|e| e.to_string())?;
    let name = repo.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let _ = window.set_title(&format!("braid - {name}"));
    Ok(())
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Polls the watched repo's run files. Updates the tray and raises notifications, except while the window
/// is focused (the dashboard already shows it).
fn start_monitor(app: AppHandle) {
    thread::spawn(move || {
        let _ = app.notification().request_permission();
        let mut repo: Option<PathBuf> = None;
        let mut seen: Option<HashMap<String, monitor::RunSnap>> = None;
        loop {
            thread::sleep(Duration::from_secs(2));
            let current = app.state::<Watched>().0.lock().unwrap().clone();
            if current != repo {
                repo = current;
                seen = None; // new repo: take a fresh baseline, do not announce old runs
            }
            let Some(path) = &repo else { continue };
            let runs = monitor::read_runs(path, 20);

            if let Some(prev) = &seen {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
                if !focused {
                    for note in monitor::diff(&name, prev, &runs) {
                        let _ = app.notification().builder().title(note.title).body(note.body).show();
                    }
                }
            }

            let active = monitor::active_count(&runs);
            let tray = app.state::<TrayState>();
            let label = match active {
                0 => "Idle".to_string(),
                1 => "1 run active".to_string(),
                n => format!("{n} runs active"),
            };
            let _ = tray.status.set_text(&label);
            let _ = tray.tray.set_tooltip(Some(format!("braid - {label}")));
            // Text next to the icon in the macOS menu bar; other platforms ignore it.
            let _ = tray.tray.set_title(if active > 0 { Some(active.to_string()) } else { None::<String> });
            seen = Some(runs);
        }
    });
}

/// Ask for a repository until one starts or the user cancels. Runs off the main thread: the picker blocks.
fn choose_repo(app: AppHandle, quit_on_cancel: bool) {
    thread::spawn(move || loop {
        let Some(picked) = app
            .dialog()
            .file()
            .set_title("Choose a git repository to watch")
            .blocking_pick_folder()
        else {
            if quit_on_cancel {
                app.exit(0);
            }
            return;
        };
        let Ok(path) = picked.into_path() else { continue };
        match open_repo(&app, &path) {
            Ok(()) => return,
            Err(why) => {
                app.dialog()
                    .message(format!("Could not watch {}:\n\n{why}", path.display()))
                    .kind(MessageDialogKind::Error)
                    .title("braid")
                    .blocking_show();
            }
        }
    });
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Server(Mutex::new(None)))
        .manage(Watched(Mutex::new(None)))
        .setup(|app| {
            let open = MenuItemBuilder::with_id("open-repo", "Open Repository...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let repo_menu = SubmenuBuilder::new(app, "Repository").item(&open).build()?;
            let menu = Menu::default(app.handle())?;
            menu.append(&repo_menu)?;
            app.set_menu(menu)?;

            let status = MenuItem::with_id(app, "status", "Idle", false, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show Braid", true, None::<&str>)?;
            let pick = MenuItem::with_id(app, "tray-open-repo", "Open Repository...", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Braid", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[&status, &PredefinedMenuItem::separator(app)?, &show, &pick, &PredefinedMenuItem::separator(app)?, &quit],
            )?;
            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("braid - Idle")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_window(app),
                    "tray-open-repo" => {
                        show_window(app);
                        choose_repo(app.clone(), false);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;
            app.manage(TrayState { status, tray });
            start_monitor(app.handle().clone());

            let handle = app.handle().clone();
            match saved_repo(&handle) {
                Some(repo) => {
                    thread::spawn(move || {
                        if open_repo(&handle, &repo).is_err() {
                            choose_repo(handle, true);
                        }
                    });
                }
                None => choose_repo(handle, true),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps braid in the tray so notifications keep coming; Quit really quits.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .on_menu_event(|app, event| {
            if event.id() == "open-repo" {
                choose_repo(app.clone(), false);
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build braid desktop");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_window(app);
        }
        if let RunEvent::Exit = event {
            if let Some(child) = app.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
