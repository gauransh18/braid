import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { resolveTask, validatePlan } from '../src/plan.js';
import { exec } from '../src/proc.js';
import { HttpError, RunManager } from '../src/runs.js';
import type { HarnessEvent } from '../src/store.js';
import type { PlanSpec } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-reviewer-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
const isReviewer = (o: DriverRunOptions) => /strict code reviewer/.test(o.prompt);
const work = (o: DriverRunOptions): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' } });
const approve: MockStep = { text: '{"approve": true, "issues": []}' };
const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const OUT_OF_USAGE = 'Claude AI usage limit reached|1700000000';

const registry = (...drivers: MockDriver[]) => drivers.reduce((r, d) => r.register(d), new DriverRegistry());
const task = (id: string, extra: object = {}) => ({ id, title: id.toUpperCase(), prompt: 'p', ...extra });

function watch(orch: Orchestrator): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  orch.store.onEvent((e) => events.push(e));
  return events;
}

describe('which agent reviews', () => {
  it('sends the review to the reviewer\'s own agent and model, never to the worker\'s', async () => {
    const repo = await makeRepo();
    const worker = new MockDriver(work);
    const rev = new MockDriver(() => approve, 'rev');
    const orch = new Orchestrator({
      repo,
      drivers: registry(worker, rev),
      plan: { goal: 'g', driver: 'mock', model: 'worker-model', review: true, reviewer: { driver: 'rev', model: 'rev-model' }, tasks: [task('a')] },
    });
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.equal(worker.calls.length, 1);
    assert.ok(worker.calls[0]!.canEdit);
    assert.equal(worker.calls[0]!.model, 'worker-model');
    assert.equal(rev.calls.length, 1);
    assert.ok(!rev.calls[0]!.canEdit);
    assert.ok(isReviewer(rev.calls[0]!));
    assert.equal(rev.calls[0]!.model, 'rev-model');
    assert.deepEqual(rev.calls[0]!.allowedTools, ['Read', 'Glob', 'Grep']);
  });

  it('defaults to the task\'s own agent and model', async () => {
    const repo = await makeRepo();
    const mock = new MockDriver(work);
    const other = new MockDriver((o) => (o.canEdit ? work(o) : approve), 'other');
    const orch = new Orchestrator({
      repo,
      drivers: registry(mock, other),
      plan: { goal: 'g', driver: 'mock', model: 'plan-model', review: true, tasks: [task('a'), task('b', { driver: 'other', model: 'b-model' })] },
    });
    assert.equal((await orch.run()).status, 'done');
    assert.deepEqual(mock.calls.map((c) => [c.canEdit, c.model]), [[true, 'plan-model'], [false, 'plan-model']]);
    assert.deepEqual(other.calls.map((c) => [c.canEdit, c.model]).sort(), [[false, 'b-model'], [true, 'b-model']]);
  });

  it('lets a task choose its own reviewer over the plan\'s, and reviews only when review is on', async () => {
    const repo = await makeRepo();
    const mock = new MockDriver(work);
    const rev = new MockDriver(() => approve, 'rev');
    const rev2 = new MockDriver(() => approve, 'rev2');
    const orch = new Orchestrator({
      repo,
      drivers: registry(mock, rev, rev2),
      plan: {
        goal: 'g',
        driver: 'mock',
        concurrency: 1,
        review: true,
        reviewer: { driver: 'rev', model: 'rev-model' },
        tasks: [task('a'), task('b', { reviewer: { driver: 'rev2', model: 'rev2-model' } }), task('c', { review: false })],
      },
    });
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.deepEqual(rev.calls.map((c) => c.model), ['rev-model'], 'a, on the plan\'s reviewer');
    assert.deepEqual(rev2.calls.map((c) => c.model), ['rev2-model'], 'b, on its own');
    assert.equal(mock.calls.filter((c) => !c.canEdit).length, 0, 'c is not reviewed and nobody reviewed on the worker\'s agent');
    assert.equal(mock.calls.length, 3);
  });

  it('feeds a rejection back to the worker and asks the same reviewer again', async () => {
    const repo = await makeRepo();
    const mock = new MockDriver(work);
    let reviews = 0;
    const rev = new MockDriver(() => (reviews++ === 0 ? { text: '{"approve": false, "issues": ["missing tests"]}' } : approve), 'rev');
    const orch = new Orchestrator({
      repo,
      drivers: registry(mock, rev),
      plan: { goal: 'g', driver: 'mock', review: true, reviewer: { driver: 'rev', model: 'strict' }, tasks: [task('a')] },
    });
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.equal(state.tasks.a!.attempts, 2);
    assert.match(mock.calls[1]!.prompt, /missing tests/);
    assert.deepEqual(rev.calls.map((c) => c.model), ['strict', 'strict']);
  });

  it('never calls the reviewer when review is off', async () => {
    const repo = await makeRepo();
    const mock = new MockDriver(work);
    const rev = new MockDriver(() => approve, 'rev');
    const orch = new Orchestrator({ repo, drivers: registry(mock, rev), plan: { goal: 'g', driver: 'mock', reviewer: { driver: 'rev' }, tasks: [task('a')] } });
    assert.equal((await orch.run()).status, 'done');
    assert.equal(rev.calls.length, 0);
  });

  it('refuses, before anything starts, a reviewer on an agent braid does not have', async () => {
    const repo = await makeRepo();
    const mock = new MockDriver(work);
    assert.throws(
      () => new Orchestrator({ repo, drivers: registry(mock), plan: { goal: 'g', driver: 'mock', review: true, reviewer: { driver: 'nope' }, tasks: [task('a')] } }),
      /unknown driver "nope"/,
    );
    assert.throws(
      () => new Orchestrator({ repo, drivers: registry(mock), plan: { goal: 'g', driver: 'mock', review: true, tasks: [task('a', { reviewer: { driver: 'nope2' } })] } }),
      /unknown driver "nope2"/,
    );
  });
});

describe('what a reviewer on its own agent does to the rest of the run', () => {
  it('retries a reviewer the provider turned away on the reviewer\'s agent, and does not redo the work', async () => {
    const repo = await makeRepo();
    const mock = new MockDriver(work);
    let reviews = 0;
    const rev = new MockDriver(() => (reviews++ === 0 ? { ok: false, text: OVERLOADED } : approve), 'rev');
    const orch = new Orchestrator({
      repo,
      drivers: registry(mock, rev),
      plan: { goal: 'g', driver: 'mock', review: true, reviewer: { driver: 'rev' }, tasks: [task('a')] },
      retryDelaysMs: [1, 1],
    });
    const events = watch(orch);
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.equal(state.tasks.a!.attempts, 1);
    assert.equal(mock.calls.length, 1, 'the worker\'s agent was not asked again');
    assert.equal(rev.calls.length, 2);
    assert.ok(events.some((e) => e.type === 'agent_retry' && e.role === 'reviewer'));
  });

  it('halts only the reviewer\'s agent when it runs out of usage, and stops starting tasks that need it', async () => {
    const repo = await makeRepo();
    const mock = new MockDriver(work);
    const rev = new MockDriver(() => ({ ok: false, text: OUT_OF_USAGE }), 'rev');
    const orch = new Orchestrator({
      repo,
      drivers: registry(mock, rev),
      plan: {
        goal: 'g',
        driver: 'mock',
        concurrency: 1,
        reviewer: { driver: 'rev' },
        tasks: [task('a', { review: true }), task('b'), task('c', { review: true })],
      },
      retryDelaysMs: [1],
    });
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /usage or credit limit reached/);
    assert.equal(state.tasks.b!.status, 'done', 'the worker\'s agent has not run out, so a task that needs no reviewer carries on');
    assert.equal(state.tasks.c!.status, 'skipped');
    assert.match(state.tasks.c!.error!, /usage or credit limit reached/);
    assert.equal(rev.calls.length, 1, 'no second call to an agent that said it is out');
    assert.deepEqual(mock.calls.map(taskOf).sort(), ['a', 'b'], 'c never started, so its worker was never paid for');
  });

  it('halts the worker\'s agent, not the reviewer\'s, when the worker runs out', async () => {
    const repo = await makeRepo();
    const mock = new MockDriver(() => ({ ok: false, text: OUT_OF_USAGE }));
    const rev = new MockDriver((o) => (o.canEdit ? work(o) : approve), 'rev');
    const orch = new Orchestrator({
      repo,
      drivers: registry(mock, rev),
      plan: { goal: 'g', concurrency: 1, tasks: [task('a', { driver: 'mock' }), task('b', { driver: 'rev', review: true, reviewer: { driver: 'rev' } })] },
      retryDelaysMs: [1],
    });
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.equal(state.tasks.b!.status, 'done');
  });
});

describe('resolving the reviewer', () => {
  const resolve = (plan: Partial<PlanSpec>, t: object = {}) => resolveTask({ goal: 'g', tasks: [], ...plan } as PlanSpec, task('a', t)).reviewer;

  it('is the task\'s own agent and model unless told otherwise', () => {
    assert.deepEqual(resolve({ driver: 'codex', model: 'm' }), { driver: 'codex', model: 'm' });
    assert.deepEqual(resolve({}, { driver: 'gemini' }), { driver: 'gemini', model: undefined });
    assert.deepEqual(resolve({ driver: 'codex', model: 'm' }, { model: 'task-m' }), { driver: 'codex', model: 'task-m' });
  });

  it('takes what the plan or the task names, the task winning field by field', () => {
    const plan = { driver: 'claude', model: 'sonnet', reviewer: { driver: 'codex', model: 'gpt' } };
    assert.deepEqual(resolve(plan), { driver: 'codex', model: 'gpt' });
    assert.deepEqual(resolve(plan, { reviewer: { driver: 'gemini', model: 'g' } }), { driver: 'gemini', model: 'g' });
    assert.deepEqual(resolve(plan, { reviewer: { model: 'newer' } }), { driver: 'codex', model: 'newer' });
  });

  it('never hands a model to an agent it was not meant for', () => {
    const plan = { driver: 'claude', model: 'sonnet', reviewer: { driver: 'codex', model: 'gpt' } };
    // The task moves the review to another agent: the plan's reviewer model belongs to codex.
    assert.deepEqual(resolve(plan, { reviewer: { driver: 'gemini' } }), { driver: 'gemini', model: undefined });
    // Back on the plan's own agent, its model applies; on the task's own agent, the task's does.
    assert.deepEqual(resolve(plan, { reviewer: { driver: 'claude' } }), { driver: 'claude', model: 'sonnet' });
    assert.deepEqual(resolve(plan, { driver: 'codex', model: 'task-m', reviewer: { driver: 'claude' } }), { driver: 'claude', model: 'sonnet' });
    assert.deepEqual(resolve({ driver: 'claude', model: 'sonnet', reviewer: { model: 'opus' } }, { driver: 'codex', model: 'gpt' }), { driver: 'codex', model: 'opus' });
    assert.deepEqual(resolve({ driver: 'claude', model: 'sonnet', reviewer: { driver: 'codex' } }, { driver: 'codex', model: 'gpt' }), { driver: 'codex', model: 'gpt' });
  });
});

describe('reviewer in a plan', () => {
  const plan = (extra: object, taskExtra: object = {}) => ({ goal: 'g', ...extra, tasks: [{ id: 'a', title: 'A', prompt: 'p', ...taskExtra }] }) as PlanSpec;

  it('accepts an object with a driver and a model, either, or neither', () => {
    validatePlan(plan({ reviewer: { driver: 'codex', model: 'gpt' } }, { reviewer: { model: 'm' } }));
    validatePlan(plan({ reviewer: {} }));
  });

  it('refuses anything else, naming where', () => {
    for (const bad of ['codex', ['codex'], null, 3]) {
      assert.throws(() => validatePlan(plan({ reviewer: bad })), /plan\.reviewer must be an object/, JSON.stringify(bad));
      assert.throws(() => validatePlan(plan({}, { reviewer: bad })), /task "a" reviewer must be an object/, JSON.stringify(bad));
    }
    assert.throws(() => validatePlan(plan({ reviewer: { driver: '' } })), /plan\.reviewer\.driver must be a non-empty string/);
    assert.throws(() => validatePlan(plan({}, { reviewer: { model: 3 } })), /task "a" reviewer\.model must be a non-empty string/);
  });
});

describe('reviewers and the desktop app\'s settings', () => {
  const plan = (extra: Partial<PlanSpec> = {}, taskExtra: object = {}): PlanSpec => ({ goal: 'g', ...extra, tasks: [task('a', taskExtra)] });
  const until = async (ok: () => boolean) => {
    const start = Date.now();
    while (!ok()) {
      if (Date.now() - start > 20_000) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  function setup(repo: string) {
    const script = (o: DriverRunOptions): MockStep => (o.canEdit ? work(o) : approve);
    const drivers = { mock: new MockDriver(script), codex: new MockDriver(script, 'codex'), claude: new MockDriver(script, 'claude') };
    const manager = new RunManager(repo, () => registry(drivers.mock, drivers.codex, drivers.claude));
    const finish = async (runId: string) => {
      await until(() => manager.activeRunId === null);
      return JSON.parse(readFileSync(join(repo, '.braid', 'runs', runId, 'plan.json'), 'utf8')) as PlanSpec;
    };
    return { drivers, manager, finish };
  }

  it('counts a reviewer as an agent the plan uses, so a switched-off one refuses the plan', async () => {
    const repo = await makeRepo();
    const { manager, finish } = setup(repo);
    manager.applySettings({ defaults: { driver: 'mock', disabled: ['codex'] } });
    const off = (plan: PlanSpec) => assert.rejects(manager.start(plan), (err: unknown) => err instanceof HttpError && err.status === 400 && /codex agent is switched off/.test(err.message));

    await off(plan({ review: true, reviewer: { driver: 'codex' } }));
    await off(plan({}, { review: true, reviewer: { driver: 'codex' } }));
    assert.equal(manager.activeRunId, null, 'nothing was left running');

    // The reviewer is only used for tasks that are reviewed.
    assert.ok(await finish((await manager.start(plan({ reviewer: { driver: 'codex' } }))).runId));
    assert.ok(await finish((await manager.start(plan({ review: true, reviewer: { driver: 'codex' } }, { review: false }))).runId));
    // And one on an agent that is on is fine.
    assert.ok(await finish((await manager.start(plan({ review: true, reviewer: { driver: 'claude' } }))).runId));
  });

  it('gives a reviewer on another agent that agent\'s default model, like a task', async () => {
    const repo = await makeRepo();
    const { drivers, manager, finish } = setup(repo);
    manager.applySettings({ defaults: { driver: 'mock', models: { mock: 'main-m', codex: 'codex-m', claude: 'claude-m' } } });
    const started = await manager.start({
      goal: 'g',
      review: true,
      reviewer: { driver: 'codex' },
      tasks: [task('a'), task('b', { reviewer: { driver: 'claude' } }), task('c', { reviewer: { driver: 'claude', model: 'mine' } }), task('d', { reviewer: { driver: 'mock' } })],
    });
    const stored = await finish(started.runId);
    assert.equal(stored.driver, 'mock');
    assert.deepEqual(stored.reviewer, { driver: 'codex', model: 'codex-m' });
    assert.deepEqual(stored.tasks.map((t) => t.reviewer), [undefined, { driver: 'claude', model: 'claude-m' }, { driver: 'claude', model: 'mine' }, { driver: 'mock' }]);
    // What the agents were actually asked.
    const reviewsOf = (d: MockDriver) => d.calls.filter((c) => !c.canEdit).map((c) => c.model).sort();
    assert.deepEqual(reviewsOf(drivers.codex), ['codex-m'], 'a');
    assert.deepEqual(reviewsOf(drivers.claude), ['claude-m', 'mine'], 'b and c');
    assert.deepEqual(reviewsOf(drivers.mock), ['main-m'], 'd, on the plan\'s own agent and model');
  });
});
