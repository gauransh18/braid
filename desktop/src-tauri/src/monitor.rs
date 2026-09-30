//! Watches `.braid/runs/*/state.json` in the chosen repository and turns changes into notification text.
//! It reads the same files the dashboard does, so it needs no network and no token.

use std::{collections::HashMap, fs, path::Path};

use serde_json::Value;

/// What the last look at one run showed.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RunSnap {
    pub status: String,
    /// Failed task ids with the first line of their error.
    pub failed: HashMap<String, String>,
    pub done: usize,
    pub total: usize,
    pub blocked: usize,
    /// Still being driven by a live process. A "running" state left by a crash is not active.
    pub active: bool,
}

pub struct Note {
    pub title: String,
    pub body: String,
}

#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    // Signal 0 checks that the process exists without sending anything. EPERM means it exists but is not ours.
    let ok = unsafe { libc::kill(pid as i32, 0) } == 0;
    ok || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn pid_alive(_pid: u32) -> bool {
    true
}

pub fn parse_state(text: &str, alive: impl Fn(u32) -> bool) -> Option<RunSnap> {
    let v: Value = serde_json::from_str(text).ok()?;
    let status = v.get("status")?.as_str()?.to_string();
    let tasks = v.get("tasks").and_then(Value::as_object);
    let mut snap = RunSnap::default();
    for (id, t) in tasks.into_iter().flatten() {
        snap.total += 1;
        match t.get("status").and_then(Value::as_str).unwrap_or("") {
            // A replaced task was swapped for new ones, so it counts as handled, not failed.
            "done" | "replaced" => snap.done += 1,
            "blocked" => snap.blocked += 1,
            "failed" => {
                let err = t.get("error").and_then(Value::as_str).unwrap_or("");
                let first = err.lines().next().unwrap_or("").chars().take(110).collect();
                snap.failed.insert(id.clone(), first);
            }
            _ => {}
        }
    }
    snap.active = status == "running" && v.get("pid").and_then(Value::as_u64).map_or(true, |p| alive(p as u32));
    snap.status = status;
    Some(snap)
}

/// The newest runs in a repo (run ids sort by start time). Unreadable or half-written files are skipped.
pub fn read_runs(repo: &Path, keep: usize) -> HashMap<String, RunSnap> {
    let Ok(entries) = fs::read_dir(repo.join(".braid").join("runs")) else {
        return HashMap::new();
    };
    let mut ids: Vec<String> = entries.flatten().filter_map(|e| e.file_name().into_string().ok()).collect();
    ids.sort();
    ids.reverse();
    ids.truncate(keep);
    ids.into_iter()
        .filter_map(|id| {
            let text = fs::read_to_string(repo.join(".braid").join("runs").join(&id).join("state.json")).ok()?;
            parse_state(&text, pid_alive).map(|snap| (id, snap))
        })
        .collect()
}

pub fn active_count(runs: &HashMap<String, RunSnap>) -> usize {
    runs.values().filter(|r| r.active).count()
}

/// Notifications for what changed between two looks. Runs already finished at the first look never notify.
pub fn diff(repo_name: &str, prev: &HashMap<String, RunSnap>, next: &HashMap<String, RunSnap>) -> Vec<Note> {
    let mut notes = Vec::new();
    let mut ids: Vec<&String> = next.keys().collect();
    ids.sort();
    for id in ids {
        let now = &next[id];
        let before = prev.get(id);
        let was_running = before.map_or(true, |b| b.status == "running");
        let title = format!("braid - {repo_name}");

        if now.status == "running" {
            for (task, err) in &now.failed {
                if before.map_or(true, |b| !b.failed.contains_key(task)) {
                    let why = if err.is_empty() { String::new() } else { format!(": {err}") };
                    notes.push(Note { title: title.clone(), body: format!("Task {task} failed{why}") });
                }
            }
        } else if was_running && (before.is_some() || now.status != "running") {
            let body = match now.status.as_str() {
                "done" => format!("Run finished: {}/{} tasks merged", now.done, now.total),
                "aborted" => format!("Run stopped: {}/{} tasks merged", now.done, now.total),
                _ => format!("Run failed: {} failed, {} blocked, {}/{} merged", now.failed.len(), now.blocked, now.done, now.total),
            };
            notes.push(Note { title, body });
        }
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(status: &str, tasks: &[(&str, &str, &str)], pid: Option<u32>) -> String {
        let t: serde_json::Map<String, Value> = tasks
            .iter()
            .map(|(id, st, err)| ((*id).to_string(), serde_json::json!({"id": id, "status": st, "error": err})))
            .collect();
        serde_json::json!({"status": status, "pid": pid, "tasks": t}).to_string()
    }
    fn snap(text: &str) -> RunSnap {
        parse_state(text, |_| true).unwrap()
    }
    fn map(pairs: Vec<(&str, RunSnap)>) -> HashMap<String, RunSnap> {
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    #[test]
    fn parses_counts_and_failures() {
        let s = snap(&state("running", &[("a", "done", ""), ("b", "failed", "Verification failed.\nmore"), ("c", "blocked", ""), ("d", "replaced", "")], Some(1)));
        assert_eq!((s.total, s.done, s.blocked), (4, 2, 1));
        assert_eq!(s.failed.get("b").map(String::as_str), Some("Verification failed."));
        assert!(s.active);
    }

    #[test]
    fn a_running_state_with_a_dead_process_is_not_active() {
        let s = parse_state(&state("running", &[("a", "running", "")], Some(99)), |_| false).unwrap();
        assert!(!s.active);
        assert!(parse_state("not json", |_| true).is_none());
    }

    #[test]
    fn notifies_when_a_run_finishes_and_only_then() {
        let running = snap(&state("running", &[("a", "running", "")], Some(1)));
        let done = snap(&state("done", &[("a", "done", "")], Some(1)));
        let before = map(vec![("r1", running.clone())]);
        let notes = diff("repo", &before, &map(vec![("r1", done.clone())]));
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].body, "Run finished: 1/1 tasks merged");
        assert_eq!(notes[0].title, "braid - repo");
        // Still running, or already finished at the first look: silence.
        assert!(diff("repo", &before, &before).is_empty());
        assert!(diff("repo", &map(vec![("r1", done.clone())]), &map(vec![("r1", done)])).is_empty());
    }

    #[test]
    fn a_run_that_starts_and_ends_between_looks_still_notifies() {
        let failed = snap(&state("failed", &[("a", "failed", "Verification failed."), ("b", "blocked", "")], Some(1)));
        let notes = diff("repo", &HashMap::new(), &map(vec![("new", failed)]));
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].body, "Run failed: 1 failed, 1 blocked, 0/2 merged");
    }

    #[test]
    fn notifies_once_per_newly_failed_task_while_running() {
        let ok = snap(&state("running", &[("a", "running", "")], Some(1)));
        let bad = snap(&state("running", &[("a", "failed", "Reviewer requested changes")], Some(1)));
        let notes = diff("repo", &map(vec![("r", ok)]), &map(vec![("r", bad.clone())]));
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].body, "Task a failed: Reviewer requested changes");
        assert!(diff("repo", &map(vec![("r", bad.clone())]), &map(vec![("r", bad)])).is_empty(), "already reported");
    }

    #[test]
    fn counts_active_runs() {
        let live = snap(&state("running", &[], Some(1)));
        let done = snap(&state("done", &[], Some(1)));
        assert_eq!(active_count(&map(vec![("a", live), ("b", done)])), 1);
    }
}
