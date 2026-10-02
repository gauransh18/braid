import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type Driver, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { AgentUnavailableError } from '../src/failures.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import type { PlanSpec } from '../src/types.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'braid-calls-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const OUT_OF_USAGE = 'Claude AI usage limit reached|1700000000';

describe('a call waiting to be retried', () => {
  // b is turned away with a 529 and sleeps; a then uses up the run's tokens or its agent's quota. b must not call the
  // agent again when it wakes. Nothing here depends on how fast the machine is: a does not start until b has been
  // turned away, and b sleeps for five seconds, far longer than a needs to finish (git is slow on Windows).
  async function run(aStep: MockStep, extra: Partial<PlanSpec> = {}) {
    const repo = await makeRepo();
    let bCalls = 0;
    let bTurnedAway!: () => void;
    const bWasTurnedAway = new Promise<void>((resolve) => (bTurnedAway = resolve));
    const mock = new MockDriver((o): MockStep => {
      if (taskOf(o) === 'a') return aStep;
      if (++bCalls === 1) {
        bTurnedAway();
        return { ok: false, text: OVERLOADED };
      }
      return { files: { 'b.txt': 'b\n' } };
    });
    const driver: Driver = {
      name: 'mock',
      run: async (o) => {
        if (taskOf(o) === 'a') await bWasTurnedAway;
        return mock.run(o);
      },
    };
    const plan: PlanSpec = { goal: 'g', driver: 'mock', concurrency: 2, tasks: [{ id: 'a', title: 'A', prompt: 'p' }, { id: 'b', title: 'B', prompt: 'p' }], ...extra };
    const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(driver), retryDelaysMs: [5000] }).run();
    return { state, bCalls };
  }

  it('does not call the agent again once the run-wide token limit is used up meanwhile', async () => {
    const { state, bCalls } = await run({ files: { 'a.txt': 'a\n' }, tokens: { input: 5100, cached: 0, output: 0 } }, { budgetTokens: 1000 });
    assert.equal(state.tasks.a!.status, 'done');
    assert.equal(bCalls, 1, 'b woke up after the limit was reached and must not spend more');
    assert.equal(state.tasks.b!.status, 'failed');
    assert.match(state.tasks.b!.error!, /token budget exhausted/);
    assert.equal(state.tasks.b!.attempts, 0, 'the call that never got an answer is no try');
  });

  it("does not call an agent whose quota ran out meanwhile", async () => {
    const { state, bCalls } = await run({ ok: false, text: OUT_OF_USAGE });
    assert.equal(state.tasks.a!.status, 'failed');
    assert.equal(bCalls, 1);
    assert.equal(state.tasks.b!.status, 'failed');
    assert.match(state.tasks.b!.error!, /usage or credit limit reached/);
  });
});

describe('a reviewer on another agent', () => {
  const reviewed = (extra: Partial<PlanSpec> = {}): PlanSpec => ({
    goal: 'g',
    driver: 'mock',
    review: true,
    reviewer: { driver: 'rev' },
    maxAttempts: 2,
    tasks: [{ id: 'a', title: 'A', prompt: 'p' }],
    ...extra,
  });
  const workerCalls = (mock: MockDriver, id: string) => mock.calls.filter((c) => c.canEdit && taskOf(c) === id).length;

  it('that ran out of quota stops a task that is still working, not only tasks that have not started', async () => {
    const repo = await makeRepo();
    let bTries = 0;
    let reviewerAsked!: () => void;
    const reviewerWasAsked = new Promise<void>((resolve) => (reviewerAsked = resolve));
    const mock = new MockDriver((o): MockStep => (taskOf(o) === 'b' ? { files: { 'b.txt': ++bTries === 1 ? 'bad\n' : 'ok\n' } } : { files: { 'a.txt': 'ok\n' } }));
    // b's first attempt is held until a has reached its review and found the reviewer's account empty, so b is always
    // still working when that happens; its check then fails and it wants a second attempt.
    const worker: Driver = {
      name: 'mock',
      run: async (o) => {
        if (taskOf(o) === 'b' && bTries === 0) {
          await reviewerWasAsked;
          await sleep(500); // a's task is marked as halted in the same breath, a moment after the reviewer answered
        }
        return mock.run(o);
      },
    };
    const reviewer = new MockDriver(() => {
      reviewerAsked();
      return { ok: false, text: OUT_OF_USAGE };
    }, 'rev');
    const plan = reviewed({ concurrency: 2, verify: ['node check.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }, { id: 'b', title: 'B', prompt: 'p' }] });
    const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(worker).register(reviewer) }).run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.equal(bTries, 1, 'a second attempt would only end at the same empty reviewer');
    assert.equal(state.tasks.b!.status, 'failed');
    assert.match(state.tasks.b!.error!, /usage or credit limit reached/);
  });

  it('that fails without a verdict is not turned into changes for the worker to make', async () => {
    const repo = await makeRepo();
    const worker = new MockDriver((o): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' } }));
    const reviewer = new MockDriver(() => ({ ok: false, text: 'model "opus" not found for codex' }), 'rev');
    const plan = reviewed({ reviewer: { driver: 'rev', model: 'opus' } });
    const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(worker).register(reviewer) }).run();
    assert.equal(workerCalls(worker, 'a'), 1, 'the finished work is not redone for a reviewer that cannot run');
    assert.equal(reviewer.calls.length, 1);
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /reviewer rev \(opus\) failed without giving a verdict.*model "opus" not found/);
    assert.doesNotMatch(worker.calls.map((c) => c.prompt).join('\n'), /Reviewer requested changes/);
  });

  it('whose program is missing is halted, so the tasks after the first are not paid for', async () => {
    const repo = await makeRepo();
    const worker = new MockDriver((o): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' } }));
    const reviewer: Driver = {
      name: 'rev',
      run: async () => {
        throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      },
    };
    const plan = reviewed({ concurrency: 1, tasks: ['a', 'b', 'c'].map((id) => ({ id, title: id, prompt: 'p' })) });
    const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(worker).register(reviewer) }).run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /the rev agent could not be started: spawn codex ENOENT/);
    assert.equal(worker.calls.length, 1, 'only the first task did a worker run before the reviewer was found missing');
    for (const id of ['b', 'c']) {
      assert.equal(state.tasks[id]!.status, 'skipped');
      assert.match(state.tasks[id]!.error!, /could not be started/);
    }
  });

  it('describes a missing program in the error without claiming a retry or a limit', () => {
    const err = new AgentUnavailableError('missing', 'the rev agent could not be started: spawn codex ENOENT', 0, 'reviewer');
    assert.equal(err.message, 'agent unavailable: the rev agent could not be started: spawn codex ENOENT');
  });
});
