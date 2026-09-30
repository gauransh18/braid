import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
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
after(() => servers.forEach((s) => s.close()));

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
    assert.match(none.error!, /No NVIDIA NIM API key set/);

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

  it('for CLI providers only checks the key and connection, and explains the no-key case', async () => {
    const server = await api(() => ({ body: { data: [{ id: 'claude-sonnet-5-5' }] } }));
    const ok = await testProvider('claude', 'claude-sonnet-5-5', envFor('claude', server.url));
    assert.equal(ok.ok, true);
    assert.equal(server.seen.length, 1, 'only the free model list was requested');

    const none = await testProvider('claude', undefined, {});
    assert.equal(none.ok, false);
    assert.match(none.steps[0]!.detail, /own sign-in/);
  });
});
