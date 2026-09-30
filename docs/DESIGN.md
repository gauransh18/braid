# braid design

braid runs a team of coding agents against one repository. A plan is a graph of tasks. Each task
runs in its own git worktree, and its output has to pass your checks before it is merged. The harness
never writes to your branches. Everything lands on `braid/<runId>/integration`, which you review
and merge yourself.

## Why not munder-difflin

We looked at [munder-difflin](https://github.com/chaitanyagiri/munder-difflin) (MIT, Electron,
about 88k lines). It has good ideas: a single process that commits, per-agent mailboxes, and hop caps
against agents replying to each other forever. Its core bet is different from ours:

| | munder-difflin | braid |
| --- | --- | --- |
| Agent control | Drives each CLI's interactive TUI through a PTY; hook bridges, keystroke injection and idle detection per CLI | Headless JSON modes (`claude -p --output-format stream-json`, `codex exec --json`); one parser per CLI |
| Orchestration | A "god" LLM agent routes work from a long system prompt | Deterministic scheduler in code; the LLM only plans and does task work |
| Done means | The agent says it is done | Verify commands pass on the task, an optional reviewer approves, and verify passes again after the merge |
| Isolation | Agents share working directories; auto mode passes `--dangerously-skip-permissions`-style flags | A git worktree per task, a tool allowlist, and no Bash by default |
| Cost | Reported | Hard budget cap; scheduling stops when it is spent |
| Shape | Desktop app | CLI and library first; a UI reads the same event log |

We borrowed ideas, not code.

## Architecture

```
plan.json ─► Orchestrator (code, deterministic)
               │  DAG scheduling · concurrency · budget · retries
               ▼
         per task:  worktree from latest integration HEAD
                    ├─ setup   (npm ci, ...)
                    ├─ worker  Driver.run(canEdit)        ── claude | codex | mock
                    ├─ commit
                    ├─ verify  (task worktree)            ── fail ─► retry with output as feedback
                    ├─ review  Driver.run(read-only)      ── reject ─► retry with issues as feedback
                    └─ merge   (serialized)               ── conflict ─► pull latest into task branch,
                         │                                               resolver agent fixes markers only
                         └─ verify again on the combined tree ── fail ─► roll back, pull latest, fix on top
```

- `src/orchestrator.ts`: the scheduler, the task lifecycle, and serialized merges followed by verification.
- `src/drivers/*`: the `Driver` interface plus the Claude, Codex, Gemini (both not yet tested against a live install) and mock drivers. Every CLI maps to one `AgentEvent` stream.
- `src/git.ts`: worktrees, commits, merges. It only ever writes to `braid/*` branches.
- `src/store.ts`: `.braid/runs/<id>/` holds `plan.json`, `state.json` (written atomically), `events.jsonl`, and `tasks/<id>/<role>-<n>.jsonl` with the full transcript of every agent turn.
- `src/watch.ts` + `ui/index.html`: a read-only dashboard with no dependencies. It listens on loopback only, rejects foreign `Host` headers, and polls the run files (fs.watch is unreliable on Windows). The mascot and agent sprites are original pixel art drawn in code, under MIT.
- `src/planner.ts`: a read-only agent that turns a goal into a checked plan. You edit the plan before running it.

## Invariants

1. The base branch and your working tree are never modified. `.braid/` goes into `.git/info/exclude`, not your `.gitignore`.
2. The integration branch only holds states that passed verification. A merge that breaks the combined tree is rolled back.
3. Merges are serialized, so only one process writes to the integration worktree at a time.
4. A dependent task starts from a tree that already contains its dependencies' merged work.
5. Every agent turn is logged in full, so a failure can be reproduced from the logs alone.

## Security model

Headless agents cannot ask for permission, so any tool not on the allowlist is denied. The default is
`Read, Edit, Write, Glob, Grep`: no Bash, no network tools. Verify and setup commands come from the
plan (your team's own config) and run in a shell. A worktree is **not** a sandbox. An agent that is
allowed Bash can reach anything your user can. Only grant `Bash(...)` patterns you trust, and use the
container `sandbox` (`agent: true`) for untrusted work. Without a sandbox, verify and setup commands also run on the host, and they execute code the agents wrote.

## Team usage (now)

- Commit plans to the repo (for example `plans/*.json`) so the team shares task graphs and verify commands.
- Each person runs `braid` locally with their own CLI subscription.
- Agents are isolated from personal setup: the Claude driver passes `--setting-sources project,local --strict-mcp-config`, so personal plugins, hooks, output styles and MCP servers never leak into a run. Only the repo's own `.claude/` settings and `CLAUDE.md` apply, so the same plan behaves the same on every machine.
- The integration branch is an ordinary branch: push it and open a PR as usual.

## Roadmap

1. ~~**Cheaper conflict handling.**~~ Shipped. On a merge conflict braid merges the newer integration work into the task branch, and a narrow resolver agent removes the markers while keeping both sides' changes. The task is not redone. Nothing is committed while markers remain. A combined-tree verify failure is fixed on top of the existing work the same way. In the real smoke run the resolver cost $0.09, versus about $0.21 for a full redo.
2. ~~**Resume.**~~ Shipped as `braid resume [runId]`. Merged tasks stay done, every other task is retried with fresh attempts, and spend carries over so the budget covers the whole run. The integration branch is rewound to `verifiedHead` (the head after the last verified merge), which drops any half-done merge from a crash. A run whose process is still alive is refused.
3. ~~**Watch UI.**~~ Shipped as `braid watch`, `braid run --watch` and `braid demo`: a local read-only page (`ui/index.html`, `src/watch.ts`) that tails the run files over SSE.
4. ~~**Container sandbox.**~~ Shipped, opt-in: a `sandbox` section in the plan (or `braid run --sandbox IMAGE`), Docker or Podman (`src/sandbox.ts`). Setup and verify commands run in a throwaway container with only the task worktree mounted at `/work`, all capabilities dropped, no privilege escalation, your uid, and no network for verify (setup keeps it). With `agent: true` the agent CLI runs in the container too, which is what makes `Bash(...)` in `allowedTools` safe: it can only touch the worktree, not your other branches, your `.git` or your home directory. Secrets are passed by variable name (`env`), never by value. Checked against real Docker for setup and verify (isolation, no network, file ownership, an image with its own `ENTRYPOINT`); running the agent inside a container is covered only by a fake runtime, since it needs an image with the agent CLI installed (see `examples/sandbox/Dockerfile`). Not done: Windows path mapping, Podman rootless quirks, and cleanup of containers if braid is killed with SIGKILL.
5. **Shared team server.** A daemon that queues runs, gives a shared dashboard, holds team memory (lessons learned per repo, fed back into worker prompts) and posts to Slack.
6. **Evals.** A fixed benchmark of real tasks tracking pass rate, cost and wall time per driver and model. A first version (`braid eval`, hidden acceptance tests per case) was built and removed; the token and cost display covers what we need to show users for now.
7. **More drivers.** Gemini CLI is in (`src/drivers/gemini.ts`, `driver: "gemini"`), written against the event schema in the gemini-cli 0.53 source but not yet run against a signed-in install. Workers run in `auto_edit` and reviewers in `plan`, so `allowedTools` and `maxTurns` do not apply, and spend is estimated from token counts and list prices. NVIDIA NIM is in (`src/drivers/openai-compat.ts`, `driver: "nim"`, key in `NVIDIA_API_KEY`, endpoint override `BRAID_NIM_BASE_URL`): NIM is a hosted API with no agent program, so braid runs the tool loop itself against the OpenAI-compatible chat completions endpoint. Tools follow `allowedTools` (Read/Glob/Grep, Edit/Write, `Bash(...)`), reviewers and planners get read tools only, every path is confined to the worktree (symlinks and `.git` included), commands run in the sandbox container when the plan has one, and 429/5xx are retried. Checked against a stand-in API (tool loop, confinement, edit rules, permissions, retries, error messages) and end to end through the desktop app's server with a dummy key and stand-in API; NOT yet against the real NVIDIA API, so which NIM models handle tool calling well is untested. Dollars are not tracked for NIM unless prices are added to `BRAID_PRICES`; tokens always are. The same class serves any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio), which is the remaining item along with OpenCode.
8. ~~**Replanning.**~~ Shipped, opt-in: `maxReplans` in the plan or `braid run --replan N`. When a task fails for good, a read-only planner agent looks at the failed attempt and the failure reasons, then either splits the task, rewrites it, or gives up. Code validates the proposal (new unique ids, deps only on merged tasks or each other, no cycles, at most 6 tasks); replacements inherit the failed task's driver, checks and limits, and whatever waited on it now waits on the replacements. The task ends as `replaced` and counts as complete. A bad proposal or a spent replan budget leaves it failed as before. While the planner thinks the task is `replanning`, so dependents are not blocked early. Replacement tasks that fail can be replanned again until `maxReplans` is used up.
9. **Standalone installers for Windows and macOS.** Two steps:
   - **Single-file CLI (done, except distribution).** `npm run build:binary` uses `bun build --compile` with the dashboard page embedded (`globalThis.__BRAID_UI`, set by `build/entry.mjs`); `braid doctor` checks git, the agent CLIs and Docker and prints install hints. Checked on macOS arm64 by running the copied binary outside the repo (help, doctor, dashboard, demo run). A release workflow builds all four targets on tag push but has never run. Not done: Homebrew tap, winget, signing. Original plan: compile braid, with `ui/index.html` embedded, into one executable per platform using `bun build --compile` or Node SEA: `braid.exe` for Windows, and `braid` for macOS on both arm64 and x64. Ship through GitHub Releases, a Homebrew tap and winget. `git` and the agent CLIs stay user-installed, since they are vendor-owned and each user signs in with their own subscription. On first run, braid checks what is missing and shows how to install it.
   - **Desktop app (Tauri), first cut done on macOS.** `desktop/` holds a Tauri v2 app (`src-tauri/src/main.rs`): it starts the bundled `braid watch` as a sidecar on a free loopback port in a repo you choose (remembered in the app config dir), navigates the window to it, and kills it on exit. Built and launched on macOS arm64: the window shows the live dashboard, the sidecar runs and stops with the app. Tray icon and notifications are in (`desktop/src-tauri/src/monitor.rs`, with unit tests run by `cargo test` in `desktop/src-tauri`): a poller reads `.braid/runs/*/state.json` every 2 seconds, so it needs no network or token, and closing the window hides it to the tray. Runs whose state says running but whose process is dead are not counted as active. Verified on macOS: the tray icon appears, closing the window keeps the app and server alive, and the unit tests cover the notification rules; the notification banner itself was not seen because macOS was waiting on the first-run permission prompt. Model lists are live, not hard-coded: `src/models.ts` reads each provider's own model endpoint (Anthropic, OpenAI, Google, NVIDIA; chat models only, embedding and reranking models dropped) with the saved key, via `braid models <provider> --json` run by the desktop app with the key in the environment. The app refreshes every provider that has a key at each launch, caches the result (`models.json` in the app config dir) so Settings opens instantly, and keeps showing the last good list, marked stale, if a refresh fails. `braid test-provider` backs the Test button (a model that does not answer the one tiny request within 90 s is reported as slow, not as unreachable, since the key and the model listing already passed; a slow but correct answer passes with a note): key saved, API reachable and the key accepted, chosen model exists, and for NIM one tiny request that checks tool calling. Without a key a CLI provider has no API to ask and none of the three CLIs has a list command, so `scanInstalledCli` reads the model names out of the installed program itself (Claude Code and Codex binaries, the Gemini CLI's bundle files), keeping only clean names (dated, image, live and base variants are dropped) and sorting newest first; it follows the CLI when it updates, and a retired name can still appear, so the UI says so. The Claude aliases never go stale. Verified on the real installs (Claude 16, Codex 12, Gemini 13 names, all current) and in tests, including a name straddling a read boundary. For CLI providers with no key, Test connection checks the program is found and says plainly that sign-in cannot be tested from here. Checked against stand-in providers in tests and in the real app with a fake key in the Keychain and a stand-in NVIDIA API (launch refresh, dropdown, all three test steps). Not checked against the real providers. The agent chips on the guided start are switches (`POST /api/agents/:name`): the dashboard's server applies the change to itself and read-modify-writes the desktop app's settings file (`BRAID_SETTINGS_FILE`, only the `disabled` and `default_agent` fields), and the app's monitor loop notices the file change and pushes the new defaults to every other window's server; the Settings window re-reads the file when it gains focus. Switching off the default agent clears the default. Verified with two windows of the real app: a change in one showed up in the other within a few seconds. Providers can be switched off in Settings: the list is pushed as `defaults.disabled`, defaults skip a switched-off agent, and a plan that names one (on the plan or on a task) is refused before anything starts. Settings: `settings.rs` and `desktop/ui/settings.html`. Default agent and per-agent models are a JSON file in the app config dir; API keys live only in the OS keychain (`keyring`) and are read once into a cache (each read can prompt). Both are pushed to every open dashboard's `braid watch` over its token-guarded loopback API (`POST /api/settings`, allowlisted to ANTHROPIC_API_KEY, OPENAI_API_KEY and GEMINI_API_KEY), which sets them in that dedicated process's environment, remembers the originals so removing a key restores the shell's value, and fills in the agent and model for plans that name none (`withDefaults` in `runs.ts`). The window never receives a key value. Because GUI apps get a stripped PATH, the app asks the user's login shell for theirs once and hands it to every server it starts, otherwise installed agent CLIs look missing. Verified: Settings opens from the app menu, agents are detected with versions, the default agent is saved and reaches a running server, keychain round trip with a dummy value. Not verified: saving a real key and running with it. Launcher: the app starts with a small launcher window (`desktop/ui/index.html`; open a repository, watch a demo, recent repositories kept in `recent.json` in the app config dir) instead of an empty dashboard, and a dashboard window is only created once its server answers, so no empty window ever shows. The launcher page talks to the native side through three commands (`recent_repos`, `launcher_choose`, `launcher_open`, `launcher_demo`); no capability grants the dashboard's own URL any of them. Multiple windows: each window has its own repository and `braid watch` process (sessions keyed by window label); closing a window ends its server, and the last window hides to the tray. New Window and Open Repository are in the File menu, the tray menu and, on macOS, the Dock menu (`dock.rs` adds `applicationDockMenu:` to the app delegate at runtime, since Tauri has no API for it). Checked on macOS by reading the File and Dock menus through accessibility and creating a window from the File menu. Not done: Windows and Linux builds, signing and notarization, clicking a notification to open the window, auto-update. Original plan: A native window around the same dashboard, with the single-file CLI bundled as a background process. Installers should be about 10-15 MB (`.msi`/`.exe`, `.dmg`), versus 100 MB or more for Electron, which munder-difflin uses. Adds a tray icon, notifications ("run done", "task failed"), a plan editor, starting runs from the UI, and Tauri's auto-updater. The watch server becomes the local API the app talks to. **Write endpoints done** (`src/runs.ts`, `handleControl` in `src/watch.ts`): `POST /api/runs`, `/api/run/:id/stop`, `/api/run/:id/resume`, `/api/plan-draft`, `GET /api/plans[/:name]`, all behind a per-session bearer token compared in constant time, an Origin check and JSON-only bodies; one active run; a spend cap is mandatory. The desktop shell generates the token, passes it to the sidecar by environment variable and to the page in the URL fragment, which the page strips. Exercised in a browser with mock plans (start, finish, fail, resume) and against the desktop app's sidecar (401 without the token, token absent from `ps`). Guided start: the empty screen is a composer (goal, check command, draft, review the tasks, spend cap, start) shared with the New run dialog; the server suggests a check command from the repo (`detectVerify`) and reports which agent CLIs exist (`/api/doctor`). Checked in a browser with a stand-in planner: draft, review, start, run to completion. Not done: editing saved plans on disk, more than one concurrent run.
   - **Signing.** macOS needs an Apple Developer ID ($99/yr) and notarization, or Gatekeeper blocks the app. Windows needs a code-signing certificate (for example Azure Trusted Signing, about $10/mo), or SmartScreen shows an "unknown publisher" warning. Both are needed before selling.
   - **Rules until then:** no native npm modules, bundle the fonts locally instead of loading Google Fonts, and keep the core usable as a library.

## Tokens and cost

Every agent call reports tokens, and braid shows them beside dollars in `braid run`, `braid status`,
`braid runs` and the dashboard (per task and per run). Tokens are always what the CLI reported, split
into fresh input (cache writes included), cached input and output. Dollars are exact for Claude, which
reports them, and a list-price estimate for Codex and Gemini: the run is flagged `costEstimated`, and
the CLI and dashboard prefix those figures with `~`. If the tokens look wrong, that is the number to trust
over the dollars. Claude's cache-heavy usage means a trivial prompt can show tens of thousands of tokens, mostly cached.

## Cost estimates

Claude reports dollars. Codex and Gemini report only tokens, so `src/pricing.ts` turns tokens into an
estimated cost (fresh input, cached input and output priced separately) and `budgetUsd` use that figure. It is a list-price estimate: rates drift, an unknown model falls back to the driver's
default (`gemini-2.5-pro`, `gpt-5-codex`), and subscription plans are not billed per token at all.
Set `BRAID_PRICES` to a JSON file to correct or add prices:

```json
{ "gemini-2.5-pro": { "input": 1.25, "output": 10, "cachedInput": 0.125 } }
```

The Codex usage fields (`turn.completed.usage`) follow its docs and, like the driver, are untested against a live install.
