# braid

A multi-agent coding harness for small teams. It breaks a goal into a graph of tasks, runs each task
with a coding agent (Claude Code, Codex) in its own git worktree, and checks the result before
merging it. The checks are your tests, an optional reviewer agent, and your tests again on the
merged tree.

Your branches are never touched. Work lands on `braid/<runId>/integration`.

## Install

```bash
npm install
npm run build
npm link   # puts `braid` on PATH
```

You need Node 22 or later, git, and at least one agent CLI signed in (`claude`, optionally `codex` or `gemini`).
Run `braid doctor` to see what is missing and how to install it.

### Windows

**The app (recommended):** download `Braid_<version>_x64-setup.exe` from the [releases](https://github.com/gauransh18/braid/releases)
and run it. It installs for your user (no administrator needed) and works like the Mac app: a small launcher (open a
repository, recent repositories, a demo), a dashboard window per repository, a notification-area icon, and Settings for
agents, models and API keys (keys are kept in Windows Credential Manager). It needs [git for Windows](https://git-scm.com/download/win)
and at least one agent (Claude Code, Codex or Gemini CLI) or an NVIDIA API key. It is not code-signed yet, so SmartScreen may
say "Windows protected your PC": choose **More info**, then **Run anyway**. It needs the Microsoft WebView2 runtime, which Windows 11 has
and the installer fetches on Windows 10.

**The command line:** `braid-windows-x64.exe` is a command-line program: double-clicking it only explains that. Open PowerShell
or Windows Terminal in your project folder and run it there, for example `.\braid-windows-x64.exe doctor`; rename it to
`braid.exe` and put it on your PATH to run it as plain `braid`. It runs on CPUs without AVX2, and on Windows on ARM through
emulation. Every release is tested on real Windows machines (x64 and ARM) before it is published: the program end to end, and
the app by installing it and launching it.

### Single-file executable

No Node needed. `npm run build:binary` compiles braid, dashboard included, into one file with
[Bun](https://bun.sh): `dist/bin/braid-<platform>` (about 58 MB on macOS arm64). Add `-- --all` to also build macOS x64,
Windows x64 and Linux x64 (Bun downloads each runtime). Pushing a `v*` tag builds all of them on GitHub and attaches
them to a release, with a `SHA256SUMS` file (`.github/workflows/release.yml`). git and the agent CLIs stay separate installs.

## Use

```bash
# 1. Draft a plan from a goal (read-only agent), then edit it
braid plan "add rate limiting to the API" --verify "npm test" --out plans/rate-limit.json

# 2. Run it
braid run plans/rate-limit.json

# 3. Inspect and merge
braid status
git log --oneline main..braid/<runId>/integration
git merge braid/<runId>/integration
```

Press Ctrl-C to stop the agents. Work already merged stays on the integration branch.

To continue an interrupted or failed run, keep the merged work and retry the rest:

```bash
braid resume [runId]   # defaults to the newest unfinished run
```

## Desktop app (macOS and Windows)

`npm run build:desktop` builds the app with [Tauri](https://tauri.app): `Braid.app` and a `.dmg` (about 30 MB) on a Mac, an installer (`Braid_<version>_x64-setup.exe`) on Windows. Everything below applies to both unless it says otherwise. It opens a small
**launcher** window, not an empty dashboard: **Open Repository...**, **Watch a demo run** (mock agents, nothing spent) and
a list of recent repositories. Picking one opens a dashboard window for it, with the single-file braid executable
running in the background as that repository's server. **File > Open Repository...** (Cmd+O) switches the current window
to another repository, and **File > New Window** (Cmd+N) brings up the launcher again so you can watch several repositories
at once, each with its own window and server. Both are also in the Dock icon's right-click menu and the menu-bar icon's menu.
**Braid > Settings...** (Cmd+,; on Windows: File > Settings) manages the agents: which of Claude Code, Codex and Gemini CLI are installed, plus **NVIDIA NIM** (a hosted API: add an `nvapi-` key and pick a model; braid runs the agent loop itself) (with install commands for the ones that are not), which is the default, which model each uses (type any name, or pick from a current list, which Braid refreshes every time it starts and on **Refresh list**: the provider's own live list when you saved a key, otherwise the model names read from the installed Claude Code, Codex or Gemini CLI itself (they follow the CLI when you update it); the Claude aliases `opus`, `sonnet` and `haiku` always mean the newest), and optional provider API keys. Keys go in the macOS Keychain (Windows Credential Manager on Windows), never in a file, and the window can only show that one is set. They are passed to agents only through the environment of the running server. Leave a key empty to use the CLI's own sign-in. Each agent has an **Enabled** switch: a switched-off agent is never used as the default, and a plan that asks for it is refused with a clear message. Each provider card has a **Test connection** button (key, reachability, the chosen model and, for NIM, tool calling). Changes apply to new runs in every window at once. `Braid --repo PATH --repo PATH2` skips the launcher and opens one window per repository. Closing a window stops its server;
the last window hides to the menu bar, whose icon shows how many runs are active (**Quit Braid** really quits). macOS
notifications announce a finished, failed or stopped run and each task that fails, but only while no window is focused (the
first launch asks for notification permission). Needs Rust, Bun and the Tauri CLI
(`cargo install tauri-cli --version "^2" --locked`). Output is in `desktop/src-tauri/target/release/bundle/`. The app is
unsigned, so macOS will warn on other people's machines. Starting runs works from the window (**New run**); you can also
start them with `braid run` and the window shows them live.

## Watch it live

```bash
braid run plans/rate-limit.json --watch   # run + dashboard
braid watch                               # dashboard for this repo's runs (any terminal)
braid demo                                # scripted mock run, no agents
```

The dashboard opens at `http://127.0.0.1:4777`. It only listens on this machine and is read-only by default.

`braid watch --control` (and the desktop app) turns an empty repository into a guided start: describe a goal, and braid
drafts a plan you can review and edit (tasks, dependencies, the command every task must pass, pre-filled from your
`package.json`, `Cargo.toml`, `go.mod` or pytest config), and start it. It also shows which agents are available as clickable chips: click one to switch that agent off or on (saved in Settings, and applied in every open window). Later runs use the **New run** button (same steps), plus **Stop** and **Resume**. You can also load a saved plan
from `plans/`. One run is active at a time. These endpoints can
start agents, so they need a per-session token (from `BRAID_CONTROL_TOKEN`, or generated and printed as `#token=...`
after the URL; it never travels in argv or the request URL), they refuse requests from other origins, and a run started
Reading runs and transcripts does not need the token.
It shows:

- **The floor:** each agent is a pixel blob that **knits a strand of wool** in its task's colour, and its mood shows what it is doing: a ball of wool waiting beside it, needles clicking over a growing swatch while it works, a magnifier while its stitches are checked (your tests), glasses while a reviewer looks, jumping while it ties the strand into the braid, a fringed swatch when done, tangled wool when failed, wrapped in its own wool when blocked. Under each name a plain sentence says what it is doing or what it is waiting for, columns are numbered steps, and dependencies are strands of wool that thin out until the first agent finishes, turn solid when it has, and twist through while the next agent works.
- **The braid:** the integration branch drawn as a rope that gains a strand in the task's color on every verified merge.
- **Usage:** token counts (fresh, cached, output) per task and per run. braid shows no dollar amounts.
- **Activity:** every harness event (verify results, review verdicts, conflicts, rollbacks).
- **Inspector:** click a desk to see the task prompt, its checks and the live agent transcript for each attempt.
- **Knot:** the mascot, which narrates what the run is doing.

## Plan format

See [examples/plan.json](examples/plan.json). The fields are:

| Field | Level | Meaning |
| --- | --- | --- |
| `goal` | plan | Shared context given to every agent |
| `base` | plan | Branch to start from (default: current) |
| `concurrency` | plan | Maximum tasks running at once (default 3) |
| `budgetUsd` | plan | Optional, advanced: stop scheduling once this much has been spent. Nothing in the app or CLI asks for it or shows cost |
| `budgetTokens` | plan | Stop starting tasks once the run has used this many fresh input and output tokens (cached input is not counted). Default 3 million per task; `0` means no limit. Counts from each `braid run` or `braid resume`, so a resumed run gets a fresh allowance. Also `--budget-tokens N` |
| `timeoutMin` | both | Minutes one agent call may run before it is stopped and the attempt retried. Default 30; `0` means no limit. Also `--timeout MIN` |
| `maxReplans` | plan | Times the planner may split or rewrite a task that failed for good (default 0, off) |
| `sandbox` | plan | Run setup, verify and optionally the agent in a Docker/Podman container. See [Sandbox](#sandbox) |
| `setup` | plan | Commands run in each fresh worktree, e.g. `npm ci` |
| `driver`, `model` | both | `claude` (default), `codex`, `gemini`, `nim` (NVIDIA NIM, needs `NVIDIA_API_KEY`), `mock` |
| `verify` | both | Commands that must exit 0 |
| `review` | both | Run a read-only reviewer on the diff |
| `maxAttempts` | both | Tries, including retries with feedback (default 2) |
| `allowedTools` | both | Agent tool allowlist (default: no Bash) |
| `maxTurns` | both | Agent turn cap |
| `id`, `title`, `prompt`, `deps` | task | The task itself |

Values set on a task override the plan-level values.

## Stopping and limits

- **Stop.** Ctrl-C, or **Stop** in the dashboard, stops the agents and any setup or verify command that is running, together with everything they started. Merged work stays; `braid resume` continues. A second Ctrl-C quits at once.
- **Stuck commands.** A setup or verify command that runs longer than 10 minutes is killed with its children and reported as timed out. A sandbox container is removed by name, so a killed run leaves none behind.
- **Provider trouble is not the task's fault.** When an agent call fails because of a rate limit, an overloaded API or a dropped connection, braid waits (20, 40, 80, then 160 seconds) and tries the call again without using up one of the task's attempts or telling the agent its work was rejected. If it keeps failing, the task fails as `agent unavailable`. If the account is out of usage or credit, no new task starts and `braid resume` carries on once it is back.
- **Safety limits.** Every run has them even if the plan sets none: an agent call is stopped after 30 minutes (`timeoutMin`), and the run stops starting tasks after 3 million fresh and output tokens per task (`budgetTokens`). They stop a runaway, not a big task; raise or switch them off in the plan.

## Sandbox

A worktree is not a sandbox: verify and setup commands run on your machine, and an agent that is allowed
`Bash` can reach anything you can. Add a `sandbox` to the plan to run them in a container instead
(needs Docker or Podman running):

```json
"sandbox": { "image": "node:22", "agent": true, "env": ["CLAUDE_CODE_OAUTH_TOKEN"], "memory": "4g" }
```

- **Setup and verify** run in a throwaway container. Only that task's worktree is mounted, at `/work`. All capabilities are dropped and it runs as you. Verify has no network unless `"network": true`; setup keeps it so `npm ci` works.
- **`agent: true`** runs the agent CLI in the container too, so allowing `Bash(...)` is safe: it cannot see your other branches, your `.git` or your home directory. The image must contain the CLI, see [examples/sandbox](examples/sandbox). `env` lists variable names to pass in; braid never reads their values.
- `braid run plan.json --sandbox node:22` sets just the image. Set `BRAID_CONTAINER_RUNTIME` to pick `podman` or another binary.
- Inside the container the worktree's `.git` is not available, so commands that call git will fail.

## Where things live

`.braid/runs/<runId>/` holds the plan, state, event log and every agent transcript.
Worktrees live under `.braid/worktrees/`, and the worktrees of failed tasks are kept for inspection.

Design and roadmap: [docs/DESIGN.md](docs/DESIGN.md).

## Develop

```bash
npm test   # builds, then runs unit and end-to-end scheduler tests with a mock driver
```
