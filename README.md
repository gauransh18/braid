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
braid run plans/rate-limit.json --budget 5

# 3. Inspect and merge
braid status
git log --oneline main..braid/<runId>/integration
git merge braid/<runId>/integration
```

Press Ctrl-C to stop the agents. Work already merged stays on the integration branch.

To continue an interrupted or failed run, keep the merged work and retry the rest:

```bash
braid resume [runId] --budget 10   # defaults to the newest unfinished run
```

## Desktop app (macOS)

`npm run build:desktop` builds `Braid.app` and a `.dmg` (about 30 MB) with [Tauri](https://tauri.app). It opens a small
**launcher** window, not an empty dashboard: **Open Repository...**, **Watch a demo run** (mock agents, nothing spent) and
a list of recent repositories. Picking one opens a dashboard window for it, with the single-file braid executable
running in the background as that repository's server. **File > Open Repository...** (Cmd+O) switches the current window
to another repository, and **File > New Window** (Cmd+N) brings up the launcher again so you can watch several repositories
at once, each with its own window and server. Both are also in the Dock icon's right-click menu and the menu-bar icon's menu.
`Braid --repo PATH --repo PATH2` skips the launcher and opens one window per repository. Closing a window stops its server;
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
braid demo                                # scripted mock run, no agents, no spend
```

The dashboard opens at `http://127.0.0.1:4777`. It only listens on this machine and is read-only by default.

`braid watch --control` (and the desktop app) turns an empty repository into a guided start: describe a goal, and braid
drafts a plan you can review and edit (tasks, dependencies, the command every task must pass, pre-filled from your
`package.json`, `Cargo.toml`, `go.mod` or pytest config), set a spend cap, and start it. It also shows which agent CLIs are
installed. Later runs use the **New run** button (same steps), plus **Stop** and **Resume**. You can also load a saved plan
from `plans/`. One run is active at a time. These endpoints can
start agents, so they need a per-session token (from `BRAID_CONTROL_TOKEN`, or generated and printed as `#token=...`
after the URL; it never travels in argv or the request URL), they refuse requests from other origins, and a run started
this way must have a `budgetUsd`. Reading runs and transcripts does not need the token.
It shows:

- **The floor:** each agent is a pixel blob at a desk. Its mood follows its task: asleep while pending, typing while running, a magnifier while verifying, glasses while reviewing, jumping while merging, happy when done, flattened when failed, tied up when blocked. The lines between desks are dependencies.
- **The braid:** the integration branch drawn as a rope that gains a strand in the task's color on every verified merge.
- **Usage:** tokens (fresh, cached, output) and spend per task and per run. Dollars show as `~$` when they are estimated from tokens (Codex, Gemini) rather than reported.
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
| `budgetUsd` | plan | Hard spend cap for the run |
| `maxReplans` | plan | Times the planner may split or rewrite a task that failed for good (default 0, off) |
| `sandbox` | plan | Run setup, verify and optionally the agent in a Docker/Podman container. See [Sandbox](#sandbox) |
| `setup` | plan | Commands run in each fresh worktree, e.g. `npm ci` |
| `driver`, `model` | both | `claude` (default), `codex`, `gemini`, `mock` |
| `verify` | both | Commands that must exit 0 |
| `review` | both | Run a read-only reviewer on the diff |
| `maxAttempts` | both | Tries, including retries with feedback (default 2) |
| `allowedTools` | both | Agent tool allowlist (default: no Bash) |
| `maxTurns` | both | Agent turn cap |
| `id`, `title`, `prompt`, `deps` | task | The task itself |

Values set on a task override the plan-level values.

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
