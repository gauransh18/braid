import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { commandAllowed, OpenAICompatDriver } from '../src/drivers/openai-compat.js';
import type { DriverRunOptions } from '../src/drivers/driver.js';
import type { AgentEvent } from '../src/types.js';

const KEY_ENV = 'BRAID_TEST_NIM_KEY';
const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

interface Recorded {
  auth?: string;
  body: any;
}
/** A ready-made API reply body, or {status, body} to control the status, or a function of the request. */
type Reply = { status?: number; body: unknown } | { choices: unknown; usage?: unknown } | ((req: Recorded, n: number) => { status?: number; body: unknown });

/** A stand-in for the chat completions endpoint that answers from a script and records what it was sent. */
async function fakeApi(replies: Reply[]): Promise<{ url: string; seen: Recorded[]; close: () => Promise<void> }> {
  const seen: Recorded[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const rec = { auth: req.headers.authorization, body: JSON.parse(raw || '{}') };
      seen.push(rec);
      const r = replies[Math.min(seen.length - 1, replies.length - 1)]!;
      const resolved = typeof r === 'function' ? r(rec, seen.length - 1) : r;
      const { status = 200, body } = 'choices' in resolved ? { status: 200, body: resolved } : resolved;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

const say = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) => ({ choices: [{ message: { role: 'assistant', content } }], usage });
const call = (name: string, args: unknown, id = 'c1', usage = { prompt_tokens: 100, completion_tokens: 20 }) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  usage,
});

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'braid-oai-'));
  temps.push(dir);
  writeFileSync(join(dir, 'a.txt'), 'hello world\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.js'), 'const x = 1;\nconst y = 2;\n');
  return dir;
}

async function run(url: string, opts: Partial<DriverRunOptions> & { cwd: string }, retryDelayMs = 1) {
  const events: AgentEvent[] = [];
  const driver = new OpenAICompatDriver({ name: 'nim', label: 'NVIDIA NIM', baseUrl: url, keyEnv: KEY_ENV, defaultModel: 'default-model', retryDelayMs });
  const res = await driver.run({ prompt: 'do the thing', allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], canEdit: true, onEvent: (e) => events.push(e), ...opts });
  return { res, events };
}

describe('openai-compatible driver', () => {
  before(() => {
    process.env[KEY_ENV] = 'test-key-not-real';
  });
  afterEach(() => {
    process.env[KEY_ENV] = 'test-key-not-real';
  });
  after(() => {
    delete process.env[KEY_ENV];
  });

  it('runs a tool loop: writes and edits files inside the worktree, then answers', async () => {
    const api = await fakeApi([
      call('write_file', { path: 'src/new.js', content: 'export const n = 1;\n' }, 'c1'),
      call('edit_file', { path: 'src/main.js', old_string: 'const y = 2;', new_string: 'const y = 3;' }, 'c2'),
      call('read_file', { path: 'src/main.js' }, 'c3'),
      say('Added new.js and bumped y to 3.'),
    ]);
    try {
      const cwd = worktree();
      const { res, events } = await run(api.url, { cwd, model: 'meta/llama-3.3-70b-instruct' });
      assert.equal(res.ok, true);
      assert.equal(res.text, 'Added new.js and bumped y to 3.');
      assert.equal(readFileSync(join(cwd, 'src', 'new.js'), 'utf8'), 'export const n = 1;\n');
      assert.equal(readFileSync(join(cwd, 'src', 'main.js'), 'utf8'), 'const x = 1;\nconst y = 3;\n');
      // Request shape: bearer key, requested model, tool definitions, and the tool results fed back.
      assert.equal(api.seen[0]!.auth, 'Bearer test-key-not-real');
      assert.equal(api.seen[0]!.body.model, 'meta/llama-3.3-70b-instruct');
      assert.deepEqual(api.seen[0]!.body.tools.map((t: any) => t.function.name).sort(), ['edit_file', 'list_files', 'read_file', 'search', 'write_file']);
      const last = api.seen.at(-1)!.body.messages;
      assert.equal(last.at(-1).role, 'tool');
      assert.match(last.at(-1).content, /const y = 3;/);
      // Events and usage
      assert.deepEqual(events.filter((e) => e.kind === 'tool').map((e) => (e as { name: string }).name), ['write_file', 'edit_file', 'read_file']);
      assert.deepEqual(res.tokens, { input: 400, cached: 0, output: 80 });
      assert.equal(res.costEstimated, true);
      assert.equal(events.at(-1)!.kind, 'result');
    } finally {
      await api.close();
    }
  });

  it('confines every path to the worktree, including symlinks and .git', async () => {
    const api = await fakeApi([
      call('write_file', { path: '../escape.txt', content: 'x' }, 'c1'),
      call('write_file', { path: '/tmp/braid-abs-escape.txt', content: 'x' }, 'c2'),
      call('read_file', { path: 'link/secret.txt' }, 'c3'),
      call('write_file', { path: '.git/hooks/pre-commit', content: 'x' }, 'c4'),
      say('done'),
    ]);
    try {
      const cwd = worktree();
      const outside = mkdtempSync(join(tmpdir(), 'braid-oai-outside-'));
      temps.push(outside);
      writeFileSync(join(outside, 'secret.txt'), 'top secret');
      symlinkSync(outside, join(cwd, 'link'));
      const { res, events } = await run(api.url, { cwd });
      assert.equal(res.ok, true);
      const results = events.filter((e) => e.kind === 'tool_result') as { isError: boolean; preview: string }[];
      assert.equal(results.length, 4);
      assert.ok(results.every((r) => r.isError), 'all four were refused');
      assert.match(results[0]!.preview, /outside the worktree/);
      assert.match(results[2]!.preview, /outside the worktree/);
      assert.match(results[3]!.preview, /\.git/);
      assert.equal(existsSync(join(cwd, '..', 'escape.txt')), false);
      assert.equal(existsSync('/tmp/braid-abs-escape.txt'), false);
    } finally {
      await api.close();
    }
  });

  it('refuses ambiguous edits and tells the model why', async () => {
    const api = await fakeApi([call('edit_file', { path: 'a.txt', old_string: 'o', new_string: '0' }, 'c1'), call('edit_file', { path: 'a.txt', old_string: 'nope', new_string: 'x' }, 'c2'), say('gave up')]);
    try {
      const cwd = worktree();
      const { events } = await run(api.url, { cwd });
      const errs = events.filter((e) => e.kind === 'tool_result') as { preview: string }[];
      assert.match(errs[0]!.preview, /appears 2 times/);
      assert.match(errs[1]!.preview, /not found/);
      assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'hello world\n', 'file untouched');
    } finally {
      await api.close();
    }
  });

  it('gives read-only agents only the read tools, and refuses a write they try anyway', async () => {
    const api = await fakeApi([call('write_file', { path: 'x.txt', content: 'x' }), say('{"approve": true, "issues": []}')]);
    try {
      const cwd = worktree();
      const { res, events } = await run(api.url, { cwd, canEdit: false, allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] });
      assert.deepEqual(api.seen[0]!.body.tools.map((t: any) => t.function.name).sort(), ['list_files', 'read_file', 'search']);
      assert.equal(existsSync(join(cwd, 'x.txt')), false);
      assert.match((events.find((e) => e.kind === 'tool_result') as { preview: string }).preview, /not available/);
      assert.equal(res.text, '{"approve": true, "issues": []}');
    } finally {
      await api.close();
    }
  });

  it('runs commands only when the plan allows them, in the worktree', async () => {
    const api = await fakeApi([call('run_command', { command: 'echo hi from $(pwd | xargs basename)' }, 'c1'), call('run_command', { command: 'rm -rf /' }, 'c2'), say('ok')]);
    try {
      const cwd = worktree();
      const { events } = await run(api.url, { cwd, allowedTools: ['Read', 'Bash(echo:*)'] });
      const results = events.filter((e) => e.kind === 'tool_result') as { isError: boolean; preview: string }[];
      assert.equal(results[0]!.isError, false);
      assert.match(results[0]!.preview, /exit code 0/);
      assert.equal(results[1]!.isError, true);
      assert.match(results[1]!.preview, /not allowed/);
      // Without any Bash entry the tool is not even offered.
      const api2 = await fakeApi([say('fine')]);
      await run(api2.url, { cwd, allowedTools: ['Read'] });
      assert.ok(!api2.seen[0]!.body.tools.some((t: any) => t.function.name === 'run_command'));
      await api2.close();
    } finally {
      await api.close();
    }
  });

  it('matches Bash permission patterns', () => {
    assert.equal(commandAllowed('npm test', ['Bash']), true);
    assert.equal(commandAllowed('npm test', ['Bash(npm test)']), true);
    assert.equal(commandAllowed('npm test --silent', ['Bash(npm test)']), false);
    assert.equal(commandAllowed('npm test --silent', ['Bash(npm test:*)']), true);
    assert.equal(commandAllowed('npm testing', ['Bash(npm test:*)']), false, 'prefix must end at a word boundary');
    assert.equal(commandAllowed('git push', ['Read', 'Bash(npm run *)']), false);
    assert.equal(commandAllowed('npm run lint', ['Bash(npm run *)']), true);
  });

  it('reports a missing key, a rejected key and an unsupported model in plain words', async () => {
    delete process.env[KEY_ENV];
    const none = await run('http://127.0.0.1:1/v1', { cwd: worktree() });
    assert.equal(none.res.ok, false);
    assert.match(none.res.text, /BRAID_TEST_NIM_KEY is not set.*Settings/);

    process.env[KEY_ENV] = 'k';
    const denied = await fakeApi([{ status: 401, body: { error: 'bad key' } }]);
    const noTools = await fakeApi([{ status: 400, body: { error: 'This model does not support tools' } }]);
    try {
      const a = await run(denied.url, { cwd: worktree() });
      assert.equal(a.res.ok, false);
      assert.match(a.res.text, /rejected the API key.*Settings/);
      assert.equal(denied.seen.length, 1, 'a bad key is not retried');
      const b = await run(noTools.url, { cwd: worktree(), model: 'some/model' });
      assert.match(b.res.text, /does not support tool calling.*another model/);
    } finally {
      await denied.close();
      await noTools.close();
    }
  });

  it('reports a model that never answers as slow, not as a connection failure', async () => {
    const silent = createServer(() => undefined); // accepts the request, never replies
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(silent.address() as { port: number }).port}/v1`;
    try {
      const events: AgentEvent[] = [];
      const driver = new OpenAICompatDriver({ name: 'nim', label: 'NVIDIA NIM', baseUrl: url, keyEnv: KEY_ENV, defaultModel: 'm', retryDelayMs: 1, requestTimeoutMs: 100 });
      const started = Date.now();
      const res = await driver.run({ prompt: 'p', cwd: worktree(), allowedTools: ['Read'], canEdit: true, onEvent: (e) => events.push(e) });
      assert.ok(Date.now() - started < 1500, 'gave up after one retry instead of four');
      assert.equal(res.ok, false);
      assert.match(res.text, /NVIDIA NIM did not answer within/);
      assert.match(res.text, /smaller model/);
    } finally {
      silent.closeAllConnections();
      await new Promise((r) => silent.close(r));
    }
  });

  it('retries rate limits and server errors, then succeeds', async () => {
    const api = await fakeApi([{ status: 429, body: 'slow down' }, { status: 503, body: 'try later' }, { body: say('finally') }]);
    try {
      const { res } = await run(api.url, { cwd: worktree() });
      assert.equal(res.ok, true);
      assert.equal(res.text, 'finally');
      assert.equal(api.seen.length, 3);
    } finally {
      await api.close();
    }
  });

  it('stops at the turn cap, and counts cached tokens separately', async () => {
    const api = await fakeApi([
      (_r, n) => ({ body: call('list_files', {}, `c${n}`, { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600 } } as never) }),
    ]);
    try {
      const { res } = await run(api.url, { cwd: worktree(), maxTurns: 3 });
      assert.equal(res.ok, false);
      assert.match(res.text, /Stopped after 3 turns/);
      assert.equal(api.seen.length, 3);
      assert.deepEqual(res.tokens, { input: 1200, cached: 1800, output: 30 });
    } finally {
      await api.close();
    }
  });

  it('tells the model when its tool arguments are not valid JSON', async () => {
    const api = await fakeApi([
      { body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{not json' } }] } }] } },
      say('sorry'),
    ]);
    try {
      const { events } = await run(api.url, { cwd: worktree() });
      assert.match((events.find((e) => e.kind === 'tool_result') as { preview: string }).preview, /parse the arguments/);
    } finally {
      await api.close();
    }
  });
});
