import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { AgentUnavailableError, classifyAgentFailure } from '../src/failures.js';
import { Git } from '../src/git.js';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator.js';
import { validatePlan } from '../src/plan.js';
import { exec } from '../src/proc.js';
import type { HarnessEvent } from '../src/store.js';
import type { PlanSpec } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// Fails when any .txt file contains "bad". `hang.js` never finishes, to stand in for a stuck test suite.
const CHECK_JS = `
const fs = require('fs');
for (const f of fs.readdirSync('.')) {
  if (f.endsWith('.txt') && fs.readFileSync(f, 'utf8').includes('bad')) { console.error(f + ' is bad'); process.exit(1); }
}
`;

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-limits-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  writeFileSync(join(dir, 'hang.js'), 'setTimeout(() => {}, 30000);\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
const isReviewer = (o: DriverRunOptions) => /strict code reviewer/.test(o.prompt);
const work = (o: DriverRunOptions): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' } });

const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const OUT_OF_USAGE = 'Claude AI usage limit reached|1700000000';

function orchestrator(repo: string, plan: PlanSpec, script: (o: DriverRunOptions, i: number) => MockStep, extra: Partial<OrchestratorOptions> = {}) {
  const mock = new MockDriver(script);
  const orch = new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(mock), retryDelaysMs: [1, 1], ...extra });
  const events: HarnessEvent[] = [];
  orch.store.onEvent((e) => events.push(e));
  return { orch, mock, events };
}

describe('telling provider trouble from bad work', () => {
  it('recognizes rate limits, overload and network errors', () => {
    for (const text of [OVERLOADED, 'API Error: 429 {"type":"rate_limit_error"}', 'Error: connect ETIMEDOUT 1.2.3.4:443', 'fetch failed', 'HTTP 503 Service Unavailable', 'Codex error (HTTP 502)', '429 Too Many Requests', 'RESOURCE_EXHAUSTED: try later']) {
      assert.equal(classifyAgentFailure(text), 'transient', text);
    }
  });

  it('recognizes running out of usage or credit', () => {
    for (const text of [OUT_OF_USAGE, 'Your credit balance is too low to access the Anthropic API', 'You exceeded your current quota, please check your plan', '5-hour limit reached ∙ resets 3pm']) {
      assert.equal(classifyAgentFailure(text), 'quota', text);
    }
  });

  it("leaves an agent's own words alone", () => {
    for (const text of ['I added rate limiting middleware but the tests still fail.', 'error on line 503 of server.ts', 'The agent run ended with an error: Cannot find module', 'verification failed: expected 500 items']) {
      assert.equal(classifyAgentFailure(text), null, text);
    }
  });
});

describe('agent calls the provider turned away', () => {
  it('waits and tries again without spending one of the task attempts', async () => {
    const repo = await makeRepo();
    const { orch, mock, events } = orchestrator(repo, { goal: 'g', driver: 'mock', maxAttempts: 1, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, (o, i) => (i < 2 ? { ok: false, text: OVERLOADED } : work(o)));
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.equal(state.tasks.a!.attempts, 1, 'the retries were not counted as attempts');
    assert.equal(mock.calls.length, 3);
    const retries = events.filter((e) => e.type === 'agent_retry');
    assert.equal(retries.length, 2);
    assert.equal(retries[0]!.role, 'worker');
    assert.ok(!mock.calls[1]!.prompt.includes('rejected'), 'the agent is not told its work was rejected');
  });

  it('fails the task as unavailable, not as bad work, once the retries run out', async () => {
    const repo = await makeRepo();
    const { orch, mock } = orchestrator(repo, { goal: 'g', driver: 'mock', maxReplans: 1, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, () => ({ ok: false, text: OVERLOADED }));
    const state = await orch.run();
    assert.equal(state.status, 'failed');
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /agent unavailable: still failing after 2 retries/);
    assert.equal(state.tasks.a!.attempts, 0);
    assert.equal(mock.calls.length, 3, 'one call and two retries; no replanner call to a provider that is down');
  });

  it('stops starting tasks when the account is out of usage', async () => {
    const repo = await makeRepo();
    const { orch, mock } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', concurrency: 1, tasks: [{ id: 'a', title: 'A', prompt: 'p' }, { id: 'b', title: 'B', prompt: 'p' }] },
      () => ({ ok: false, text: OUT_OF_USAGE }),
    );
    const state = await orch.run();
    assert.equal(mock.calls.length, 1, 'no retry, and the second task never started');
    assert.match(state.tasks.a!.error!, /usage or credit limit reached/);
    assert.equal(state.tasks.b!.status, 'skipped');
    assert.match(state.tasks.b!.error!, /usage or credit limit reached/);
  });

  it('does not treat a reviewer the provider turned away as a rejection', async () => {
    const repo = await makeRepo();
    let reviews = 0;
    const { orch, mock } = orchestrator(repo, { goal: 'g', driver: 'mock', review: true, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, (o) => {
      if (!isReviewer(o)) return work(o);
      return reviews++ === 0 ? { ok: false, text: OVERLOADED } : {};
    });
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.equal(state.tasks.a!.attempts, 1, 'the worker did not redo anything');
    assert.equal(mock.calls.filter((c) => !isReviewer(c)).length, 1);
  });

  it('still feeds an ordinary failure back to the agent', async () => {
    const repo = await makeRepo();
    const { orch, mock } = orchestrator(repo, { goal: 'g', driver: 'mock', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, (o, i) => (i === 0 ? { ok: false, text: 'Cannot find module ./x' } : work(o)));
    const state = await orch.run();
    assert.equal(state.tasks.a!.attempts, 2);
    assert.match(mock.calls[1]!.prompt, /Cannot find module/);
  });

  it('gives up waiting at once when the run is stopped', async () => {
    const repo = await makeRepo();
    const ac = new AbortController();
    const { orch } = orchestrator(repo, { goal: 'g', driver: 'mock', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, () => ({ ok: false, text: OVERLOADED }), { retryDelaysMs: [60_000], signal: ac.signal });
    orch.store.onEvent((e) => e.type === 'agent_retry' && ac.abort());
    const started = Date.now();
    const state = await orch.run();
    assert.ok(Date.now() - started < 10_000, 'did not sit out the 60 s pause');
    assert.equal(state.status, 'aborted');
    assert.equal(state.tasks.a!.status, 'skipped');
  });
});

describe('stopping a run', () => {
  it('stops a verify command that is still running, and everything it started', async () => {
    const repo = await makeRepo();
    const ac = new AbortController();
    const { orch } = orchestrator(repo, { goal: 'g', driver: 'mock', verify: ['node hang.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, work, { signal: ac.signal });
    orch.store.onEvent((e) => {
      if (e.type === 'task_status' && e.status === 'verifying') setTimeout(() => ac.abort(), 300);
    });
    const started = Date.now();
    const state = await orch.run();
    assert.ok(Date.now() - started < 15_000, 'did not wait for the 30 s check to finish');
    assert.equal(state.status, 'aborted');
    assert.equal(state.tasks.a!.status, 'skipped');
    assert.equal(state.tasks.a!.error, 'run aborted');
  });
});

describe('time limit on an agent call', () => {
  it('stops an agent that runs too long and retries the task with what it left', async () => {
    const repo = await makeRepo();
    const { orch, mock, events } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', timeoutMin: 0.003, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] },
      (o, i) => (i === 0 ? { delayMs: 20_000, files: { 'a.txt': 'partial\n' } } : work(o)),
    );
    const started = Date.now();
    const state = await orch.run();
    assert.ok(Date.now() - started < 15_000);
    assert.equal(state.status, 'done');
    assert.equal(state.tasks.a!.attempts, 2);
    assert.match(mock.calls[1]!.prompt, /stopped after 0\.003 minutes/);
    assert.ok(events.some((e) => e.type === 'agent_timeout'));
  });

  it('a task can set its own limit, and 0 turns it off', () => {
    assert.doesNotThrow(() => validatePlan({ goal: 'g', timeoutMin: 0, tasks: [{ id: 'a', title: 'A', prompt: 'p', timeoutMin: 90 }] }));
    for (const bad of [-1, Number.NaN, '30' as unknown as number]) {
      assert.throws(() => validatePlan({ goal: 'g', timeoutMin: bad, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }), /plan.timeoutMin must be a number/);
      assert.throws(() => validatePlan({ goal: 'g', budgetTokens: bad, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }), /plan.budgetTokens must be a number/);
      assert.throws(() => validatePlan({ goal: 'g', tasks: [{ id: 'a', title: 'A', prompt: 'p', timeoutMin: bad }] }), /task "a" timeoutMin must be a number/);
    }
  });
});

describe('token budget', () => {
  const heavy = { input: 600, cached: 5_000_000, output: 600 };
  const twoTasks = (extra: Partial<PlanSpec> = {}): PlanSpec => ({ goal: 'g', driver: 'mock', concurrency: 1, tasks: [{ id: 'a', title: 'A', prompt: 'p' }, { id: 'b', title: 'B', prompt: 'p' }], ...extra });

  it('stops starting tasks once fresh and output tokens reach the limit; cached input does not count', async () => {
    const repo = await makeRepo();
    const { orch } = orchestrator(repo, twoTasks({ budgetTokens: 1000 }), (o) => ({ ...work(o), tokens: heavy }));
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'done');
    assert.equal(state.tasks.b!.status, 'skipped');
    assert.match(state.tasks.b!.error!, /^token budget exhausted \(1\.2k fresh and output tokens used; the limit is 1k\)/);
    // The same call stays under a limit that is above its fresh and output tokens, however much was cached.
    const second = orchestrator(await makeRepo(), twoTasks({ budgetTokens: 2000 }), (o) => ({ ...work(o), tokens: heavy }));
    assert.equal((await second.orch.run()).status, 'done');
  });

  it('applies a default limit when the plan sets none, so a retry loop cannot spend without end', async () => {
    const repo = await makeRepo();
    const plan: PlanSpec = { goal: 'g', driver: 'mock', verify: ['node check.js'], maxAttempts: 5, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
    // Every attempt writes a file the check rejects, and costs 4 million tokens against a default of 3 million per task.
    const { orch, mock } = orchestrator(repo, plan, (o) => ({ files: { 'a.txt': 'bad\n' }, tokens: { input: 4_000_000, cached: 0, output: 0 } }));
    const state = await orch.run();
    assert.equal(mock.calls.length, 1);
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /token budget exhausted/);
  });

  it('budgetTokens 0 turns the limit off', async () => {
    const repo = await makeRepo();
    const plan: PlanSpec = { goal: 'g', driver: 'mock', budgetTokens: 0, verify: ['node check.js'], maxAttempts: 3, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
    const { orch } = orchestrator(repo, plan, (_o, i) => ({ files: { 'a.txt': i < 2 ? 'bad\n' : 'ok\n' }, tokens: { input: 4_000_000, cached: 0, output: 0 } }));
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.equal(state.tasks.a!.attempts, 3);
  });

  it('gives a resumed run a fresh allowance instead of stopping it again at once', async () => {
    const repo = await makeRepo();
    const plan = twoTasks({ budgetTokens: 1000 });
    const script = (o: DriverRunOptions) => ({ ...work(o), tokens: heavy });
    const first = orchestrator(repo, plan, script);
    const s1 = await first.orch.run();
    assert.equal(s1.tasks.b!.status, 'skipped');

    const mock = new MockDriver(script);
    const again = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(mock), runId: first.orch.runId, resume: true }).run();
    assert.equal(again.status, 'done');
    assert.equal(mock.calls.length, 1, 'only b ran');
    assert.equal(again.tokens!.input + again.tokens!.output, 2400, 'spend still adds up across the resume');
  });
});

describe('AgentUnavailableError', () => {
  it('says what happened in one line', () => {
    assert.equal(new AgentUnavailableError('transient', 'API Error: 529\nmore', 1).message, 'agent unavailable: still failing after 1 retry. API Error: 529');
    assert.match(new AgentUnavailableError('quota', OUT_OF_USAGE, 0).message, /^agent unavailable: usage or credit limit reached\./);
  });
});
