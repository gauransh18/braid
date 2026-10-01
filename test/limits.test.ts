import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ClaudeDriver } from '../src/drivers/claude.js';
import { CodexDriver } from '../src/drivers/codex.js';
import { DriverRegistry, type Driver, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { AgentUnavailableError, classifyAgentFailure } from '../src/failures.js';
import { Git } from '../src/git.js';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator.js';
import { resolveTask, validatePlan } from '../src/plan.js';
import { planGoal } from '../src/planner.js';
import { abortError, exec } from '../src/proc.js';
import type { HarnessEvent } from '../src/store.js';
import type { AgentResult, PlanSpec } from '../src/types.js';

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
  // Setup that takes a different time in each worktree (named after its task), so a task can sit in setup while others finish.
  writeFileSync(join(dir, 'slow-setup.js'), "const ms = { a: 50, b: 400, c: 1500 }[require('node:path').basename(process.cwd())] ?? 0; setTimeout(() => {}, ms);\n");
  writeFileSync(join(dir, 'integration-fails.js'), "process.exit(require('node:path').basename(process.cwd()) === '_integration' ? 1 : 0);\n");
  writeFileSync(join(dir, 'hang-in-integration.js'), "if (require('node:path').basename(process.cwd()) === '_integration') setTimeout(() => {}, 30000);\n");
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
    for (const text of [
      // Captured from Claude Code 2.1.283 against a stand-in API.
      "API Error: Request rejected (429) · This request would exceed your organization's rate limit of 30,000 input tokens per minute (org: x). Retry after a moment.",
      'Request timed out',
      'API Error: Server is temporarily limiting requests (not your usage limit) · this may be a temporary capacity issue.',
      // Codex 0.147.
      'We\'re currently experiencing high demand, which may cause temporary errors.',
      'stream disconnected before completion: error sending request',
      OVERLOADED, 'API Error: 429 {"type":"rate_limit_error"}', 'Error: connect ETIMEDOUT 1.2.3.4:443', 'fetch failed', 'HTTP 503 Service Unavailable', 'Codex error (HTTP 502)', '429 Too Many Requests', 'RESOURCE_EXHAUSTED: try later']) {
      assert.equal(classifyAgentFailure(text), 'transient', text);
    }
  });

  it('recognizes running out of usage or credit', () => {
    for (const text of [
      // Subscription notices from the Claude Code 2.1.283 bundle, and Codex's own.
      "You've hit your session limit · resets 3:20pm",
      "You've hit your weekly limit · resets Mon 9am",
      "You've hit your limit · resets 3pm",
      "You're out of usage credits · resets 4pm",
      "You've hit your monthly spend limit.",
      "You've hit your usage limit. Upgrade to Pro (https://example.test/plans) or try again later.",
      'API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
      'You have exhausted your daily quota on this model.',
      OUT_OF_USAGE, 'Your credit balance is too low to access the Anthropic API', 'You exceeded your current quota, please check your plan', '5-hour limit reached ∙ resets 3pm']) {
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

  it('applies a default limit per task when the plan sets none, so a retry loop cannot spend without end', async () => {
    const repo = await makeRepo();
    const plan: PlanSpec = { goal: 'g', driver: 'mock', verify: ['node check.js'], maxAttempts: 5, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
    // Every attempt writes a file the check rejects, and costs 4 million tokens against a default of 3 million per task.
    const { orch, mock } = orchestrator(repo, plan, (o) => ({ files: { 'a.txt': 'bad\n' }, tokens: { input: 4_000_000, cached: 0, output: 0 } }));
    const state = await orch.run();
    assert.equal(mock.calls.length, 1);
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /token budget exhausted for this task/);
  });

  it('taskBudgetTokens 0 turns the per-task limit off', async () => {
    const repo = await makeRepo();
    const plan: PlanSpec = { goal: 'g', driver: 'mock', taskBudgetTokens: 0, verify: ['node check.js'], maxAttempts: 3, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
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

describe('what braid judges as the provider turning a call away', () => {
  it("never judges the agent's own prose, only what the provider or the CLI reported", async () => {
    const repo = await makeRepo();
    // A failed agent run whose last words talk about an overloaded service: the failure itself was something else.
    const { orch, mock } = orchestrator(repo, { goal: 'g', driver: 'mock', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, (o, i) =>
      i === 0 ? { ok: false, text: 'I made the handler return 503 service unavailable when overloaded, then ran out of turns.', error: 'error_max_turns' } : work(o),
    );
    const state = await orch.run();
    assert.equal(state.tasks.a!.attempts, 2, 'an ordinary failure uses an attempt');
    assert.equal(mock.calls.length, 2, 'and is not retried as if the provider were down');
  });

  const fakeBin = (name: string, body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'braid-fakebin-'));
    temps.push(dir);
    const file = join(dir, name);
    writeFileSync(file, `#!/usr/bin/env node\n${body}`);
    chmodSync(file, 0o755);
    return file;
  };
  const skipWindows = process.platform === 'win32' && 'stand-in agent is a shebang script';

  it("keeps Codex's own error apart from what the agent said, and recognizes it", { skip: skipWindows }, async () => {
    const bin = fakeBin(
      'codex',
      `const out = (o) => console.log(JSON.stringify(o));
process.stdin.resume().on('end', () => {
  out({ type: 'thread.started', thread_id: 't1' });
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'I will add rate limiting to the API' } });
  out({ type: 'error', message: "You've hit your usage limit. Upgrade to Pro (https://example.test/plans) or try again later." });
  out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro (https://example.test/plans) or try again later." } });
  process.exit(1);
});
`,
    );
    const res = await new CodexDriver(bin).run({ prompt: 'p', cwd: tmpdir(), allowedTools: [], canEdit: false });
    assert.equal(res.ok, false);
    assert.match(res.error!, /^You've hit your usage limit/);
    assert.ok(!res.error!.includes('rate limiting'), 'the agent narration is not part of the error');
    assert.match(res.text, /^You've hit your usage limit/, 'the provider message leads, so it is what the dashboard shows');
    assert.equal(classifyAgentFailure(res.error!), 'quota');
  });

  it('reports what a stopped Claude call had used, counting a repeated message once', { skip: skipWindows }, async () => {
    const bin = fakeBin(
      'claude',
      `const out = (o) => console.log(JSON.stringify(o));
const msg = (id, u) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'working' }], usage: u } });
out({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
out(msg('m1', { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000, output_tokens: 30 }));
out(msg('m1', { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000, output_tokens: 30 }));
out(msg('m2', { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 9100, output_tokens: 5 }));
process.on('SIGINT', () => process.exit(1));
setTimeout(() => {}, 30000);
`,
    );
    const ac = new AbortController();
    const seen: string[] = [];
    const run = new ClaudeDriver(bin).run({ prompt: 'p', cwd: tmpdir(), allowedTools: [], canEdit: false, signal: ac.signal, onEvent: (e) => e.kind === 'text' && seen.push(e.text) });
    while (seen.length < 3) await new Promise((r) => setTimeout(r, 25));
    ac.abort();
    const res = await run;
    assert.equal(res.ok, false);
    assert.deepEqual(res.tokens, { input: 160, cached: 18100, output: 35 }, 'fresh input includes cache writes; the repeated message m1 counts once');
  });

  it('puts what the CLI said on a failed Claude call in `error`', { skip: skipWindows }, async () => {
    const bin = fakeBin(
      'claude',
      `process.stdin.resume().on('end', () => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "API Error: Request rejected (429) · This request would exceed your organization's rate limit of 30,000 input tokens per minute", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })));
`,
    );
    const res = await new ClaudeDriver(bin).run({ prompt: 'p', cwd: tmpdir(), allowedTools: [], canEdit: false });
    assert.equal(res.ok, false);
    assert.equal(classifyAgentFailure(res.error!), 'transient');
  });
});

/** An agent that behaves like the real drivers when stopped: it throws an AbortError instead of returning. */
function throwsOnStop(): Driver {
  return {
    name: 'mock',
    async run(o: DriverRunOptions): Promise<AgentResult> {
      // A real agent is a child process, which keeps the event loop alive; the time limit's own timer does not.
      const keepAlive = setInterval(() => undefined, 1000);
      await new Promise<void>((resolve) => (o.signal ? o.signal.addEventListener('abort', () => resolve(), { once: true }) : undefined));
      clearInterval(keepAlive);
      throw abortError();
    },
  };
}

describe('how a stopped call reaches the orchestrator', () => {
  it('treats a driver that throws when the time limit stops it like one that returns', async () => {
    const repo = await makeRepo();
    const mock = new MockDriver(() => ({ files: { 'a.txt': 'ok\n' } }));
    let calls = 0;
    const driver: Driver = { name: 'mock', run: (o) => (calls++ === 0 ? throwsOnStop().run(o) : mock.run(o)) };
    const orch = new Orchestrator({ repo, plan: { goal: 'g', driver: 'mock', timeoutMin: 0.003, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, drivers: new DriverRegistry().register(driver) });
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.equal(state.tasks.a!.attempts, 2);
  });

  it('ends a task skipped when a driver that throws is stopped by the person', async () => {
    const repo = await makeRepo();
    const ac = new AbortController();
    const orch = new Orchestrator({ repo, plan: { goal: 'g', driver: 'mock', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, drivers: new DriverRegistry().register(throwsOnStop()), signal: ac.signal });
    orch.store.onEvent((e) => e.type === 'task_status' && e.status === 'running' && setTimeout(() => ac.abort(), 200));
    const state = await orch.run();
    assert.equal(state.status, 'aborted');
    assert.equal(state.tasks.a!.status, 'skipped');
    assert.equal(state.tasks.a!.error, 'run aborted');
  });

  it('sets the default time limit, and lets a task or the plan change it', () => {
    const task = { id: 'a', title: 'A', prompt: 'p' };
    assert.equal(resolveTask({ goal: 'g', tasks: [task] }, task).timeoutMin, 30);
    assert.equal(resolveTask({ goal: 'g', timeoutMin: 0, tasks: [task] }, task).timeoutMin, 0);
    assert.equal(resolveTask({ goal: 'g', timeoutMin: 5, tasks: [task] }, { ...task, timeoutMin: 90 }).timeoutMin, 90);
  });

  it('does not let a huge timeoutMin kill every agent at once', async () => {
    const repo = await makeRepo();
    const { orch } = orchestrator(repo, { goal: 'g', driver: 'mock', timeoutMin: 1e9, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, work);
    assert.equal((await orch.run()).status, 'done');
  });
});

describe('the planner', () => {
  it('is stopped when it takes too long, instead of running for ever', async () => {
    const mock = new MockDriver(() => ({ delayMs: 20_000, text: '{}' }));
    const started = Date.now();
    await assert.rejects(planGoal(mock, { repo: tmpdir(), goal: 'g', timeoutMs: 150 }), /the planner was stopped after/);
    assert.ok(Date.now() - started < 10_000);
  });

  it('is stopped by the caller too', async () => {
    const mock = new MockDriver(() => ({ delayMs: 20_000, text: '{}' }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(planGoal(mock, { repo: tmpdir(), goal: 'g', signal: ac.signal }), /planner failed: aborted/);
  });
});

describe('stopping a run (more places)', () => {
  const abortWhen = (orch: Orchestrator, ac: AbortController, match: (e: HarnessEvent) => boolean, afterMs = 300) =>
    orch.store.onEvent((e) => {
      if (match(e)) setTimeout(() => ac.abort(), afterMs);
    });

  it('ends the task skipped even when the stop lands on its last attempt', async () => {
    const repo = await makeRepo();
    const ac = new AbortController();
    const { orch } = orchestrator(repo, { goal: 'g', driver: 'mock', maxAttempts: 1, verify: ['node hang.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, work, { signal: ac.signal });
    abortWhen(orch, ac, (e) => e.type === 'task_status' && e.status === 'verifying');
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'skipped');
    assert.equal(state.tasks.a!.error, 'run aborted');
  });

  it('reports a run whose tasks all merged as done, even if the stop arrived just after', async () => {
    const repo = await makeRepo();
    const ac = new AbortController();
    const { orch } = orchestrator(repo, { goal: 'g', driver: 'mock', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, work, { signal: ac.signal });
    orch.store.onEvent((e) => e.type === 'task_status' && e.status === 'done' && ac.abort());
    assert.equal((await orch.run()).status, 'done');
  });

  it('undoes a merge whose combined check was cut short by the stop, without calling it a failed check', async () => {
    const repo = await makeRepo();
    const base = (await exec('git', ['rev-parse', 'main'], { cwd: repo })).stdout.trim();
    const ac = new AbortController();
    const { orch, events } = orchestrator(repo, { goal: 'g', driver: 'mock', verify: ['node hang-in-integration.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, work, { signal: ac.signal });
    abortWhen(orch, ac, (e) => e.type === 'merge' && e.ok === true);
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'skipped');
    assert.ok(events.some((e) => e.type === 'merge_aborted'));
    assert.ok(!events.some((e) => e.type === 'merge_reverted'), 'a Stop is not a failed combined build');
    const head = (await exec('git', ['rev-parse', state.integrationBranch], { cwd: repo })).stdout.trim();
    assert.equal(head, base, 'the integration branch still holds only verified states');
  });
});

describe('scheduling', () => {
  it('starts a task once, even when others finish while it is still in setup', async () => {
    const repo = await makeRepo();
    const { orch, mock, events } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', concurrency: 2, setup: ['node slow-setup.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }, { id: 'b', title: 'B', prompt: 'p' }, { id: 'c', title: 'C', prompt: 'p' }] },
      work,
    );
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.equal(state.tasks.c!.attempts, 1);
    assert.equal(mock.calls.filter((c) => taskOf(c) === 'c').length, 1, 'the agent for c was called once');
    assert.equal(events.filter((e) => e.type === 'task_status' && e.task === 'c' && e.status === 'running').length, 1);
  });

  it('does not call the agent for a task whose agent ran out of quota while it was in setup', async () => {
    const repo = await makeRepo();
    const { orch, mock } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', concurrency: 2, setup: ['node slow-setup.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }, { id: 'c', title: 'C', prompt: 'p' }] },
      (o) => (taskOf(o) === 'a' ? { ok: false, text: OUT_OF_USAGE } : work(o)),
    );
    const state = await orch.run();
    assert.equal(mock.calls.length, 1, 'only a was ever tried');
    assert.equal(state.tasks.c!.status, 'failed');
    assert.match(state.tasks.c!.error!, /usage or credit limit reached/);
  });

  it('blocks a chain of dependents even when they are listed before what they wait for', async () => {
    const repo = await makeRepo();
    const { orch } = orchestrator(
      repo,
      {
        goal: 'g',
        driver: 'mock',
        maxAttempts: 1,
        verify: ['node check.js'],
        tasks: [
          { id: 'c', title: 'C', prompt: 'p', deps: ['b'] },
          { id: 'b', title: 'B', prompt: 'p', deps: ['a'] },
          { id: 'a', title: 'A', prompt: 'p' },
        ],
      },
      () => ({ files: { 'a.txt': 'bad\n' } }),
    );
    const state = await orch.run();
    assert.equal(state.status, 'failed');
    assert.equal(state.tasks.a!.status, 'failed');
    assert.equal(state.tasks.b!.status, 'blocked');
    assert.equal(state.tasks.c!.status, 'blocked');
  });

  it('starts nothing, and says why, when setup fails in the integration worktree', async () => {
    const repo = await makeRepo();
    const { orch, mock } = orchestrator(repo, { goal: 'g', driver: 'mock', setup: ['node integration-fails.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, work);
    const state = await orch.run();
    assert.equal(state.status, 'failed');
    assert.equal(mock.calls.length, 0);
    assert.match(state.tasks.a!.error!, /setup failed in the integration worktree/);
  });

  it('keeps a quota halt to the agent that ran out', async () => {
    const repo = await makeRepo();
    const broke = new MockDriver(() => ({ ok: false, text: OUT_OF_USAGE }), 'mock');
    const fine = new MockDriver(work, 'other');
    const orch = new Orchestrator({
      repo,
      plan: { goal: 'g', concurrency: 1, tasks: [{ id: 'a', title: 'A', prompt: 'p', driver: 'mock' }, { id: 'b', title: 'B', prompt: 'p', driver: 'other' }] },
      drivers: new DriverRegistry().register(broke).register(fine),
      retryDelaysMs: [1],
    });
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.equal(state.tasks.b!.status, 'done', 'the other agent was not stopped by the first one running out');
  });

  it('survives a failed snapshot write', async () => {
    const repo = await makeRepo();
    const { orch } = orchestrator(repo, { goal: 'g', driver: 'mock', tasks: [{ id: 'a', title: 'A', prompt: 'p' }, { id: 'b', title: 'B', prompt: 'p' }] }, work);
    const real = orch.store.saveState.bind(orch.store);
    let writes = 0;
    orch.store.saveState = async (state) => {
      if (++writes === 3) throw new Error('disk full');
      return real(state);
    };
    const state = await orch.run();
    assert.equal(state.status, 'done');
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(join(orch.store.dir, 'state.json'), 'utf8')).status, 'done', 'later snapshots still land');
  });
});

describe('what a failed call does to the task record', () => {
  const OVERLOAD = { ok: false, text: OVERLOADED };

  it('keeps the real failure, the attempt count and the replan when the planner cannot be reached', async () => {
    const repo = await makeRepo();
    const { orch } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', maxReplans: 1, maxAttempts: 1, verify: ['node check.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] },
      (o) => (/You are the planner for a team of coding agents/.test(o.prompt) ? OVERLOAD : { files: { 'a.txt': 'bad\n' } }),
    );
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /Verification failed/);
    assert.match(state.tasks.a!.error!, /planner could not be reached/);
    assert.equal(state.tasks.a!.attempts, 1, 'the attempt the work used is still counted');
    assert.equal(state.replans ?? 0, 0, 'no replan happened, so none was spent');
  });

  it('stops retrying once a limit has been reached meanwhile', async () => {
    const repo = await makeRepo();
    const { orch, mock } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', budgetTokens: 1000, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] },
      () => ({ ...OVERLOAD, tokens: { input: 600, cached: 0, output: 600 } }),
      { retryDelaysMs: [1, 1, 1, 1] },
    );
    const state = await orch.run();
    assert.equal(mock.calls.length, 1, 'the first call used up the allowance, so it was not run again');
    assert.match(state.tasks.a!.error!, /agent unavailable/);
  });

  it('does not send the worker back when the reviewer ran out of time', async () => {
    const repo = await makeRepo();
    const { orch, mock } = orchestrator(
      repo,
      { goal: 'g', driver: 'mock', review: true, timeoutMin: 0.003, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] },
      (o) => (isReviewer(o) ? { delayMs: 20_000 } : work(o)),
    );
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /The reviewer was stopped after 0\.003 minutes/);
    assert.equal(mock.calls.filter((c) => !isReviewer(c)).length, 1, 'the worker was not run again');
  });
});
