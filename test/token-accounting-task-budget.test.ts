import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator.js';
import { applyReplan, DEFAULT_TOKENS_PER_TASK, resolveTask, validatePlan } from '../src/plan.js';
import { exec } from '../src/proc.js';
import type { PlanSpec, TaskSpec } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// Fails when any .txt file contains "bad".
const CHECK_JS = `
const fs = require('fs');
for (const f of fs.readdirSync('.')) {
  if (f.endsWith('.txt') && fs.readFileSync(f, 'utf8').includes('bad')) { console.error(f + ' is bad'); process.exit(1); }
}
`;

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-taskbudget-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'other';
const isReviewer = (o: DriverRunOptions) => /strict code reviewer/.test(o.prompt);
const isPlanner = (o: DriverRunOptions) => /You are the planner for a team of coding agents/.test(o.prompt);
const good = (o: DriverRunOptions): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' } });
const bad = (o: DriverRunOptions): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'bad\n' } });

/** 1200 tokens of fresh input and output, however much was cached. */
const heavy = { input: 600, cached: 5_000_000, output: 600 };
const light = { input: 50, cached: 0, output: 50 };

const spec = (id: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({ id, title: id.toUpperCase(), prompt: 'p', ...extra });

function orchestrator(repo: string, plan: PlanSpec, script: (o: DriverRunOptions, i: number) => MockStep, extra: Partial<OrchestratorOptions> = {}) {
  const mock = new MockDriver(script);
  const orch = new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(mock), retryDelaysMs: [1, 1], ...extra });
  return { orch, mock };
}

describe('per-task token allowance: configuration', () => {
  it('defaults to 3 million per task; the plan and a task can change it, and 0 turns it off', () => {
    const t = spec('a');
    assert.equal(DEFAULT_TOKENS_PER_TASK, 3_000_000);
    assert.equal(resolveTask({ goal: 'g', tasks: [t] }, t).budgetTokens, 3_000_000);
    assert.equal(resolveTask({ goal: 'g', taskBudgetTokens: 500, tasks: [t] }, t).budgetTokens, 500);
    assert.equal(resolveTask({ goal: 'g', taskBudgetTokens: 0, tasks: [t] }, t).budgetTokens, 0);
    const own = spec('a', { budgetTokens: 7 });
    assert.equal(resolveTask({ goal: 'g', taskBudgetTokens: 500, tasks: [own] }, own).budgetTokens, 7, 'the task wins over the plan');
    const off = spec('a', { budgetTokens: 0 });
    assert.equal(resolveTask({ goal: 'g', taskBudgetTokens: 500, tasks: [off] }, off).budgetTokens, 0, 'and 0 on a task switches it off for that task');
  });

  it('rejects limits that are not a number of 0 or more', () => {
    assert.doesNotThrow(() => validatePlan({ goal: 'g', taskBudgetTokens: 0, tasks: [spec('a', { budgetTokens: 0 })] }));
    for (const bad of [-1, Number.NaN, '5' as unknown as number]) {
      assert.throws(() => validatePlan({ goal: 'g', taskBudgetTokens: bad, tasks: [spec('a')] }), /plan.taskBudgetTokens must be a number/);
      assert.throws(() => validatePlan({ goal: 'g', tasks: [spec('a', { budgetTokens: bad })] }), /task "a" budgetTokens must be a number/);
    }
  });

  it('lets the tasks a replan adds inherit the failed task\'s own allowance', () => {
    const plan: PlanSpec = { goal: 'g', tasks: [spec('a', { budgetTokens: 7 })] };
    const { added } = applyReplan(plan, 'a', { tasks: [{ id: 'a1', prompt: 'p' }] }, new Set());
    assert.equal(added[0]!.budgetTokens, 7);
  });
});

describe('per-task token allowance: at run time', () => {
  it('is an allowance for each task, not a pool: tasks that each stay under it all finish', async () => {
    const repo = await makeRepo();
    // 1200 tokens a task against 2000 each. A pool of 2000 would have refused the second task.
    const { orch, mock } = orchestrator(repo, { goal: 'g', driver: 'mock', concurrency: 1, taskBudgetTokens: 2000, tasks: [spec('a'), spec('b'), spec('c')] }, (o) => ({ ...good(o), tokens: heavy }));
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.equal(mock.calls.length, 3);
  });

  it('fails the task that goes over and lets the others carry on; what depends on it is blocked', async () => {
    const repo = await makeRepo();
    const { orch, mock } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', concurrency: 1, taskBudgetTokens: 1000, maxAttempts: 3, verify: ['node check.js'], tasks: [spec('a'), spec('b'), spec('c', { deps: ['a'] })] },
      (o) => (taskOf(o) === 'a' ? { ...bad(o), tokens: heavy } : { ...good(o), tokens: light }),
    );
    const state = await orch.run();
    assert.equal(state.status, 'failed');
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /^token budget exhausted for this task \(1\.2k fresh and output tokens used by its agent calls; the limit is 1k\)/);
    assert.equal(state.tasks.a!.attempts, 1, 'stopped between attempts: the second was never started');
    assert.equal(state.tasks.b!.status, 'done', 'an independent task is not touched');
    assert.equal(state.tasks.c!.status, 'blocked');
    assert.equal(mock.calls.filter((c) => taskOf(c) === 'a').length, 1);
  });

  it('counts every agent call of the task, the reviewer included', async () => {
    const repo = await makeRepo();
    // 600 from the worker stays under 1000; the reviewer's 600 on top does not.
    const { orch, mock } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', review: true, taskBudgetTokens: 1000, maxAttempts: 3, tasks: [spec('a')] },
      (o) => (isReviewer(o) ? { text: '{"approve": false, "issues": ["no"]}', tokens: { input: 300, cached: 0, output: 300 } } : { ...good(o), tokens: { input: 300, cached: 0, output: 300 } }),
    );
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /token budget exhausted for this task \(1\.2k /);
    assert.equal(mock.calls.length, 2, 'one worker call and one review, then no second attempt');
  });

  it('lets a task set its own allowance, above or below the plan, or switch it off', async () => {
    const repo = await makeRepo();
    // Each call costs 1200 tokens and fails the check until a task has failed it as often as `failures` says.
    const calls = new Map<string, number>();
    const failures: Record<string, number> = { a: 2, b: 1, c: 1 };
    const { orch } = orchestrator(
      repo,
      {
        goal: 'g', driver: 'mock', concurrency: 1, taskBudgetTokens: 1000, maxAttempts: 3, verify: ['node check.js'],
        tasks: [spec('a', { budgetTokens: 0 }), spec('b', { budgetTokens: 5000 }), spec('c')],
      },
      (o) => {
        const id = taskOf(o);
        const n = calls.get(id) ?? 0;
        calls.set(id, n + 1);
        return { ...(n < failures[id]! ? bad(o) : good(o)), tokens: heavy };
      },
    );
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'done', 'a is not limited: three calls, 3600 tokens');
    assert.equal(state.tasks.a!.attempts, 3);
    assert.equal(state.tasks.b!.status, 'done', 'b may use 5000: two calls, 2400 tokens');
    assert.equal(state.tasks.b!.attempts, 2);
    assert.equal(state.tasks.c!.status, 'failed', "c has the plan's 1000 and used 1200 in its first call");
    assert.match(state.tasks.c!.error!, /token budget exhausted for this task/);
  });

  it('has no run-wide limit unless the plan sets budgetTokens', async () => {
    const repo = await makeRepo();
    const huge = { input: 4_000_000, cached: 0, output: 0 };
    // 8 million tokens across the run, and every task is switched off from its own allowance: nothing stops it.
    const { orch, mock } = orchestrator(repo, { goal: 'g', driver: 'mock', concurrency: 1, taskBudgetTokens: 0, tasks: [spec('a'), spec('b')] }, (o) => ({ ...good(o), tokens: huge }));
    assert.equal((await orch.run()).status, 'done');
    assert.equal(mock.calls.length, 2);
    // Set explicitly it stops the run as before, with its own message.
    const capped = orchestrator(await makeRepo(), { goal: 'g', driver: 'mock', concurrency: 1, taskBudgetTokens: 0, budgetTokens: 1000, tasks: [spec('a'), spec('b')] }, (o) => ({ ...good(o), tokens: heavy }));
    const state = await capped.orch.run();
    assert.equal(state.tasks.a!.status, 'done');
    assert.equal(state.tasks.b!.status, 'skipped');
    assert.match(state.tasks.b!.error!, /^token budget exhausted \(/);
    assert.ok(!/for this task/.test(state.tasks.b!.error!));
  });

  it('ends the task with the allowance message when a provider error leaves it over the limit', async () => {
    const repo = await makeRepo();
    const { orch, mock } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', taskBudgetTokens: 1000, tasks: [spec('a')] },
      () => ({ ok: false, text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', tokens: heavy }),
      { retryDelaysMs: [1, 1, 1, 1] },
    );
    const state = await orch.run();
    assert.equal(mock.calls.length, 1, 'not retried: the allowance is used up');
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /^token budget exhausted for this task/);
    assert.ok(!/agent unavailable/.test(state.tasks.a!.error!), 'the provider is not blamed');
  });

  it('does not ask the planner to replace a task that is over its allowance', async () => {
    const repo = await makeRepo();
    const { orch, mock } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', maxReplans: 1, maxAttempts: 1, taskBudgetTokens: 1000, verify: ['node check.js'], tasks: [spec('a')] },
      (o) => (isPlanner(o) ? { text: '{"action": "give_up", "reason": "x"}' } : { ...bad(o), tokens: heavy }),
    );
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.equal(mock.calls.length, 1, 'no planner call, which would be one more call on the same task');
    assert.equal(state.replans ?? 0, 0);
  });

  it('gives a task a fresh allowance when the run is resumed, and the total still adds up', async () => {
    const repo = await makeRepo();
    const plan: PlanSpec = { goal: 'g', driver: 'mock', taskBudgetTokens: 1000, tasks: [spec('a')] };
    const first = orchestrator(repo, plan, (o) => ({ ...good(o), tokens: heavy, ok: false, text: 'could not finish' }));
    const s1 = await first.orch.run();
    assert.equal(s1.tasks.a!.status, 'failed');
    assert.match(s1.tasks.a!.error!, /token budget exhausted for this task/);

    // Left alone, the 1200 tokens the task already holds would put it over 1000 before it started.
    const second = orchestrator(repo, plan, (o) => ({ ...good(o), tokens: heavy }), { runId: first.orch.runId, resume: true });
    const s2 = await second.orch.run();
    assert.equal(s2.status, 'done');
    assert.equal(second.mock.calls.length, 1);
    assert.equal(s2.tasks.a!.tokens!.input + s2.tasks.a!.tokens!.output, 2400);
  });
});
