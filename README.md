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

You need Node 22 or later, git, and at least one agent CLI signed in (`claude`, optionally `codex`).

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

## Plan format

See [examples/plan.json](examples/plan.json). The fields are:

| Field | Level | Meaning |
| --- | --- | --- |
| `goal` | plan | Shared context given to every agent |
| `base` | plan | Branch to start from (default: current) |
| `concurrency` | plan | Maximum tasks running at once (default 3) |
| `budgetUsd` | plan | Hard spend cap for the run |
| `setup` | plan | Commands run in each fresh worktree, e.g. `npm ci` |
| `driver`, `model` | both | `claude` (default), `codex`, `mock` |
| `verify` | both | Commands that must exit 0 |
| `review` | both | Run a read-only reviewer on the diff |
| `maxAttempts` | both | Tries, including retries with feedback (default 2) |
| `allowedTools` | both | Agent tool allowlist (default: no Bash) |
| `maxTurns` | both | Agent turn cap |
| `id`, `title`, `prompt`, `deps` | task | The task itself |

Values set on a task override the plan-level values.

## Where things live

`.braid/runs/<runId>/` holds the plan, state, event log and every agent transcript.
Worktrees live under `.braid/worktrees/`, and the worktrees of failed tasks are kept for inspection.

Design and roadmap: [docs/DESIGN.md](docs/DESIGN.md).

## Develop

```bash
npm test   # builds, then runs unit and end-to-end scheduler tests with a mock driver
```
