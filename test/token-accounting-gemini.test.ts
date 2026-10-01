import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { GeminiDriver, GeminiStreamParser } from '../src/drivers/gemini.js';
import { DriverRegistry } from '../src/drivers/driver.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const skipWindows = process.platform === 'win32' && 'stand-in agent is a shebang script';

// What the stand-in prints before it goes quiet: a 400-character prompt, a 40-character answer, a tool call
// whose arguments serialize to 12 characters, and an 80-character tool output.
const STREAM = [
  { type: 'init', session_id: 's1', model: 'gemini-2.5-pro' },
  { type: 'message', role: 'user', content: 'x'.repeat(400) },
  { type: 'message', role: 'assistant', content: 'y'.repeat(40), delta: true },
  { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { path: 'a' } },
  { type: 'tool_result', tool_id: 't1', status: 'success', output: 'z'.repeat(80) },
];
// About 4 characters a token: 480 characters in, 52 out.
const ESTIMATE = { input: 120, cached: 0, output: 13 };

const fakeGemini = (tail: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'braid-fakegemini-'));
  temps.push(dir);
  const file = join(dir, 'gemini');
  writeFileSync(file, `#!/usr/bin/env node\nconst out = (o) => console.log(JSON.stringify(o));\n${STREAM.map((e) => `out(${JSON.stringify(e)});`).join('\n')}\n${tail}\n`);
  chmodSync(file, 0o755);
  return file;
};

describe('gemini token usage when the CLI never reported any', () => {
  const streamed = () => {
    const p = new GeminiStreamParser();
    for (const e of STREAM) p.feed(JSON.stringify(e));
    return p;
  };

  it('estimates from what streamed: prompt and tool output as input, answer and tool arguments as output', () => {
    const res = streamed().aborted();
    assert.deepEqual(res.tokens, ESTIMATE);
    assert.equal(res.ok, false);
    assert.equal(res.text, 'aborted');
    assert.equal(res.sessionId, 's1');
    assert.equal(res.costEstimated, true);
    assert.ok(res.costUsd > 0, 'priced like the reported usage would be (gemini-2.5-pro is in the price table)');
  });

  it('uses the same estimate when the CLI dies without a result event', () => {
    const res = streamed().finish(1, 'boom');
    assert.equal(res.ok, false);
    assert.deepEqual(res.tokens, ESTIMATE);
  });

  it("prefers the CLI's own figures once its result event has them", () => {
    const p = streamed();
    p.feed(JSON.stringify({ type: 'result', status: 'success', stats: { models: { 'gemini-2.5-pro': { input_tokens: 300, cached: 100, input: 200, output_tokens: 50 } } } }));
    assert.deepEqual(p.finish(0, '').tokens, { input: 200, cached: 100, output: 50 });
    assert.deepEqual(p.aborted().tokens, { input: 200, cached: 100, output: 50 });
  });

  it('estimates for a call that ended in an error without figures, but not for a success that carries none', () => {
    const failed = streamed();
    failed.feed(JSON.stringify({ type: 'result', status: 'error', error: { message: 'quota' } }));
    assert.deepEqual(failed.finish(1, '').tokens, ESTIMATE, 'it did spend, and the CLI never said how much');

    // The CLI succeeded and stopped reporting usage (a renamed field): that must stay visible, not be papered over.
    const drifted = streamed();
    drifted.feed(JSON.stringify({ type: 'result', status: 'success', statistics: { models: { m: { input_tokens: 300, output_tokens: 50 } } } }));
    const res = drifted.finish(0, '');
    assert.equal(res.ok, true);
    assert.deepEqual(res.tokens, { input: 0, cached: 0, output: 0 });
  });

  it('counts nothing for a call that streamed nothing', () => {
    assert.deepEqual(new GeminiStreamParser().aborted().tokens, { input: 0, cached: 0, output: 0 });
  });
});

describe('gemini driver when it is stopped', () => {
  it('returns what the call used so far instead of throwing', { skip: skipWindows }, async () => {
    const bin = fakeGemini("process.on('SIGINT', () => process.exit(1));\nsetTimeout(() => {}, 30000);");
    const ac = new AbortController();
    let sawToolResult = false;
    const run = new GeminiDriver(bin).run({ prompt: 'p', cwd: tmpdir(), allowedTools: [], canEdit: false, signal: ac.signal, onEvent: (e) => e.kind === 'tool_result' && (sawToolResult = true) });
    while (!sawToolResult) await new Promise((r) => setTimeout(r, 25));
    ac.abort();
    const res = await run;
    assert.equal(res.ok, false);
    assert.equal(res.text, 'aborted');
    assert.deepEqual(res.tokens, ESTIMATE);
    assert.equal(res.costEstimated, true);
    assert.equal(res.sessionId, 's1');
  });

  it('still throws what is not an abort', async () => {
    await assert.rejects(new GeminiDriver(join(tmpdir(), 'braid-no-such-gemini')).run({ prompt: 'p', cwd: tmpdir(), allowedTools: [], canEdit: false }), /ENOENT|not found/i);
  });

  it('lets the token limit see a call that the time limit killed', { skip: skipWindows }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'braid-geminirepo-'));
    temps.push(dir);
    const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
    await git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), 'x\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'init');
    const bin = fakeGemini("process.on('SIGINT', () => process.exit(1));\nsetTimeout(() => {}, 30000);");
    // The stand-in streams 133 estimated tokens and then hangs until the 3 second call limit stops it. With an allowance
    // of 100 the task has no second attempt; with no figures from Gemini it would have had one.
    const orch = new Orchestrator({
      repo: await Git.toplevel(dir),
      plan: { goal: 'g', driver: 'gemini', timeoutMin: 0.05, taskBudgetTokens: 100, maxAttempts: 3, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] },
      drivers: new DriverRegistry().register(new GeminiDriver(bin)),
    });
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.match(state.tasks.a!.error!, /^token budget exhausted for this task \(133 fresh and output tokens used/);
    assert.equal(state.tasks.a!.attempts, 1);
    assert.deepEqual(state.tasks.a!.tokens, ESTIMATE);
    assert.equal(state.costEstimated, true);
  });
});
