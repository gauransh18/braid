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
allowed Bash can reach anything your user can. Only grant `Bash(...)` patterns you trust, and use
containers (see the roadmap) for untrusted work.

## Team usage (now)

- Commit plans to the repo (for example `plans/*.json`) so the team shares task graphs and verify commands.
- Each person runs `braid` locally with their own CLI subscription.
- Agents are isolated from personal setup: the Claude driver passes `--setting-sources project,local --strict-mcp-config`, so personal plugins, hooks, output styles and MCP servers never leak into a run. Only the repo's own `.claude/` settings and `CLAUDE.md` apply, so the same plan behaves the same on every machine.
- The integration branch is an ordinary branch: push it and open a PR as usual.

## Roadmap

1. ~~**Cheaper conflict handling.**~~ Shipped. On a merge conflict braid merges the newer integration work into the task branch, and a narrow resolver agent removes the markers while keeping both sides' changes. The task is not redone. Nothing is committed while markers remain. A combined-tree verify failure is fixed on top of the existing work the same way. In the real smoke run the resolver cost $0.09, versus about $0.21 for a full redo.
2. ~~**Resume.**~~ Shipped as `braid resume [runId]`. Merged tasks stay done, every other task is retried with fresh attempts, and spend carries over so the budget covers the whole run. The integration branch is rewound to `verifiedHead` (the head after the last verified merge), which drops any half-done merge from a crash. A run whose process is still alive is refused.
3. ~~**Watch UI.**~~ Shipped as `braid watch`, `braid run --watch` and `braid demo`: a local read-only page (`ui/index.html`, `src/watch.ts`) that tails the run files over SSE.
4. **Container sandbox.** An optional per-task container (Docker or Podman) so Bash can be allowed safely.
5. **Shared team server.** A daemon that queues runs, gives a shared dashboard, holds team memory (lessons learned per repo, fed back into worker prompts) and posts to Slack.
6. **Evals.** A fixed benchmark of real tasks tracking pass rate, cost and wall time per driver and model. A first version (`braid eval`, hidden acceptance tests per case) was built and removed; the token and cost display covers what we need to show users for now.
7. **More drivers.** Gemini CLI is in (`src/drivers/gemini.ts`, `driver: "gemini"`), written against the event schema in the gemini-cli 0.53 source but not yet run against a signed-in install. Workers run in `auto_edit` and reviewers in `plan`, so `allowedTools` and `maxTurns` do not apply, and spend is estimated from token counts and list prices. Still to do: OpenCode, and local models through an OpenAI-compatible endpoint.
8. ~~**Replanning.**~~ Shipped, opt-in: `maxReplans` in the plan or `braid run --replan N`. When a task fails for good, a read-only planner agent looks at the failed attempt and the failure reasons, then either splits the task, rewrites it, or gives up. Code validates the proposal (new unique ids, deps only on merged tasks or each other, no cycles, at most 6 tasks); replacements inherit the failed task's driver, checks and limits, and whatever waited on it now waits on the replacements. The task ends as `replaced` and counts as complete. A bad proposal or a spent replan budget leaves it failed as before. While the planner thinks the task is `replanning`, so dependents are not blocked early. Replacement tasks that fail can be replanned again until `maxReplans` is used up.
9. **Standalone installers for Windows and macOS.** Two steps:
   - **Single-file CLI.** Compile braid, with `ui/index.html` embedded, into one executable per platform using `bun build --compile` or Node SEA: `braid.exe` for Windows, and `braid` for macOS on both arm64 and x64. Ship through GitHub Releases, a Homebrew tap and winget. `git` and the agent CLIs stay user-installed, since they are vendor-owned and each user signs in with their own subscription. On first run, braid checks what is missing and shows how to install it.
   - **Desktop app (Tauri).** A native window around the same dashboard, with the single-file CLI bundled as a background process. Installers should be about 10-15 MB (`.msi`/`.exe`, `.dmg`), versus 100 MB or more for Electron, which munder-difflin uses. Adds a tray icon, notifications ("run done", "task failed"), a plan editor, starting runs from the UI, and Tauri's auto-updater. The watch server becomes the local API the app talks to, so it needs write endpoints (start and stop a run, edit a plan) guarded by a per-session token.
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
