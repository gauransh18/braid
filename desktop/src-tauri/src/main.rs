// Desktop window for braid. The window shows the dashboard served by the bundled `braid` executable,
// which runs in the background as `braid watch` inside the repository you pick.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{
    menu::{Menu, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Manager, RunEvent, Url,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

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
    let (mut rx, child) = app
        .shell()
        .sidecar("braid")
        .map_err(|e| e.to_string())?
        .args(["watch", "--port", &port.to_string()])
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
    save_repo(app, repo);
    let url = Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|e| e.to_string())?;
    let window = app.get_webview_window("main").ok_or("no window")?;
    window.navigate(url).map_err(|e| e.to_string())?;
    let name = repo.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let _ = window.set_title(&format!("braid - {name}"));
    Ok(())
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
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            let open = MenuItemBuilder::with_id("open-repo", "Open Repository...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let repo_menu = SubmenuBuilder::new(app, "Repository").item(&open).build()?;
            let menu = Menu::default(app.handle())?;
            menu.append(&repo_menu)?;
            app.set_menu(menu)?;

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
        .on_menu_event(|app, event| {
            if event.id() == "open-repo" {
                choose_repo(app.clone(), false);
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build braid desktop");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(child) = app.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
