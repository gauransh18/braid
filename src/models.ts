/**
 * Live model lists and connection tests for the providers that have an API. The desktop app runs these through
 * the bundled binary (`braid models`, `braid test-provider`), handing it the key in the environment, so the
 * Settings window never sees a key.
 */

export type Provider = 'claude' | 'codex' | 'gemini' | 'nim';
export const PROVIDERS: Provider[] = ['claude', 'codex', 'gemini', 'nim'];

interface Endpoint {
  label: string;
  keyEnv: string;
  /** Base URL env override, so tests and self-hosted gateways can point elsewhere. */
  baseEnv: string;
  defaultBase: string;
  /** Path of the model list, and the headers that authenticate it. */
  path: string;
  headers: (key: string) => Record<string, string>;
  /** Pull model ids out of the response and drop what is not a chat model. */
  parse: (body: any) => string[];
}

const NOT_CHAT = /embed|rerank|retriev|guard|safety|reward|parse|ocr|clip|tts|asr|speech|riva|translat|diffusion|flux|whisper|dall|image|moderation|audio|realtime|transcribe|search|vad|segment/i;

const ENDPOINTS: Record<Provider, Endpoint> = {
  claude: {
    label: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    baseEnv: 'BRAID_ANTHROPIC_BASE_URL',
    defaultBase: 'https://api.anthropic.com/v1',
    path: '/models?limit=100',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    parse: (b) => (b?.data ?? []).map((m: any) => String(m.id)).filter((id: string) => id.startsWith('claude')),
  },
  codex: {
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    baseEnv: 'BRAID_OPENAI_BASE_URL',
    defaultBase: 'https://api.openai.com/v1',
    path: '/models',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    // Newest names sort last alphabetically within a family, so reverse.
    parse: (b) =>
      (b?.data ?? [])
        .map((m: any) => String(m.id))
        .filter((id: string) => /^(gpt-|o\d|codex|chatgpt)/.test(id) && !NOT_CHAT.test(id))
        .sort()
        .reverse(),
  },
  gemini: {
    label: 'Google',
    keyEnv: 'GEMINI_API_KEY',
    baseEnv: 'BRAID_GEMINI_BASE_URL',
    defaultBase: 'https://generativelanguage.googleapis.com/v1beta',
    path: '/models?pageSize=200',
    headers: (key) => ({ 'x-goog-api-key': key }),
    parse: (b) =>
      (b?.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent') && /gemini/i.test(String(m.name)))
        .map((m: any) => String(m.name).replace(/^models\//, ''))
        .sort()
        .reverse(),
  },
  nim: {
    label: 'NVIDIA NIM',
    keyEnv: 'NVIDIA_API_KEY',
    baseEnv: 'BRAID_NIM_BASE_URL',
    defaultBase: 'https://integrate.api.nvidia.com/v1',
    path: '/models',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    parse: (b) =>
      (b?.data ?? [])
        .map((m: any) => String(m.id))
        .filter((id: string) => !NOT_CHAT.test(id))
        .sort(),
  },
};

export interface ModelsResult {
  provider: Provider;
  /** `live` came from the provider just now; `none` means nothing could be fetched (see `error`). */
  source: 'live' | 'none';
  models: string[];
  error?: string;
  ms?: number;
}

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export const isProvider = (s: string): s is Provider => (PROVIDERS as string[]).includes(s);

function base(p: Provider, env: Env): string {
  return (env[ENDPOINTS[p].baseEnv] ?? ENDPOINTS[p].defaultBase).replace(/\/$/, '');
}

function explain(p: Provider, status: number, detail: string): string {
  const label = ENDPOINTS[p].label;
  if (status === 401 || status === 403) return `${label} rejected the API key (HTTP ${status}).`;
  if (status === 429) return `${label} is rate limiting requests (HTTP 429). Try again in a moment.`;
  return `${label} answered HTTP ${status}${detail ? `: ${detail.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
}

export async function fetchModels(provider: Provider, env: Env = process.env, fetchImpl: Fetch = fetch): Promise<ModelsResult> {
  const ep = ENDPOINTS[provider];
  const key = env[ep.keyEnv];
  if (!key) return { provider, source: 'none', models: [], error: `No ${ep.label} API key set, so the live list is not available.` };
  const started = Date.now();
  try {
    const res = await fetchImpl(base(provider, env) + ep.path, { headers: ep.headers(key), signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) return { provider, source: 'none', models: [], error: explain(provider, res.status, text), ms: Date.now() - started };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { provider, source: 'none', models: [], error: `${ep.label} sent a reply that is not JSON.`, ms: Date.now() - started };
    }
    const models = [...new Set(ep.parse(body))];
    return { provider, source: 'live', models, ms: Date.now() - started };
  } catch (err) {
    return { provider, source: 'none', models: [], error: `Could not reach ${ep.label}: ${(err as Error).message}`, ms: Date.now() - started };
  }
}

export interface TestStep {
  name: string;
  ok: boolean;
  detail: string;
  ms?: number;
}
export interface TestResult {
  provider: Provider;
  ok: boolean;
  steps: TestStep[];
}

/**
 * Check that a provider works: a key is set, the API answers and accepts it, the chosen model exists, and (for
 * NIM, where braid drives the model itself) that the model accepts tool calls. The last step sends one tiny
 * request; the rest are free.
 */
export async function testProvider(provider: Provider, model: string | undefined, env: Env = process.env, fetchImpl: Fetch = fetch): Promise<TestResult> {
  const ep = ENDPOINTS[provider];
  const steps: TestStep[] = [];
  const done = (): TestResult => ({ provider, ok: steps.every((s) => s.ok), steps });
  const key = env[ep.keyEnv];
  if (!key) {
    steps.push({ name: 'API key', ok: false, detail: provider === 'nim' ? 'No NVIDIA API key is set. Save one first.' : `No API key set. That is fine if you use the ${provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Gemini'} CLI's own sign-in; there is nothing to test here.` });
    return done();
  }
  steps.push({ name: 'API key', ok: true, detail: 'A key is saved.' });

  const listed = await fetchModels(provider, env, fetchImpl);
  if (listed.source === 'none') {
    steps.push({ name: `Reach ${ep.label} and check the key`, ok: false, detail: listed.error ?? 'failed', ms: listed.ms });
    return done();
  }
  steps.push({ name: `Reach ${ep.label} and check the key`, ok: true, detail: `Connected. ${listed.models.length} models available.`, ms: listed.ms });

  if (model) {
    const found = listed.models.includes(model);
    steps.push({ name: 'Model is available', ok: found, detail: found ? model : `${model} is not in ${ep.label}'s list. Pick one from the list or check the spelling.` });
    if (!found) return done();
  }

  if (provider === 'nim') {
    const use = model || 'meta/llama-3.3-70b-instruct';
    const started = Date.now();
    try {
      const res = await fetchImpl(base(provider, env) + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: use,
          messages: [{ role: 'user', content: 'Call the ping tool.' }],
          tools: [{ type: 'function', function: { name: 'ping', description: 'Reply that the connection works.', parameters: { type: 'object', properties: {}, required: [] } } }],
          tool_choice: 'auto',
          max_tokens: 32,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      const ms = Date.now() - started;
      if (res.ok) steps.push({ name: 'Model answers and accepts tool calls', ok: true, detail: `${use} works with braid's tools.`, ms });
      else if (res.status === 400 && /tool|function/i.test(text)) steps.push({ name: 'Model answers and accepts tool calls', ok: false, detail: `${use} does not support tool calling, which braid needs. Pick another model.`, ms });
      else steps.push({ name: 'Model answers and accepts tool calls', ok: false, detail: explain(provider, res.status, text), ms });
    } catch (err) {
      steps.push({ name: 'Model answers and accepts tool calls', ok: false, detail: `Could not reach ${ep.label}: ${(err as Error).message}` });
    }
  }
  return done();
}
