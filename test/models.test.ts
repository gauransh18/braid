import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fetchModels, testProvider, type Provider } from '../src/models.js';

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}
type Handler = (req: Seen) => { status?: number; body: unknown };

const servers: { close: () => void }[] = [];
const temps: string[] = [];
after(() => {
  servers.forEach((s) => s.close());
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function api(handler: Handler): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body };
      seen.push(rec);
      const { status = 200, body: out } = handler(rec);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

const envFor = (provider: Provider, url: string, key = 'key-not-real') =>
  ({
    claude: { ANTHROPIC_API_KEY: key, BRAID_ANTHROPIC_BASE_URL: url },
    codex: { OPENAI_API_KEY: key, BRAID_OPENAI_BASE_URL: url },
    gemini: { GEMINI_API_KEY: key, BRAID_GEMINI_BASE_URL: url },
    nim: { NVIDIA_API_KEY: key, BRAID_NIM_BASE_URL: url },
  })[provider];

/** A directory on PATH holding fake agent programs whose bytes embed the given text. */
function programs(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'braid-cli-'));
  temps.push(dir);
  for (const [name, content] of Object.entries(files)) {
    // Windows finds programs through PATHEXT, so a fake agent needs an extension there.
    const file = process.platform === 'win32' ? `${name}.exe` : name;
    writeFileSync(join(dir, file), content);
    chmodSync(join(dir, file), 0o755);
  }
  return dir;
}

describe('live model lists', () => {
  it('reads each provider in its own format and authenticates the way that provider expects', async () => {
    const anthropic = await api(() => ({ body: { data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'not-claude' }] } }));
    const r1 = await fetchModels('claude', envFor('claude', anthropic.url));
    assert.deepEqual(r1.models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
    assert.equal(r1.source, 'live');
    assert.equal(anthropic.seen[0]!.headers['x-api-key'], 'key-not-real');
    assert.equal(anthropic.seen[0]!.headers['anthropic-version'], '2023-06-01');

    const openai = await api(() => ({ body: { data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.2-codex' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }, { id: 'gpt-image-1' }, { id: 'o4-mini' }, { id: 'dall-e-3' }] } }));
    const r2 = await fetchModels('codex', envFor('codex', openai.url));
    assert.deepEqual(r2.models, ['o4-mini', 'gpt-5.5', 'gpt-5.2-codex'], 'chat models only, newest names first');
    assert.equal(openai.seen[0]!.headers.authorization, 'Bearer key-not-real');

    const google = await api(() => ({
      body: { models: [
        { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
      ] },
    }));
    const r3 = await fetchModels('gemini', envFor('gemini', google.url));
    assert.deepEqual(r3.models, ['gemini-2.5-pro', 'gemini-2.5-flash']);
    assert.equal(google.seen[0]!.headers['x-goog-api-key'], 'key-not-real');
    assert.ok(!google.seen[0]!.url!.includes('key-not-real'), 'the key is a header, never in the URL');

    const nvidia = await api(() => ({ body: { data: [{ id: 'nvidia/llama-3.3-nemotron-super-49b-v1' }, { id: 'meta/llama-3.3-70b-instruct' }, { id: 'nvidia/nv-embedqa-e5-v5' }, { id: 'nvidia/llama-3.2-nv-rerankqa-1b-v2' }, { id: 'meta/llama-guard-4-12b' }] } }));
    const r4 = await fetchModels('nim', envFor('nim', nvidia.url + '/v1'));
    assert.deepEqual(r4.models, ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.3-nemotron-super-49b-v1'], 'embedding, reranking and guard models are dropped');
    assert.equal(nvidia.seen[0]!.url, '/v1/models');
  });

  it('says why nothing came back: no key, a rejected key, a broken reply, an unreachable server', async () => {
    const none = await fetchModels('nim', {});
    assert.equal(none.source, 'none');
    assert.match(none.error!, /Add an NVIDIA API key/);

    const denied = await api(() => ({ status: 401, body: { error: 'nope' } }));
    assert.match((await fetchModels('nim', envFor('nim', denied.url))).error!, /rejected the API key \(HTTP 401\)/);

    const limited = await api(() => ({ status: 429, body: 'slow' }));
    assert.match((await fetchModels('codex', envFor('codex', limited.url))).error!, /rate limiting/);

    const junk = await api(() => ({ body: 'this is not json' }));
    assert.match((await fetchModels('claude', envFor('claude', junk.url))).error!, /not JSON/);

    const down = await fetchModels('gemini', envFor('gemini', 'http://127.0.0.1:1'));
    assert.match(down.error!, /Could not reach Google/);
    assert.deepEqual(down.models, []);
  });
});

describe('provider test', () => {
  const nimApi = (chat: (body: any) => { status?: number; body: unknown }) =>
    api((req) => (req.url!.endsWith('/models') ? { body: { data: [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 'some/no-tools-model' }] } } : chat(JSON.parse(req.body))));

  it('passes when the key, the model and tool calling all work, sending one tiny request', async () => {
    const server = await nimApi(() => ({ body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }] } }));
    const res = await testProvider('nim', 'meta/llama-3.3-70b-instruct', envFor('nim', server.url + '/v1'));
    assert.equal(res.ok, true);
    assert.deepEqual(res.steps.map((s) => s.name), ['API key', 'Reach NVIDIA NIM and check the key', 'Model is available', 'Model answers and accepts tool calls']);
    const chat = server.seen.find((s) => s.url!.endsWith('/chat/completions'))!;
    const body = JSON.parse(chat.body);
    assert.equal(body.model, 'meta/llama-3.3-70b-instruct');
    assert.equal(body.max_tokens, 32);
    assert.equal(body.tools[0].function.name, 'ping');
    assert.equal(chat.headers.authorization, 'Bearer key-not-real');
  });

  it('flags a model without tool calling, an unknown model, and a rejected key', async () => {
    const noTools = await nimApi(() => ({ status: 400, body: { error: 'This model does not support tools' } }));
    const a = await testProvider('nim', 'some/no-tools-model', envFor('nim', noTools.url + '/v1'));
    assert.equal(a.ok, false);
    assert.match(a.steps.at(-1)!.detail, /does not support tool calling/);

    const unknown = await nimApi(() => ({ body: {} }));
    const b = await testProvider('nim', 'made/up-model', envFor('nim', unknown.url + '/v1'));
    assert.equal(b.ok, false);
    assert.match(b.steps.at(-1)!.detail, /not in NVIDIA NIM's list/);
    assert.ok(!unknown.seen.some((s) => s.url!.endsWith('/chat/completions')), 'no request is spent on a model that is not listed');

    const denied = await api(() => ({ status: 401, body: {} }));
    const c = await testProvider('nim', undefined, envFor('nim', denied.url));
    assert.equal(c.ok, false);
    assert.match(c.steps.at(-1)!.detail, /rejected the API key/);
  });

  it('says a model that does not answer in time is slow, not unreachable, and passes a slow-but-correct one', async () => {
    const hang = await nimApi(() => ({ body: new Promise(() => undefined) as never }));
    // A server that accepts the request and never replies.
    const silent = createServer((req, res) => {
      if (req.url!.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'big/slow-model' }] }));
      } // the chat request is left hanging
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    servers.push(silent);
    const url = `http://127.0.0.1:${(silent.address() as { port: number }).port}/v1`;
    const res = await testProvider('nim', 'big/slow-model', envFor('nim', url), fetch, 150);
    assert.equal(res.ok, false);
    const last = res.steps.at(-1)!;
    assert.match(last.detail, /reachable and listed big\/slow-model, but it did not answer within/);
    assert.match(last.detail, /pick a smaller model/);
    assert.ok(!/Could not reach/.test(last.detail), 'not reported as a connection failure');
    assert.ok(res.steps.slice(0, 3).every((s) => s.ok), 'the key, the connection and the model listing all passed');
    void hang;
  });

  it('for CLI providers only checks the key and connection, and explains the no-key case', async () => {
    const server = await api(() => ({ body: { data: [{ id: 'claude-sonnet-5-5' }] } }));
    const ok = await testProvider('claude', 'claude-sonnet-5-5', envFor('claude', server.url));
    assert.equal(ok.ok, true);
    assert.equal(server.seen.length, 1, 'only the free model list was requested');

    // No key: check the installed program instead, and be honest that sign-in cannot be tested.
    const installed = await testProvider('claude', undefined, { PATH: programs({ claude: Buffer.from('claude-opus-5-5 claude-sonnet-5') }) });
    assert.equal(installed.ok, true);
    assert.deepEqual(installed.steps.map((s) => s.name), ['Program found', 'Sign-in (not tested)']);
    assert.match(installed.steps[0]!.detail, /knows 2 model names/);
    assert.match(installed.steps[1]!.detail, /cannot be checked from here/);

    const absent = await testProvider('claude', undefined, { PATH: programs({}) });
    assert.equal(absent.ok, false);
    assert.match(absent.steps[0]!.detail, /not found on this machine/);
  });
});

describe('model names from an installed CLI (no key needed)', () => {
  const junk = (n: number) => Buffer.alloc(n, 0x7f);

  it('reads Claude Code names, newest first, ignoring dated and variant look-alikes', async () => {
    const bin = Buffer.concat([
      junk(10),
      Buffer.from('claude-opus-4-20250514 claude-opus-4-1-20250805-v1 claude-sonnet-4-5-20250929 '),
      junk(5),
      Buffer.from('\0claude-opus-5-5\0claude-sonnet-5\0claude-haiku-4-5\0claude-fable-5-1\0claude-opus-4-1\0claude-code-version'),
    ]);
    const res = await fetchModels('claude', { PATH: programs({ claude: bin }) });
    assert.equal(res.source, 'cli');
    assert.deepEqual(res.models, ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-1']);
    assert.match(res.from!, /claude(\.exe)?$/);
  });

  it('reads Codex gpt-5+ names and drops older models and file names', async () => {
    const bin = Buffer.concat([junk(8), Buffer.from('gpt-5.6\0gpt-5.6-sol\0gpt-5.3-codex\0gpt-4o\0gpt-4.1-mini\0gpt-5p6-sol.md\0codex-api\0gpt-5.1-codex-max\0gpt-5.2.md')]);
    const res = await fetchModels('codex', { PATH: programs({ codex: bin }) });
    assert.deepEqual(res.models, ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.3-codex', 'gpt-5.1-codex-max']);
  });

  // npm installs gemini as gemini.cmd on Windows, a shim with no bundle next to it, so this layout is Unix-only.
  it('reads the Gemini CLI from its bundle files and skips image, live and base variants', { skip: process.platform === 'win32' && 'npm shims on Windows do not sit next to the bundle' }, async () => {
    const dir = programs({});
    const bundle = join(dir, 'bundle');
    mkdirSync(bundle);
    writeFileSync(join(bundle, 'gemini.js'), '// entry\nconst a = "gemini-3.5-flash"; const b = "gemini-2.5-flash-image";');
    writeFileSync(join(bundle, 'chunk-1.js'), 'x = ["gemini-3.1-pro-preview","gemini-3-flash-base","gemini-2.5-pro","gemini-3.1-flash-live-preview","gemini-2.5-flash-lite"]');
    // The program on PATH is a link to the bundle entry, like an npm-installed CLI.
    const { symlinkSync } = await import('node:fs');
    mkdirSync(join(dir, 'bin'));
    symlinkSync(join(bundle, 'gemini.js'), join(dir, 'bin', 'gemini'));
    chmodSync(join(bundle, 'gemini.js'), 0o755);
    const res = await fetchModels('gemini', { PATH: join(dir, 'bin') });
    assert.equal(res.source, 'cli');
    assert.deepEqual(res.models, ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']);
  });

  it('finds a name that straddles the read boundary', async () => {
    const chunk = 8 * 1024 * 1024;
    const name = Buffer.from('claude-opus-5-5');
    const big = Buffer.concat([junk(chunk - 6), name, junk(1000)]); // the name starts 6 bytes before the boundary
    const res = await fetchModels('claude', { PATH: programs({ claude: big }) });
    assert.deepEqual(res.models, ['claude-opus-5-5']);
  });

  it('prefers the live API when a key is set, and says nothing was found when the CLI is absent', async () => {
    const server = await api(() => ({ body: { data: [{ id: 'claude-opus-9-9' }] } }));
    const withKey = await fetchModels('claude', { ...envFor('claude', server.url), PATH: programs({ claude: Buffer.from('claude-opus-5-5') }) });
    assert.equal(withKey.source, 'live');
    assert.deepEqual(withKey.models, ['claude-opus-9-9']);

    const missing = await fetchModels('codex', { PATH: programs({}) });
    assert.equal(missing.source, 'none');
    assert.match(missing.error!, /CLI was not found/);
    const nim = await fetchModels('nim', { PATH: programs({}) });
    assert.match(nim.error!, /Add an NVIDIA API key/);
  });
});
