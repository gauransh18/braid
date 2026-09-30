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

## Watch it live

```bash
braid run plans/rate-limit.json --watch   # run + dashboard
braid watch                               # dashboard for this repo's runs (any terminal)
braid demo                                # scripted mock run, no agents, no spend
```

The dashboard opens at `http://127.0.0.1:4777`. It is read-only and only listens on this machine.
It shows:

- **The floor:** each agent is a pixel blob at a desk. Its mood follows its task: asleep while pending, typing while running, a magnifier while verifying, glasses while reviewing, jumping while merging, happy when done, flattened when failed, tied up when blocked. The lines between desks are dependencies.
- **The braid:** the integration branch drawn as a rope that gains a strand in the task's color on every verified merge.
- **Usage:** tokens (fresh, cached, output) and spend per task and per run. Dollars show as `~$` when they are estimated from tokens (Codex, Gemini) rather than reported.
- **Activity:** every harness event (verify results, review verdicts, conflicts, rollbacks).
- **Inspector:** click a desk to see the task prompt, its checks and the live agent transcript for each attempt.
- **Knot:** the mascot, which narrates what the run is doing.

## Benchmark drivers and models

```bash
braid eval evals/suite.json --variants claude:sonnet,claude:opus --out results.json
```

Each case starts from a throwaway repo, runs its plan, then copies hidden acceptance tests onto the
integration branch and runs them. It prints pass rate, spend, cost per passing case and time per
variant. See [evals/suite.json](evals/suite.json) for the format. These runs spend real money.

## Plan format

See [examples/plan.json](examples/plan.json). The fields are:

| Field | Level | Meaning |
| --- | --- | --- |
| `goal` | plan | Shared context given to every agent |
| `base` | plan | Branch to start from (default: current) |
| `concurrency` | plan | Maximum tasks running at once (default 3) |
| `budgetUsd` | plan | Hard spend cap for the run |
| `maxReplans` | plan | Times the planner may split or rewrite a task that failed for good (default 0, off) |
| `setup` | plan | Commands run in each fresh worktree, e.g. `npm ci` |
| `driver`, `model` | both | `claude` (default), `codex`, `gemini`, `mock` |
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
