import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { resolveTask, validatePlan } from '../src/plan.js';
import { exec } from '../src/proc.js';
import type { HarnessEvent } from '../src/store.js';
import type { PlanSpec } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// Each script says in its name where it fails. The integration worktree is the folder called `_integration`.
const SCRIPTS: Record<string, string> = {
  'pass.js': '',
  'pass-too.js': '',
  'fails-in-integration.js': "process.exit(require('node:path').basename(process.cwd()) === '_integration' ? 1 : 0);\n",
  'fails-in-task.js': "process.exit(require('node:path').basename(process.cwd()) === '_integration' ? 0 : 1);\n",
};

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-verify-merge-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  for (const [name, body] of Object.entries(SCRIPTS)) writeFileSync(join(dir, name), body);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
const work = (o: DriverRunOptions): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' } });
const task = (id: string, extra: object = {}) => ({ id, title: id.toUpperCase(), prompt: 'p', ...extra });

async function run(repo: string, plan: PlanSpec, script: (o: DriverRunOptions) => MockStep = work) {
  const mock = new MockDriver(script);
  const orch = new Orchestrator({ repo, plan: { driver: 'mock', ...plan }, drivers: new DriverRegistry().register(mock) });
  const events: HarnessEvent[] = [];
  orch.store.onEvent((e) => events.push(e));
  const state = await orch.run();
  return { state, events, mock };
}

/** Which checks ran where, in order: `task:node a.js`, `integration:node b.js`. */
const checks = (events: HarnessEvent[], id?: string) => events.filter((e) => e.type === 'verify' && (!id || e.task === id)).map((e) => `${e.dir}:${e.cmd}`);

describe('verifyMerge', () => {
  it('runs a task\'s verify in its worktree and verifyMerge in the integration worktree', async () => {
    const repo = await makeRepo();
    const { state, events } = await run(repo, { goal: 'g', verify: ['node fails-in-integration.js'], verifyMerge: ['node pass.js'], tasks: [task('a')] });
    assert.equal(state.status, 'done');
    // verify would fail on the combined tree, so it ran only where it passes; the merge was judged by verifyMerge.
    assert.deepEqual(checks(events), ['task:node fails-in-integration.js', 'integration:node pass.js']);
  });

  it('defaults to the task\'s own verify on the combined tree, as before', async () => {
    const repo = await makeRepo();
    const { state, events } = await run(repo, { goal: 'g', verify: ['node pass.js', 'node pass-too.js'], tasks: [task('a')] });
    assert.equal(state.status, 'done');
    assert.deepEqual(checks(events), ['task:node pass.js', 'task:node pass-too.js', 'integration:node pass.js', 'integration:node pass-too.js']);
  });

  it('lets a task\'s verifyMerge win over the plan\'s, which wins over verify', async () => {
    const repo = await makeRepo();
    const { state, events } = await run(repo, {
      goal: 'g',
      concurrency: 1,
      verify: ['node pass.js'],
      verifyMerge: ['node pass-too.js'],
      tasks: [task('a', { verifyMerge: ['node pass.js', 'node pass-too.js'] }), task('b'), task('c', { verify: ['node fails-in-integration.js'] })],
    });
    assert.equal(state.status, 'done');
    assert.deepEqual(checks(events, 'a'), ['task:node pass.js', 'integration:node pass.js', 'integration:node pass-too.js']);
    assert.deepEqual(checks(events, 'b'), ['task:node pass.js', 'integration:node pass-too.js']);
    assert.deepEqual(checks(events, 'c'), ['task:node fails-in-integration.js', 'integration:node pass-too.js'], 'a task that changes verify still gets the plan\'s merge check');
  });

  it('still runs the task\'s verify in the task worktree, and a failure there stops the task before any merge', async () => {
    const repo = await makeRepo();
    const { state, events } = await run(repo, { goal: 'g', maxAttempts: 1, verify: ['node fails-in-task.js'], verifyMerge: ['node pass.js'], tasks: [task('a')] });
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /Verification failed/);
    assert.deepEqual(checks(events), ['task:node fails-in-task.js']);
    assert.ok(!events.some((e) => e.type === 'merge'));
  });

  it('rolls the merge back when verifyMerge fails on the combined tree, and tells the agent which check', async () => {
    const repo = await makeRepo();
    const head = (await exec('git', ['rev-parse', 'main'], { cwd: repo })).stdout.trim();
    const { state, events, mock } = await run(repo, { goal: 'g', maxAttempts: 2, verify: ['node pass.js'], verifyMerge: ['node fails-in-integration.js'], tasks: [task('a')] });
    assert.equal(state.tasks.a!.status, 'failed');
    assert.equal(events.filter((e) => e.type === 'merge_reverted').length, 2);
    assert.equal(state.verifiedHead, head, 'the integration branch holds only what verified');
    assert.match(mock.calls[1]!.prompt, /broke verification once combined/);
    assert.match(mock.calls[1]!.prompt, /node fails-in-integration\.js/);
  });

  it('skips the check on the combined tree when verifyMerge is empty', async () => {
    const repo = await makeRepo();
    const { state, events } = await run(repo, { goal: 'g', verify: ['node fails-in-integration.js'], verifyMerge: [], tasks: [task('a')] });
    assert.equal(state.status, 'done');
    assert.deepEqual(checks(events), ['task:node fails-in-integration.js']);
  });

  it('applies verifyMerge to the tasks a replan adds, too', async () => {
    const repo = await makeRepo();
    const script = (o: DriverRunOptions): MockStep => {
      if (/You are the planner for a team of coding agents/.test(o.prompt)) return { text: JSON.stringify({ action: 'replace', reason: 'x', tasks: [{ id: 'a2', title: 'A2', prompt: 'p' }] }) };
      return taskOf(o) === 'a' ? { ok: false, text: 'cannot do it' } : work(o);
    };
    const { state, events } = await run(
      repo,
      { goal: 'g', maxReplans: 1, maxAttempts: 1, verify: ['node fails-in-integration.js'], verifyMerge: ['node pass.js'], tasks: [task('a')] },
      script,
    );
    assert.equal(state.tasks.a!.status, 'replaced');
    assert.equal(state.tasks.a2!.status, 'done');
    assert.deepEqual(checks(events, 'a2'), ['task:node fails-in-integration.js', 'integration:node pass.js']);
  });
});

describe('verifyMerge in a plan', () => {
  const plan = (extra: object, taskExtra: object = {}) => ({ goal: 'g', ...extra, tasks: [{ id: 'a', title: 'A', prompt: 'p', ...taskExtra }] }) as PlanSpec;

  it('accepts an array of non-empty strings, an empty one, or none', () => {
    validatePlan(plan({ verifyMerge: ['npm run smoke'] }, { verifyMerge: ['npm test', 'npm run lint'] }));
    validatePlan(plan({ verifyMerge: [] }, { verifyMerge: [] }));
    validatePlan(plan({}));
  });

  it('refuses anything else, naming where', () => {
    for (const bad of ['npm test', [''], [' '], [1], null, { 0: 'npm test' }]) {
      assert.throws(() => validatePlan(plan({ verifyMerge: bad })), /plan\.verifyMerge must be an array of non-empty strings/, JSON.stringify(bad));
      assert.throws(() => validatePlan(plan({}, { verifyMerge: bad })), /task "a" verifyMerge must be an array of non-empty strings/, JSON.stringify(bad));
    }
  });

  it('resolves to the task\'s, then the plan\'s, then the task\'s own verify', () => {
    const t = (extra: object) => ({ id: 'a', title: 'A', prompt: 'p', ...extra });
    const base = { goal: 'g', tasks: [] } as PlanSpec;
    assert.deepEqual(resolveTask({ ...base, verify: ['v'], verifyMerge: ['pm'] }, t({ verifyMerge: ['tm'] })).verifyMerge, ['tm']);
    assert.deepEqual(resolveTask({ ...base, verify: ['v'], verifyMerge: ['pm'] }, t({ verify: ['tv'] })).verifyMerge, ['pm']);
    assert.deepEqual(resolveTask({ ...base, verify: ['v'] }, t({})).verifyMerge, ['v']);
    assert.deepEqual(resolveTask({ ...base, verify: ['v'] }, t({ verify: ['tv'] })).verifyMerge, ['tv']);
    assert.deepEqual(resolveTask({ ...base }, t({})).verifyMerge, []);
    assert.deepEqual(resolveTask({ ...base, verify: ['v'], verifyMerge: ['pm'] }, t({ verifyMerge: [] })).verifyMerge, []);
  });
});
