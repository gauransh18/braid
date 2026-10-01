import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { OpenAICompatDriver } from '../src/drivers/openai-compat.js';

const KEY_ENV = 'BRAID_TEST_TOKEN_ACCOUNTING_KEY';
const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

type Usage = { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: unknown };

/** A stand-in chat completions endpoint: turn n gets `usage(n)`, asks for a tool until `turns` are over, then answers. */
async function fakeApi(turns: number, usage: (n: number) => Usage | undefined): Promise<{ url: string; close: () => Promise<void> }> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const turn = n++;
      const message =
        turn < turns - 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: `c${turn}`, type: 'function', function: { name: 'list_files', arguments: '{}' } }] }
          : { role: 'assistant', content: 'done' };
      const u = usage(turn);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }], ...(u ? { usage: u } : {}) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) };
}

async function tokensFor(turns: number, usage: (n: number) => Usage | undefined) {
  const api = await fakeApi(turns, usage);
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'braid-nimtokens-'));
    temps.push(cwd);
    writeFileSync(join(cwd, 'a.txt'), 'hello\n');
    const driver = new OpenAICompatDriver({ name: 'nim', baseUrl: api.url, keyEnv: KEY_ENV, defaultModel: 'm', retryDelayMs: 1 });
    const res = await driver.run({ prompt: 'p', cwd, allowedTools: ['Glob'], canEdit: false });
    assert.equal(res.ok, true, res.text);
    return res.tokens!;
  } finally {
    await api.close();
  }
}

describe('openai-compatible driver: tokens when the endpoint does not report cached ones', () => {
  before(() => {
    process.env[KEY_ENV] = 'test-key-not-real';
  });
  afterEach(() => {
    process.env[KEY_ENV] = 'test-key-not-real';
  });
  after(() => {
    delete process.env[KEY_ENV];
  });

  it('counts the first turn in full and later turns only for what is new since the last', async () => {
    const prompts = [100, 160, 230];
    const completions = [20, 30, 10];
    const tokens = await tokensFor(3, (n) => ({ prompt_tokens: prompts[n]!, completion_tokens: completions[n]! }));
    // Turn 2: 160 - (100 + 20) = 40 fresh, 120 cached. Turn 3: 230 - (160 + 30) = 40 fresh, 190 cached.
    assert.deepEqual(tokens, { input: 100 + 40 + 40, cached: 120 + 190, output: 60 });
  });

  it('does not let a long conversation count itself again every turn', async () => {
    // 30 turns; each prompt is the last prompt and reply plus 40 tokens of tool output.
    const prompts: number[] = [1000];
    for (let n = 1; n < 30; n++) prompts.push(prompts[n - 1]! + 10 + 40);
    const tokens = await tokensFor(30, (n) => ({ prompt_tokens: prompts[n]!, completion_tokens: 10 }));
    const everyPrompt = prompts.reduce((a, b) => a + b, 0);
    assert.equal(tokens.input, 1000 + 29 * 40);
    assert.equal(tokens.input + tokens.cached, everyPrompt, 'every prompt token is counted once, as fresh or as cached');
    assert.equal(tokens.output, 300);
    assert.ok(tokens.input < everyPrompt / 20, 'the old sum of every prompt as fresh input is about 24 times larger');
  });

  it('never counts a negative amount of fresh input when a prompt is shorter than the last exchange', async () => {
    // The endpoint trimmed the conversation: turn 2 holds 50 tokens although 120 were already sent.
    const tokens = await tokensFor(2, (n) => ({ prompt_tokens: [100, 50][n]!, completion_tokens: 20 }));
    assert.deepEqual(tokens, { input: 100, cached: 50, output: 40 });
  });

  it('trusts an endpoint that does report cached tokens, including zero', async () => {
    const tokens = await tokensFor(3, (n) => ({ prompt_tokens: [100, 160, 230][n]!, completion_tokens: 20, prompt_tokens_details: { cached_tokens: [0, 0, 90][n]! } }));
    // The reported zero on turn 2 stands: the endpoint says nothing was cached, so all 160 are fresh.
    assert.deepEqual(tokens, { input: 100 + 160 + 140, cached: 90, output: 60 });
  });

  it('applies the estimate turn by turn when only some replies report cached tokens', async () => {
    const tokens = await tokensFor(3, (n) => ({ prompt_tokens: [100, 160, 230][n]!, completion_tokens: 20, ...(n === 1 ? { prompt_tokens_details: { cached_tokens: 100 } } : {}) }));
    // Turn 1 fresh 100. Turn 2 reports 100 cached: 60 fresh. Turn 3 reports nothing: 230 - (160 + 20) = 50 fresh, 180 cached.
    assert.deepEqual(tokens, { input: 100 + 60 + 50, cached: 100 + 180, output: 60 });
  });

  it('counts the turn after one with no usage in full', async () => {
    const tokens = await tokensFor(3, (n) => (n === 1 ? undefined : { prompt_tokens: [100, 0, 230][n]!, completion_tokens: 20 }));
    assert.deepEqual(tokens, { input: 100 + 230, cached: 0, output: 40 }, 'nothing is known about what turn 2 sent, so turn 3 is not discounted');
  });
});
