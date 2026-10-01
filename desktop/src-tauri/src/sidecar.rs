// The `braid` process behind a dashboard window, and how to stop it. A run started from the dashboard lives in that
// process, and its agents, checks and containers are children that no longer die with it (each one leads a process
// group of its own, and a container outlives the client that started it). Killing the sidecar outright therefore
// leaks them, so it is asked to stop first: "quit" on stdin is the first Ctrl-C, and the OS closing the pipe when
// this app dies does the same.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::async_runtime::Receiver;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

/// How long a sidecar that was asked to quit gets before it is killed. Stopping a run is more than the few seconds the
/// agents need (SIGINT, SIGTERM after 2 s, SIGKILL after 5 s): a check that ignores SIGTERM takes the full 5 s, and the
/// integration worktree of a big project then takes its time to remove before the run is saved as aborted. The sidecar
/// gives all of that 15 s itself (`stopActiveRun(15_000)` in src/cli.ts) and exits on its own afterwards, so this must be
/// longer: a kill that lands earlier cuts the run off before it is saved. It is for a sidecar that is wedged.
pub const GRACE: Duration = Duration::from_secs(20);

/// The part of a child process that stopping needs. `CommandChild` is the real one; tests use a stand-in.
trait Handle {
    /// Say "quit" on its stdin. False when that could not be delivered (it is gone, or its pipe is broken).
    fn quit(&mut self) -> bool;
    fn kill(self);
}

impl Handle for CommandChild {
    fn quit(&mut self) -> bool {
        self.write(b"quit\n").is_ok()
    }

    fn kill(self) {
        let _ = CommandChild::kill(self);
    }
}

/// Ask `child` to quit, give it `grace` to end (`exited` says when it has), and kill it if it has not. Returns whether
/// it left by itself. One that never takes "quit", or has no way to be asked, is killed at once: there is nothing to
/// wait for.
fn wind_down(mut child: impl Handle, exited: &AtomicBool, takes_quit: bool, grace: Duration) -> bool {
    if exited.load(Ordering::SeqCst) {
        return true;
    }
    if takes_quit && child.quit() {
        let start = Instant::now();
        while start.elapsed() < grace && !exited.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(20));
        }
        if exited.load(Ordering::SeqCst) {
            return true;
        }
    }
    // Killing a process that has already been reaped does nothing.
    child.kill();
    false
}

pub struct Sidecar {
    child: CommandChild,
    /// Set once the process has ended and its output has been read.
    exited: Arc<AtomicBool>,
    /// The last lines it printed, so a failure to start can say why.
    output: Arc<Mutex<String>>,
    /// Understands "quit" on stdin (`braid watch` with BRAID_EXIT_ON_STDIN_CLOSE=1). The demo server does not, and
    /// has no run worth saving, so asking it would only add a wait.
    takes_quit: bool,
}

impl Sidecar {
    /// Take over a freshly spawned process: keep its output drained (a full pipe would stall it) and note when it ends.
    pub fn adopt(mut rx: Receiver<CommandEvent>, child: CommandChild, takes_quit: bool) -> Sidecar {
        let exited = Arc::new(AtomicBool::new(false));
        let output = Arc::new(Mutex::new(String::new()));
        let (done, sink) = (exited.clone(), output.clone());
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
            done.store(true, Ordering::SeqCst);
        });
        Sidecar { child, exited, output, takes_quit }
    }

    pub fn output(&self) -> String {
        self.output.lock().unwrap().trim().to_string()
    }

    /// Kill it now. For a server that never came up or never got a window, where there is nothing to wind down.
    pub fn kill(self) {
        Handle::kill(self.child);
    }

    /// Ask it to stop what it started and exit, and kill it if it has not within `grace`. Blocks. Returns whether it
    /// left by itself.
    pub fn stop_within(self, grace: Duration) -> bool {
        wind_down(self.child, &self.exited, self.takes_quit, grace)
    }

    /// `stop_within(GRACE)` without waiting for it, for a window that closes while the app carries on.
    pub fn stop(self) {
        thread::spawn(move || {
            self.stop_within(GRACE);
        });
    }
}

/// Stop several sidecars together and wait for all of them, so the app does not exit while a run is still being wound
/// down (the process that would finish the job is the one that is leaving).
pub fn stop_all(sidecars: Vec<Sidecar>) {
    let waits: Vec<_> = sidecars.into_iter().map(|s| thread::spawn(move || s.stop_within(GRACE))).collect();
    for wait in waits {
        let _ = wait.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records what it was asked, and can be made to leave when told "quit".
    struct Fake {
        log: Arc<Mutex<Vec<&'static str>>>,
        exited: Arc<AtomicBool>,
        hears: bool,
        leaves_after: Option<Duration>,
    }

    impl Handle for Fake {
        fn quit(&mut self) -> bool {
            self.log.lock().unwrap().push("quit");
            if let Some(after) = self.leaves_after {
                let exited = self.exited.clone();
                thread::spawn(move || {
                    thread::sleep(after);
                    exited.store(true, Ordering::SeqCst);
                });
            }
            self.hears
        }

        fn kill(self) {
            self.log.lock().unwrap().push("kill");
        }
    }

    fn fake(hears: bool, leaves_after: Option<Duration>) -> (Fake, Arc<Mutex<Vec<&'static str>>>, Arc<AtomicBool>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let exited = Arc::new(AtomicBool::new(false));
        (Fake { log: log.clone(), exited: exited.clone(), hears, leaves_after }, log, exited)
    }

    #[test]
    fn one_that_hears_quit_and_leaves_is_not_killed() {
        let (child, log, exited) = fake(true, Some(Duration::from_millis(100)));
        let started = Instant::now();
        assert!(wind_down(child, &exited, true, Duration::from_secs(5)));
        assert_eq!(*log.lock().unwrap(), ["quit"]);
        assert!(started.elapsed() < Duration::from_secs(3), "did not wait out the grace period");
    }

    #[test]
    fn one_that_does_not_leave_is_killed_after_the_grace_period() {
        let (child, log, exited) = fake(true, None);
        let started = Instant::now();
        assert!(!wind_down(child, &exited, true, Duration::from_millis(300)));
        assert_eq!(*log.lock().unwrap(), ["quit", "kill"]);
        assert!(started.elapsed() >= Duration::from_millis(300), "it got the grace period first");
    }

    #[test]
    fn one_that_cannot_be_asked_is_killed_at_once() {
        let (child, log, exited) = fake(false, None);
        let started = Instant::now();
        assert!(!wind_down(child, &exited, true, Duration::from_secs(5)));
        assert_eq!(*log.lock().unwrap(), ["quit", "kill"]);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn one_that_does_not_take_quit_is_killed_without_being_asked() {
        let (child, log, exited) = fake(true, None);
        let started = Instant::now();
        assert!(!wind_down(child, &exited, false, Duration::from_secs(5)));
        assert_eq!(*log.lock().unwrap(), ["kill"]);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn one_that_is_already_gone_is_left_alone() {
        let (child, log, exited) = fake(true, None);
        exited.store(true, Ordering::SeqCst);
        assert!(wind_down(child, &exited, true, Duration::from_secs(5)));
        assert!(log.lock().unwrap().is_empty());
    }
}
