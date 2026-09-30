// Desktop app for braid. A small launcher offers the ways in (open a repository, recent repositories, a demo);
// each repository then gets a dashboard window served by the bundled `braid` executable, which runs in the
// background as `braid watch` inside that repository.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::{HashMap, HashSet},
    fs,
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::{
    menu::{Menu, MenuItem, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, Wry,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

mod monitor;
#[cfg(target_os = "macos")]
mod dock;
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

/// One dashboard window: its own repository and its own `braid watch` process.
#[derive(Default)]
struct Session {
    child: Option<CommandChild>,
    repo: Option<PathBuf>,
}

/// Sessions by window label. Closing a window ends its session.
struct Sessions(Mutex<HashMap<String, Session>>);

/// Numbers new windows.
struct WindowCounter(AtomicUsize);

/// Tray pieces the monitor updates as runs come and go.
struct TrayState {
    status: MenuItem<Wry>,
    tray: TrayIcon<Wry>,
}

const LAUNCHER: &str = "launcher";
const MAX_RECENT: usize = 8;

fn recent_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("recent.json"))
}

/// Repositories opened before, newest first. Folders that no longer exist are dropped.
fn load_recent(app: &AppHandle) -> Vec<PathBuf> {
    let Some(text) = recent_file(app).and_then(|f| fs::read_to_string(f).ok()) else { return Vec::new() };
    let list: Vec<String> = serde_json::from_str(&text).unwrap_or_default();
    list.into_iter().map(PathBuf::from).filter(|p| p.is_dir()).collect()
}

fn remember_repo(app: &AppHandle, repo: &Path) {
    let Some(file) = recent_file(app) else { return };
    let mut list = load_recent(app);
    list.retain(|p| p != repo);
    list.insert(0, repo.to_path_buf());
    list.truncate(MAX_RECENT);
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let names: Vec<String> = list.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let _ = fs::write(file, serde_json::to_string(&names).unwrap_or_default());
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

/// Start a braid server (`watch` or `demo`) and wait until it answers. Returns its port.
fn start_server(app: &AppHandle, args: &[String], cwd: &Path, token: Option<&str>) -> Result<(u16, CommandChild), String> {
    let port = free_port()?;
    let mut command = app.shell().sidecar("braid").map_err(|e| e.to_string())?;
    // The token goes in the environment, not argv, so it does not show up in `ps`.
    if let Some(token) = token {
        command = command.env("BRAID_CONTROL_TOKEN", token);
    }
    let (mut rx, child) = command
        .args(args.iter().cloned().chain(["--port".to_string(), port.to_string()]))
        .current_dir(cwd)
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
        return Err(if why.is_empty() { "braid did not start".to_string() } else { why });
    }
    Ok((port, child))
}

/// Show a running server in a window: reuse `existing`, or create a dashboard window that opens straight on it
/// (so there is never an empty window while the server starts). Returns the window's label.
fn present(app: &AppHandle, existing: Option<&str>, child: CommandChild, repo: Option<&Path>, url: Url, title: &str) -> Result<String, String> {
    let window = match existing.and_then(|l| app.get_webview_window(l)) {
        Some(w) => {
            // Replace that window's previous server.
            if let Some(old) = app.state::<Sessions>().0.lock().unwrap().get_mut(w.label()).and_then(|s| s.child.take()) {
                let _ = old.kill();
            }
            if let Err(e) = w.navigate(url) {
                let _ = child.kill();
                return Err(e.to_string());
            }
            let _ = w.set_title(title);
            w
        }
        None => {
            let n = app.state::<WindowCounter>().0.fetch_add(1, Ordering::SeqCst) + 2;
            match WebviewWindowBuilder::new(app, format!("w{n}"), WebviewUrl::External(url))
                .title(title)
                .inner_size(1240.0, 820.0)
                .min_inner_size(720.0, 520.0)
                .build()
            {
                Ok(w) => w,
                Err(e) => {
                    let _ = child.kill();
                    return Err(e.to_string());
                }
            }
        }
    };
    let label = window.label().to_string();
    {
        let state = app.state::<Sessions>();
        let mut sessions = state.0.lock().unwrap();
        let session = sessions.entry(label.clone()).or_default();
        session.child = Some(child);
        session.repo = repo.map(Path::to_path_buf);
    }
    let _ = window.show();
    let _ = window.set_focus();
    Ok(label)
}

/// Watch `repo`. `existing` is the window to reuse (switching repository); None opens a new window.
fn open_repo(app: &AppHandle, existing: Option<&str>, repo: &Path) -> Result<String, String> {
    let token = session_token()?;
    let args = vec!["watch".to_string(), "--control".to_string()];
    let (port, child) = start_server(app, &args, repo, Some(&token))?;
    // The token rides in the URL fragment, which is never sent to the server or written to logs.
    let url = Url::parse(&format!("http://127.0.0.1:{port}/#token={token}")).map_err(|e| e.to_string())?;
    let name = repo.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let label = present(app, existing, child, Some(repo), url, &format!("braid - {name}"))?;
    remember_repo(app, repo);
    Ok(label)
}

/// A scripted mock run in a throwaway repository, for trying braid without spending anything.
fn open_demo(app: &AppHandle) -> Result<(), String> {
    let args = vec!["demo".to_string()];
    let (port, child) = start_server(app, &args, &std::env::temp_dir(), None)?;
    let url = Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|e| e.to_string())?;
    present(app, None, child, None, url, "braid - demo").map(|_| ())
}

/// Open `path` from whichever window asked. The launcher is replaced by a dashboard window; a dashboard window
/// switches in place.
fn open_from(app: &AppHandle, label: &str, path: &Path) -> Result<(), String> {
    if label == LAUNCHER {
        open_repo(app, None, path)?;
        close_launcher(app);
        Ok(())
    } else {
        open_repo(app, Some(label), path).map(|_| ())
    }
}

fn close_launcher(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LAUNCHER) {
        let _ = w.destroy();
    }
}

fn report_error(app: &AppHandle, what: &str, why: &str) {
    app.dialog().message(format!("{what}:\n\n{why}")).kind(MessageDialogKind::Error).title("braid").blocking_show();
}

/// Bring braid to the front: the focused window, else the first one, else the launcher.
fn show_window(app: &AppHandle) {
    let windows = app.webview_windows();
    let target = windows.values().find(|w| w.is_focused().unwrap_or(false)).or_else(|| windows.values().next());
    match target {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        None => show_launcher(app),
    }
}

/// The window an action should apply to: the focused one, else any.
fn target_label(app: &AppHandle) -> Option<String> {
    let windows = app.webview_windows();
    windows
        .iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .or_else(|| windows.iter().next())
        .map(|(label, _)| label.clone())
}

/// The small start window: open a repository, pick a recent one, or watch a demo.
fn show_launcher(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LAUNCHER) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("index.html".into()))
        .title("braid")
        .inner_size(520.0, 620.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .build();
    if let Err(e) = built {
        report_error(app, "Could not open a window", &e.to_string());
    }
}

/// New Window: another way in, via the launcher.
fn new_window(app: AppHandle) {
    thread::spawn(move || show_launcher(&app));
}

/// Ask for a repository for the focused window.
fn switch_focused(app: AppHandle) {
    if let Some(label) = target_label(&app) {
        thread::spawn(move || switch_repo(app, label));
    }
}

/// Ask for a repository, and show it in window `label`.
fn switch_repo(app: AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    choose_repo(app, label);
}

/// Calls from the launcher page. Only local windows may invoke them (no capability covers the dashboard's URL).
#[tauri::command]
fn recent_repos(app: AppHandle) -> Vec<String> {
    load_recent(&app).iter().map(|p| p.to_string_lossy().to_string()).collect()
}

#[tauri::command]
fn launcher_choose(app: AppHandle, window: tauri::WebviewWindow) {
    let label = window.label().to_string();
    thread::spawn(move || choose_repo(app, label));
}

#[tauri::command]
fn launcher_open(app: AppHandle, window: tauri::WebviewWindow, path: String) {
    let label = window.label().to_string();
    thread::spawn(move || {
        let path = PathBuf::from(&path);
        if let Err(why) = open_from(&app, &label, &path) {
            report_error(&app, &format!("Could not watch {}", path.display()), &why);
        }
    });
}

#[tauri::command]
fn launcher_demo(app: AppHandle, window: tauri::WebviewWindow) {
    eprintln!("braid: demo requested from {}", window.label());
    thread::spawn(move || match open_demo(&app) {
        Ok(()) => close_launcher_if(&app, window.label()),
        Err(why) => {
            eprintln!("braid: demo failed: {why}");
            report_error(&app, "Could not start the demo", &why)
        }
    });
}

fn close_launcher_if(app: &AppHandle, label: &str) {
    if label == LAUNCHER {
        close_launcher(app);
    }
}

/// Polls the run files of every open window's repository. Updates the tray and raises notifications, except
/// while a window is focused (the dashboard already shows it).
fn start_monitor(app: AppHandle) {
    thread::spawn(move || {
        let _ = app.notification().request_permission();
        let mut seen: HashMap<PathBuf, HashMap<String, monitor::RunSnap>> = HashMap::new();
        loop {
            thread::sleep(Duration::from_secs(2));
            let repos: HashSet<PathBuf> = app.state::<Sessions>().0.lock().unwrap().values().filter_map(|s| s.repo.clone()).collect();
            seen.retain(|path, _| repos.contains(path)); // a repo nobody shows any more: baseline afresh if it returns
            let focused = app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false));

            let mut active = 0;
            for path in &repos {
                let runs = monitor::read_runs(path, 20);
                if let Some(prev) = seen.get(path) {
                    if !focused {
                        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                        for note in monitor::diff(&name, prev, &runs) {
                            let _ = app.notification().builder().title(note.title).body(note.body).show();
                        }
                    }
                }
                active += monitor::active_count(&runs);
                seen.insert(path.clone(), runs);
            }

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
        }
    });
}

/// Ask for a repository until one starts or the user cancels. Runs off the main thread: the picker blocks.
fn choose_repo(app: AppHandle, label: String) {
    loop {
        let Some(picked) = app.dialog().file().set_title("Choose a git repository to watch").blocking_pick_folder() else { return };
        let Ok(path) = picked.into_path() else { continue };
        match open_from(&app, &label, &path) {
            Ok(()) => return,
            Err(why) => report_error(&app, &format!("Could not watch {}", path.display()), &why),
        }
    }
}

/// `--repo PATH` (repeatable) opens one window per repository and skips the launcher.
fn repos_from_args() -> Vec<PathBuf> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    args.windows(2).filter(|w| w[0] == "--repo").map(|w| PathBuf::from(&w[1])).filter(|p| p.is_dir()).collect()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Sessions(Mutex::new(HashMap::new())))
        .manage(WindowCounter(AtomicUsize::new(0)))
        .invoke_handler(tauri::generate_handler![recent_repos, launcher_choose, launcher_open, launcher_demo])
        .setup(|app| {
            // File > New Window / Open Repository, where Mac users look for them.
            let new = MenuItemBuilder::with_id("new-window", "New Window").accelerator("CmdOrCtrl+N").build(app)?;
            let open = MenuItemBuilder::with_id("open-repo", "Open Repository...").accelerator("CmdOrCtrl+O").build(app)?;
            let menu = Menu::default(app.handle())?;
            let mut placed = false;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(sub) = item {
                    if sub.text()? == "File" {
                        sub.insert(&new, 0)?;
                        sub.insert(&open, 1)?;
                        sub.insert(&PredefinedMenuItem::separator(app)?, 2)?;
                        placed = true;
                    }
                }
            }
            if !placed {
                // A platform whose default menu has no File menu: add our own.
                menu.append(&SubmenuBuilder::new(app, "File").item(&new).item(&open).build()?)?;
            }
            app.set_menu(menu)?;

            let status = MenuItem::with_id(app, "status", "Idle", false, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show Braid", true, None::<&str>)?;
            let tray_new = MenuItem::with_id(app, "tray-new-window", "New Window", true, None::<&str>)?;
            let pick = MenuItem::with_id(app, "tray-open-repo", "Open Repository...", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Braid", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[&status, &PredefinedMenuItem::separator(app)?, &show, &tray_new, &pick, &PredefinedMenuItem::separator(app)?, &quit],
            )?;
            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("braid - Idle")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_window(app),
                    "tray-new-window" => new_window(app.clone()),
                    "tray-open-repo" => switch_focused(app.clone()),
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
            #[cfg(target_os = "macos")]
            dock::install(app.handle().clone());

            // --repo arguments open dashboards directly; otherwise show the launcher, not an empty window.
            let handle = app.handle().clone();
            let repos = repos_from_args();
            if repos.is_empty() {
                show_launcher(&handle);
            } else {
                thread::spawn(move || {
                    for repo in repos {
                        if let Err(why) = open_repo(&handle, None, &repo) {
                            report_error(&handle, &format!("Could not watch {}", repo.display()), &why);
                        }
                    }
                    if handle.webview_windows().is_empty() {
                        show_launcher(&handle);
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // The last window hides to the tray so notifications keep coming; any other window really closes.
                if window.app_handle().webview_windows().len() <= 1 {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Destroyed => {
                // Its repository's server goes with it.
                let app = window.app_handle();
                if let Some(session) = app.state::<Sessions>().0.lock().unwrap().remove(window.label()) {
                    if let Some(child) = session.child {
                        let _ = child.kill();
                    }
                }
            }
            _ => {}
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new-window" => new_window(app.clone()),
            "open-repo" => switch_focused(app.clone()),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build braid desktop");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_window(app);
        }
        if let RunEvent::Exit = event {
            for (_, session) in app.state::<Sessions>().0.lock().unwrap().drain() {
                if let Some(child) = session.child {
                    let _ = child.kill();
                }
            }
        }
    });
}
