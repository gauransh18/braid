//! Which agent runs by default, which model each agent uses, and provider API keys.
//!
//! Keys live in the OS keychain (macOS Keychain, Windows Credential Manager) and nowhere else on disk. The
//! Settings window can only learn whether a key is set, never its value. Non-secret choices are a small JSON
//! file in the app config dir. Both are pushed to each running `braid watch` process over its token-guarded
//! loopback API, so new runs pick them up without restarting anything.

use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Agent name, the environment variable its CLI reads its key from.
pub const AGENTS: [(&str, &str); 3] = [("claude", "ANTHROPIC_API_KEY"), ("codex", "OPENAI_API_KEY"), ("gemini", "GEMINI_API_KEY")];

const SERVICE: &str = "braid";

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Settings {
    #[serde(default)]
    pub default_agent: Option<String>,
    /// Model per agent name; a missing or empty entry means the CLI's own default.
    #[serde(default)]
    pub models: HashMap<String, String>,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    file(app).and_then(|f| fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = file(app).ok_or("no config directory")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// The environment variable for an agent, or an error for an unknown agent (so callers cannot store arbitrary names).
pub fn env_name(agent: &str) -> Result<&'static str, String> {
    AGENTS.iter().find(|(a, _)| *a == agent).map(|(_, e)| *e).ok_or_else(|| format!("unknown agent {agent}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod keychain {
    use super::SERVICE;

    fn entry(name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
    }
    pub fn get(name: &str) -> Option<String> {
        entry(name).ok()?.get_password().ok()
    }
    pub fn set(name: &str, value: &str) -> Result<(), String> {
        entry(name)?.set_password(value).map_err(|e| e.to_string())
    }
    pub fn clear(name: &str) -> Result<(), String> {
        match entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod keychain {
    pub fn get(_: &str) -> Option<String> {
        None
    }
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err("storing API keys is not supported on this platform yet; set the variable in your shell instead".into())
    }
    pub fn clear(_: &str) -> Result<(), String> {
        Ok(())
    }
}

pub fn key_set(agent: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("the key is empty".into());
    }
    keychain::set(env_name(agent)?, value.trim())
}

pub fn key_clear(agent: &str) -> Result<(), String> {
    keychain::clear(env_name(agent)?)
}

/// What the rest of the app needs to know, gathered with one keychain read per agent (each read can prompt).
#[derive(Clone)]
pub struct Snapshot {
    /// The body `POST /api/settings` on a `braid watch` process expects. Contains the key values: never send it to a window.
    pub payload: Value,
    /// Whether each agent has a key stored. Safe to show.
    pub key_set: HashMap<String, bool>,
}

pub fn snapshot(settings: &Settings) -> Snapshot {
    let mut env = serde_json::Map::new();
    let mut key_set = HashMap::new();
    for (agent, name) in AGENTS {
        let value = keychain::get(name);
        key_set.insert(agent.to_string(), value.is_some());
        env.insert(name.to_string(), value.map_or(Value::Null, Value::String));
    }
    Snapshot { payload: json!({ "env": env, "defaults": { "driver": settings.default_agent, "models": settings.models } }), key_set }
}

/// Push settings to a running `braid watch` (loopback only, bearer token). Plain HTTP by hand: one small request.
pub fn push(port: u16, token: &str, body: &Value) -> Result<(), String> {
    let text = body.to_string();
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    // One write, so the request arrives in one piece.
    let request = format!(
        "POST /api/settings HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    let status_ok = response.lines().next().is_some_and(|l| l.contains(" 200 "));
    if status_ok { Ok(()) } else { Err(response.lines().next().unwrap_or("no response").to_string()) }
}

/// GUI apps start with a minimal PATH, so `claude`, `codex` and `gemini` would look missing. Ask the user's own
/// login shell what their PATH is, once, and fall back to the usual install locations.
#[cfg(unix)]
pub fn user_path() -> String {
    use std::process::{Command, Stdio};
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let from_shell = Command::new(&shell)
        .args(["-ilc", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|p| !p.is_empty());
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = from_shell.unwrap_or_default().split(':').filter(|p| !p.is_empty()).map(String::from).collect();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", &format!("{home}/.local/bin"), &format!("{home}/.bun/bin"), &format!("{home}/.cargo/bin")] {
        if !parts.iter().any(|p| p == extra) {
            parts.push(extra.to_string());
        }
    }
    for base in std::env::var("PATH").unwrap_or_default().split(':') {
        if !base.is_empty() && !parts.iter().any(|p| p == base) {
            parts.push(base.to_string());
        }
    }
    parts.join(":")
}

#[cfg(not(unix))]
pub fn user_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_agents_map_to_key_variables() {
        assert_eq!(env_name("claude"), Ok("ANTHROPIC_API_KEY"));
        assert_eq!(env_name("codex"), Ok("OPENAI_API_KEY"));
        assert!(env_name("PATH").is_err());
        assert!(key_set("nope", "x").is_err());
        assert!(key_set("claude", "   ").is_err());
    }

    #[test]
    fn settings_round_trip_and_tolerate_missing_fields() {
        let s: Settings = serde_json::from_str(r#"{"default_agent":"codex","models":{"codex":"gpt-5-codex"}}"#).unwrap();
        assert_eq!(s.default_agent.as_deref(), Some("codex"));
        assert_eq!(s.models.get("codex").map(String::as_str), Some("gpt-5-codex"));
        assert_eq!(serde_json::from_str::<Settings>("{}").unwrap(), Settings::default());
    }

    #[test]
    fn push_speaks_http_to_a_local_server_and_reports_failure() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for status in ["200 OK", "401 Unauthorized"] {
                let (mut conn, _) = listener.accept().unwrap();
                let mut buf = [0u8; 2048];
                let n = conn.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                assert!(req.starts_with("POST /api/settings HTTP/1.1"));
                assert!(req.contains("Authorization: Bearer sekrit"));
                assert!(req.contains("\"driver\":\"claude\""));
                write!(conn, "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            }
        });
        let body = json!({ "defaults": { "driver": "claude" } });
        assert!(push(port, "sekrit", &body).is_ok());
        assert!(push(port, "sekrit", &body).unwrap_err().contains("401"));
        server.join().unwrap();
        assert!(push(1, "x", &body).is_err(), "nothing listening");
    }

    /// Run by hand (`cargo test -- --ignored keychain`): it writes a dummy entry to the real keychain and removes it.
    #[test]
    #[ignore = "touches the real keychain"]
    fn keychain_round_trip() {
        let name = "BRAID_TEST_DUMMY_KEY";
        keychain::clear(name).unwrap();
        assert_eq!(keychain::get(name), None);
        keychain::set(name, "dummy-not-a-real-key").unwrap();
        assert_eq!(keychain::get(name).as_deref(), Some("dummy-not-a-real-key"));
        keychain::clear(name).unwrap();
        assert_eq!(keychain::get(name), None, "removed");
    }
}
