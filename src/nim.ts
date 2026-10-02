import { createHash } from 'node:crypto';

/**
 * Which NVIDIA NIM model to use when nobody named one.
 *
 * NVIDIA retires hosted models without notice (the one braid used to hard-code, meta/llama-3.3-70b-instruct, now
 * answers 410 Gone), so no name written down here stays right. These are the models braid knows to be built for tool
 * calling, best first; the one actually used is the first that the live model list still has AND that accepts a tool
 * call right now (a tiny request), and the answer is remembered for the life of the process. Names that are gone are
 * simply skipped, so an old name in this list costs nothing.
 */
export const NIM_PREFERRED_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'mistralai/mistral-large-2-instruct',
  'nvidia/nemotron-nano-3-30b-a3b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'moonshotai/kimi-k2.6',
  'z-ai/glm-5.3',
  'deepseek-ai/deepseek-v4.1-flash',
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'meta/llama-3.1-70b-instruct',
];

type Fetch = typeof fetch;

export type ProbeResult = { ok: true } | { ok: false; kind: 'retired' | 'no-tools' | 'auth' | 'busy' | 'other'; detail: string };

/** True for the answers NIM gives for a model it has taken down. */
export function isRetired(status: number, body: string): boolean {
  return status === 410 || (status === 404 && /end of life|retired|no longer available|deprecated/i.test(body));
}

const short = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

/** Ask `model` for one tool call. It costs a few tokens, and tells apart a working model from a gone one or one without tools. */
export async function probeToolCalling(baseUrl: string, key: string, model: string, fetchImpl: Fetch = fetch, timeoutMs = 60_000, signal?: AbortSignal): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Call the ping tool.' }],
        tools: [{ type: 'function', function: { name: 'ping', description: 'Reply that the connection works.', parameters: { type: 'object', properties: {}, required: [] } } }],
        tool_choice: 'auto',
        max_tokens: 32,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
    return { ok: false, kind: 'busy', detail: timedOut ? `did not answer within ${Math.round(timeoutMs / 1000)} s` : (err as Error).message };
  }
  const text = await res.text();
  if (res.ok) return { ok: true };
  if (isRetired(res.status, text)) return { ok: false, kind: 'retired', detail: `retired (HTTP ${res.status}): ${short(text)}` };
  if (res.status === 401 || res.status === 403) return { ok: false, kind: 'auth', detail: `HTTP ${res.status}` };
  if (res.status === 429 || res.status >= 500) return { ok: false, kind: 'busy', detail: `busy or failing (HTTP ${res.status}): ${short(text)}` };
  if (res.status === 400 && /tool|function/i.test(text)) return { ok: false, kind: 'no-tools', detail: 'does not support tool calling' };
  return { ok: false, kind: 'other', detail: `HTTP ${res.status}: ${short(text)}` };
}

/** The ids NIM lists right now. Retired models are not in it. */
export async function listModelIds(baseUrl: string, key: string, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error(`NVIDIA NIM rejected the API key (HTTP ${res.status}). Check it in Braid > Settings.`);
  if (!res.ok) throw new Error(`NVIDIA NIM could not list its models (HTTP ${res.status}): ${short(text)}`);
  try {
    const data = (JSON.parse(text) as { data?: { id?: unknown }[] }).data ?? [];
    return data.map((m) => String(m.id ?? '')).filter(Boolean);
  } catch {
    throw new Error(`NVIDIA NIM sent a model list that is not JSON: ${short(text)}`);
  }
}

export interface PickOptions {
  baseUrl: string;
  key: string;
  fetchImpl?: Fetch;
  signal?: AbortSignal;
  /** Models not to choose again, e.g. one that has just turned out to be retired. */
  avoid?: string[];
  /** Per-request limit for the tool-call probes. */
  timeoutMs?: number;
  /** How many candidates to try before giving up. */
  maxProbes?: number;
}

export interface Pick {
  model: string;
  /** What was passed over on the way, and why. */
  skipped: { model: string; why: string }[];
}

const remembered = new Map<string, { model: string; at: number }>();
const REMEMBER_MS = 30 * 60_000;

/** For tests: forget what was chosen. */
export function forgetPickedModels(): void {
  remembered.clear();
}

/** The model to use when none was named: see NIM_PREFERRED_MODELS. Throws, with the reason, when none works. */
export async function pickNimModel(o: PickOptions): Promise<Pick> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const cacheKey = `${o.baseUrl}|${createHash('sha256').update(o.key).digest('hex').slice(0, 16)}`;
  const avoid = new Set(o.avoid ?? []);
  const hit = remembered.get(cacheKey);
  if (hit && Date.now() - hit.at < REMEMBER_MS && !avoid.has(hit.model)) return { model: hit.model, skipped: [] };

  const listed = await listModelIds(o.baseUrl, o.key, fetchImpl, o.signal);
  const candidates = NIM_PREFERRED_MODELS.filter((m) => listed.includes(m) && !avoid.has(m));
  if (!candidates.length) {
    const hint = listed.filter((id) => /instruct|nemotron|gpt-oss|kimi|glm|deepseek|mistral-large/i.test(id)).slice(0, 6);
    throw new Error(
      `NVIDIA NIM lists none of the models braid knows to handle tool calls. Pick one that supports tool calling in Braid > Settings${hint.length ? ` (for example ${hint.join(', ')})` : ''}.`,
    );
  }

  const skipped: Pick['skipped'] = [];
  for (const model of candidates.slice(0, o.maxProbes ?? 4)) {
    const probe = await probeToolCalling(o.baseUrl, o.key, model, fetchImpl, o.timeoutMs ?? 60_000, o.signal);
    if (probe.ok) {
      remembered.set(cacheKey, { model, at: Date.now() });
      return { model, skipped };
    }
    // A rejected key is the same for every model: say so instead of trying them all.
    if (probe.kind === 'auth') throw new Error(`NVIDIA NIM rejected the API key (${probe.detail}). Check it in Braid > Settings.`);
    skipped.push({ model, why: probe.detail });
  }
  throw new Error(`None of the models braid tries on NVIDIA NIM answered a tool call: ${skipped.map((s) => `${s.model} ${s.why}`).join('; ')}. Pick a model that supports tool calling in Braid > Settings, or try again in a moment.`);
}
