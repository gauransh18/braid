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
                    └─ merge   (serialized)               ── conflict ─► fresh worktree, redo
                         └─ verify again on the combined tree ── fail ─► roll back the merge, redo
```

- `src/orchestrator.ts`: the scheduler, the task lifecycle, and serialized merges followed by verification.
- `src/drivers/*`: the `Driver` interface plus the Claude, Codex (not yet tested against a live install) and mock drivers. Every CLI maps to one `AgentEvent` stream.
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

1. **Cheaper conflict handling.** Today a merge conflict throws away the attempt and redoes it. Instead, merge the integration branch into the task branch and have the agent resolve the conflict markers. (In the smoke test, a conflict roughly doubled that task's cost.)
2. **Resume.** Restart an interrupted run from `state.json`, reusing tasks that are already merged.
3. ~~**Watch UI.**~~ Shipped as `braid watch`, `braid run --watch` and `braid demo`: a local read-only page (`ui/index.html`, `src/watch.ts`) that tails the run files over SSE.
4. **Container sandbox.** An optional per-task container (Docker or Podman) so Bash can be allowed safely.
5. **Shared team server.** A daemon that queues runs, gives a shared dashboard, holds team memory (lessons learned per repo, fed back into worker prompts) and posts to Slack.
6. **Evals.** A fixed benchmark of real tasks tracking pass rate, cost and wall time per driver and model, so "better" is measured.
7. **More drivers.** Gemini CLI (`gemini -p --output-format stream-json`), OpenCode, and local models through an OpenAI-compatible endpoint.
8. **Replanning.** When a task fails for good, ask the planner to split or rewrite it instead of blocking its dependents.
