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
  /**
   * `live`: the provider's own API, just now. `cli`: model names found inside the installed agent program (no key
   * needed, refreshes when the program is updated). `none`: nothing could be fetched (see `error`).
   */
  source: 'live' | 'cli' | 'none';
  models: string[];
  error?: string;
  ms?: number;
  /** For `cli`: the program that was read. */
  from?: string;
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
  if (!key) {
    // No key, so no API to ask. The installed CLI still knows which models it supports.
    const scanned = await scanInstalledCli(provider, env);
    if (scanned) return scanned;
    return { provider, source: 'none', models: [], error: provider === 'nim' ? 'Add an NVIDIA API key to load the live model list.' : `No ${ep.label} API key set and the CLI was not found, so there is no list to load.` };
  }
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
    if (provider === 'nim') {
      steps.push({ name: 'API key', ok: false, detail: 'No NVIDIA API key is set. Save one first.' });
      return done();
    }
    // A CLI provider without a key signs in through its own program; check that the program is there.
    const found = await scanInstalledCli(provider, env);
    const program = await findProgram(CLI_BIN[provider]!.name, env);
    if (!program) {
      steps.push({ name: 'Program found', ok: false, detail: `The ${CLI_BIN[provider]!.name} program was not found on this machine, and no API key is set. Install it or add a key.` });
      return done();
    }
    steps.push({ name: 'Program found', ok: true, detail: `${program}${found ? ` (knows ${found.models.length} model names)` : ''}` });
    steps.push({ name: 'Sign-in (not tested)', ok: true, detail: `No API key is set, so braid uses the program's own sign-in, which cannot be checked from here. If a run says you are not signed in, run ${CLI_BIN[provider]!.name} once in a terminal.` });
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


// ------------------------------------------------ names inside an installed CLI

const CLI_BIN: Partial<Record<Provider, { name: string; env: string }>> = {
  claude: { name: 'claude', env: 'BRAID_CLAUDE_BIN' },
  codex: { name: 'codex', env: 'BRAID_CODEX_BIN' },
  gemini: { name: 'gemini', env: 'BRAID_GEMINI_BIN' },
};

/** What to look for in each CLI. A name is only taken when nothing model-name-like follows it, which drops dated and variant suffixes. */
const SCAN: Partial<Record<Provider, RegExp>> = {
  claude: /claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d{1,2})?(?![\d-])/g,
  codex: /gpt-\d+(?:\.\d+)?(?:-[a-z]+)*(?![a-z0-9.-])/g,
  gemini: /gemini-\d+(?:\.\d+)?-(?:pro|flash-lite|flash)(?:-preview)?(?![a-z0-9.-])/g,
};

async function findProgram(name: string, env: Env): Promise<string | null> {
  const { access, realpath } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { delimiter, isAbsolute, join } = await import('node:path');
  const override = env[CLI_BIN[Object.keys(CLI_BIN).find((k) => CLI_BIN[k as Provider]!.name === name) as Provider]!.env];
  const candidates = override && isAbsolute(override) ? [override] : (env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, name));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return await realpath(c);
    } catch {
      /* next */
    }
  }
  return null;
}

/** Read a file in pieces and collect regex matches, without holding a 200 MB program in memory. */
async function scanFile(file: string, re: RegExp, into: Set<string>): Promise<void> {
  const { open } = await import('node:fs/promises');
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const chunk = 8 * 1024 * 1024;
    const overlap = 128; // a name cut by a chunk boundary is still seen whole in the next read
    const buf = Buffer.alloc(chunk + overlap);
    for (let pos = 0; pos < size; pos += chunk) {
      const { bytesRead } = await handle.read(buf, 0, chunk + overlap, pos);
      for (const m of buf.toString('latin1', 0, bytesRead).matchAll(re)) into.add(m[0]);
    }
  } finally {
    await handle.close();
  }
}

/** Newest first: higher version numbers win, then the larger family (pro before flash, opus before sonnet). */
function newestFirst(a: string, b: string): number {
  const nums = (s: string) => (s.replace(/^[a-z]+-/, '').match(/\d+/g) ?? []).map(Number);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? -1) - (x[i] ?? -1);
    if (d) return d;
  }
  const rank = (s: string) => ['fable', 'opus', 'sonnet', 'haiku', 'pro', 'flash-lite', 'flash', 'codex', 'max'].findIndex((f) => s.includes(f));
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * Model names embedded in the installed agent program. This is what that version of the CLI knows about, so it
 * follows the CLI when it updates. It is a best guess: names can be retired on the provider's side.
 */
export async function scanInstalledCli(provider: Provider, env: Env = process.env): Promise<ModelsResult | null> {
  const cli = CLI_BIN[provider];
  const re = SCAN[provider];
  if (!cli || !re) return null;
  const started = Date.now();
  const program = await findProgram(cli.name, env);
  if (!program) return null;
  const { dirname, join } = await import('node:path');
  const { readdir } = await import('node:fs/promises');
  const files = [program];
  // The Gemini CLI is a JavaScript bundle: its names live in the sibling chunk files.
  if (provider === 'gemini') {
    const dir = dirname(program);
    const chunks = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.js')).map((f) => join(dir, f));
    if (chunks.length) files.splice(0, files.length, ...chunks);
  }
  const found = new Set<string>();
  try {
    for (const f of files) await scanFile(f, new RegExp(re.source, 'g'), found);
  } catch {
    return null;
  }
  let models = [...found];
  if (provider === 'codex') models = models.filter((m) => Number(/gpt-(\d+)/.exec(m)?.[1]) >= 5);
  models.sort(newestFirst);
  if (!models.length) return null;
  return { provider, source: 'cli', models: models.slice(0, 16), from: program, ms: Date.now() - started };
}
