import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isRetired, NIM_PREFERRED_MODELS } from '../nim.js';
import { DRIVER_DEFAULT_MODEL, estimateCostUsd, sumUsage, type Usage } from '../pricing.js';
import { shell } from '../proc.js';
import type { AgentEvent, AgentResult } from '../types.js';
import type { Driver, DriverRunOptions } from './driver.js';

export interface OpenAICompatConfig {
  /** Driver name in plans, e.g. "nim". */
  name: string;
  /** Up to and including `/v1`. */
  baseUrl: string;
  /** Environment variable holding the API key. Read at run time, so Settings can change it without a restart. */
  keyEnv: string;
  /** Model used when the plan and Settings name none, if `resolveModel` does not choose one. */
  defaultModel: string;
  /**
   * Chooses a model that works right now when none was named, and a replacement when the one in use turns out to be
   * retired (`avoid` lists it). For a hosted service that retires models, this is better than a name written down.
   */
  resolveModel?: (key: string, signal?: AbortSignal, avoid?: string[]) => Promise<string>;
  /** Human name for error messages, e.g. "NVIDIA NIM". */
  label?: string;
  /** Base delay between retries of rate-limit and server errors. Tests shorten it. */
  retryDelayMs?: number;
  /** How long a request may go without a single byte arriving (the service queued it, or hung) before it is abandoned. Default 180 s. */
  requestTimeoutMs?: number;
  /** The longest one answer may take, however steadily it arrives. Default 20 minutes. */
  totalTimeoutMs?: number;
  /**
   * Most tokens one reply may have. Sent on every request, because a hosted endpoint's own default is small (NVIDIA's
   * can cut a drafted plan off in the middle of its JSON). Halved and retried when the endpoint says it is too many.
   */
  maxTokens?: number;
}

/** Reasoning models put their thinking in the reply as <think>...</think> (or only the closing tag); the answer is what follows. */
export function stripThinking(text: string, trim = true): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const close = t.lastIndexOf('</think>');
  if (close >= 0) t = t.slice(close + '</think>'.length);
  t = t.replace(/<think>[\s\S]*$/i, '');
  return trim ? t.trim() : t;
}

/**
 * A coding agent for any OpenAI-compatible chat API (NVIDIA NIM first; OpenRouter, Ollama or LM Studio work the
 * same way). Unlike the CLI drivers there is no agent program to launch, so braid runs the loop itself: send the
 * conversation with tool definitions, run the tool calls the model asks for inside the worktree, repeat until the
 * model answers without calling a tool.
 *
 * Tools follow the plan's `allowedTools` like the other drivers: Read, Glob and Grep give the read tools, Edit and
 * Write the file-changing ones, `Bash(...)` a command runner. A reviewer or planner (canEdit false) only ever
 * gets the read tools. All paths are confined to the worktree.
 */
/** An answer from the service that is final: something to report as it is, not to retry. */
export class ApiError extends Error {}

/** The service says the model has been taken down (HTTP 410, or 404 with a retirement notice). */
export class RetiredModelError extends ApiError {
  constructor(
    readonly model: string,
    message: string,
  ) {
    super(message);
  }
}

export class OpenAICompatDriver implements Driver {
  readonly name: string;

  constructor(private readonly cfg: OpenAICompatConfig) {
    this.name = cfg.name;
  }

  async run(opts: DriverRunOptions): Promise<AgentResult> {
    const label = this.cfg.label ?? this.cfg.name;
    const emit = (e: AgentEvent) => opts.onEvent?.(e);
    const finish = (ok: boolean, text: string, usage: Usage[] = [], model?: string, fromProvider = false): AgentResult => {
      const costUsd = estimateCostUsd(usage, model);
      const res: AgentResult = { ok, text, costUsd, tokens: sumUsage(usage), costEstimated: true, ...(fromProvider && !ok ? { error: text } : {}) };
      emit({ kind: 'result', ...res });
      return res;
    };

    const key = process.env[this.cfg.keyEnv];
    if (!key) return finish(false, `${this.cfg.keyEnv} is not set. Add your ${label} API key in Braid > Settings.`);

    let model = opts.model;
    if (!model) {
      try {
        model = this.cfg.resolveModel ? await this.cfg.resolveModel(key, opts.signal) : this.cfg.defaultModel;
      } catch (err) {
        if (opts.signal?.aborted) return finish(false, 'aborted');
        return finish(false, (err as Error).message, [], undefined, true);
      }
    }
    let switched = false;
    /** An answer that the reply limit cut off, and how many times it has been asked to go on. */
    let carry = '';
    let continuations = 0;
    const tools = toolsFor(opts);
    const messages: any[] = [
      { role: 'system', content: systemPrompt(opts.canEdit, tools.some((t) => t.function.name === 'run_command')) },
      { role: 'user', content: opts.prompt },
    ];
    const usage: Usage[] = [];
    /** Tokens the endpoint already holds from the previous turn (its prompt and its reply), unknown before the first. */
    let seen: number | undefined;
    const maxTurns = opts.maxTurns ?? 40;
    emit({ kind: 'start', model });

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (opts.signal?.aborted) return finish(false, 'aborted', usage, model);
      // The last turn takes away the tools and says so: a model that has been reading files all along (a planner in a big
      // repository, say) must then answer with what it has, instead of the run ending with no answer at all.
      const lastTurn = turn === maxTurns && maxTurns > 1;
      if (lastTurn) messages.push({ role: 'user', content: 'You have used almost all of your turns. Do not call any more tools. Give your final answer now, with what you have found.' });
      const useTools = tools.length > 0 && !lastTurn;
      let reply: any;
      try {
        reply = await this.chat(key, { model, messages, tools: useTools ? tools : undefined, tool_choice: useTools ? 'auto' : undefined, temperature: 0.2, max_tokens: this.cfg.maxTokens ?? 8192 }, opts.signal);
      } catch (err) {
        // The service took the model down since it was chosen (usually a name saved in Settings long ago): use one that
        // works instead of failing every run, and say so, once.
        if (err instanceof RetiredModelError && this.cfg.resolveModel && !switched) {
          try {
            const next = await this.cfg.resolveModel(key, opts.signal, [model]);
            emit({ kind: 'text', text: `${this.cfg.label ?? this.cfg.name} has retired ${model}. Using ${next} for this run; change the model in Braid > Settings to stop seeing this.` });
            model = next;
            switched = true;
            turn--; // this turn never got an answer: redo it with the new model
            continue;
          } catch (fallback) {
            return finish(false, `${(err as Error).message} No replacement could be chosen: ${(fallback as Error).message}`, usage, model, true);
          }
        }
        return finish(false, (err as Error).message, usage, model, true);
      }
      const u = reply.usage;
      if (u) {
        const prompt = Number(u.prompt_tokens ?? 0);
        const completion = Number(u.completion_tokens ?? 0);
        const reported = u.prompt_tokens_details?.cached_tokens;
        // Every turn re-sends the whole conversation, and an endpoint that does not say how much of it came from cache
        // would have us count that conversation as fresh input again each turn. So when `cached_tokens` is missing, only
        // what is new since the previous turn counts as fresh (this turn's prompt less the last turn's prompt and
        // reply, never below 0) and the rest as cached. An approximation: a provider that does not cache bills the
        // whole prompt, and the template overhead and tool results of a turn are only roughly told apart.
        const cached = typeof reported === 'number' && Number.isFinite(reported) ? reported : seen === undefined ? 0 : Math.min(prompt, seen);
        usage.push({ model, input: Math.max(0, prompt - cached), cached, output: completion });
        seen = prompt + completion;
      } else seen = undefined;
      const message = reply.choices?.[0]?.message;
      if (!message) return finish(false, `${label} returned no message: ${JSON.stringify(reply).slice(0, 300)}`, usage, model);
      // Untrimmed, so that the pieces of an answer that was cut off join without losing a space at the seam.
      const spoken = stripThinking(typeof message.content === 'string' ? message.content : '', false);
      const said = spoken.trim();
      if (said) emit({ kind: 'text', text: said });
      messages.push({ role: 'assistant', content: spoken || null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });

      const calls: any[] = message.tool_calls ?? [];
      if (!calls.length) {
        const why = String(reply.choices?.[0]?.finish_reason ?? '');
        if (why === 'length') {
          // The reply hit the output limit. A plan or a review is JSON that is useless cut in half, so ask the model to
          // carry on, a few times, and join the pieces.
          if (continuations++ >= 4) return finish(false, `${label}'s answer kept hitting the reply limit (${this.cfg.maxTokens ?? 8192} tokens) and is still not finished. Pick a model that answers more briefly in Braid > Settings.`, usage, model);
          carry += spoken;
          messages.push({ role: 'user', content: 'Your answer was cut off at the output limit. Continue exactly where it stopped. Do not repeat anything and do not add commentary.' });
          continue;
        }
        const answer = (carry + spoken).trim();
        if (!answer) return finish(false, `${label} answered with nothing${why ? ` (finish reason: ${why})` : ''}. A model that thinks at length can use up the whole reply limit before it writes its answer; pick another model in Braid > Settings.`, usage, model, true);
        return finish(true, answer, usage, model);
      }

      for (const call of calls) {
        const name = String(call.function?.name ?? '');
        let args: any = {};
        let result: { ok: boolean; text: string };
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          emit({ kind: 'tool', name, input: args });
          result = tools.some((t) => t.function.name === name)
            ? await runTool(name, args, opts)
            : { ok: false, text: `Tool "${name}" is not available here. Available: ${tools.map((t) => t.function.name).join(', ') || 'none'}.` };
        } catch (err) {
          result = { ok: false, text: err instanceof SyntaxError ? `Could not parse the arguments as JSON: ${(err as Error).message}` : String((err as Error).message ?? err) };
        }
        emit({ kind: 'tool_result', isError: !result.ok, preview: result.text.slice(0, 300) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.text.slice(0, MAX_TOOL_OUTPUT) });
      }
    }
    return finish(false, `Stopped after ${maxTurns} turns without a final answer. Raise maxTurns in the plan, or split the task.`, usage, model);
  }

  /** Set when an endpoint turned down `stream`, so later requests do not ask for it. */
  private noStream = false;
  /** Set when an endpoint turned down `stream_options` (which asks for the token counts at the end of a stream). */
  private noStreamUsage = false;

  /**
   * One chat completion. The reply is streamed, so the time limit is on silence (`requestTimeoutMs`) and not on the whole
   * answer: a large model writing a long plan can take minutes and still be perfectly well, which a limit on the whole
   * request mistook for a hang. A cap on the total (`totalTimeoutMs`) still stops one that never ends. The chunks are
   * put back together into the reply a plain request would have returned, so nothing else has to know.
   */
  private async chat(key: string, body: any, signal?: AbortSignal): Promise<any> {
    const label = this.cfg.label ?? this.cfg.name;
    const delay = this.cfg.retryDelayMs ?? 1500;
    const idleMs = this.cfg.requestTimeoutMs ?? 180_000;
    const totalMs = this.cfg.totalTimeoutMs ?? 20 * 60_000;
    let lastError = '';
    let timeouts = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(delay * attempt, signal);
      const ours = new AbortController();
      let idle: NodeJS.Timeout | undefined;
      const hearing = () => {
        clearTimeout(idle);
        idle = setTimeout(() => ours.abort(new Error('silent')), idleMs);
      };
      const total = setTimeout(() => ours.abort(new Error('total')), totalMs);
      const stop = () => {
        clearTimeout(idle);
        clearTimeout(total);
      };
      let heardAnything = false;
      try {
        const payload = this.noStream ? body : { ...body, stream: true, ...(this.noStreamUsage ? {} : { stream_options: { include_usage: true } }) };
        hearing();
        const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(payload),
          signal: signal ? AbortSignal.any([signal, ours.signal]) : ours.signal,
        });
        if (res.ok && res.body && /text\/event-stream/i.test(res.headers.get('content-type') ?? '')) {
          const reply = await readStream(res.body, () => {
            heardAnything = true;
            hearing();
          });
          stop();
          return reply;
        }
        const text = await res.text();
        stop();
        if (res.ok) {
          // A server that ignored `stream` and sent the whole reply at once.
          try {
            return JSON.parse(text);
          } catch {
            throw new ApiError(`${label} sent a reply that is not JSON: ${text.slice(0, 200)}`);
          }
        }
        const detail = text.slice(0, 400).replace(/\s+/g, ' ');
        if (res.status === 429 || res.status >= 500) {
          lastError = `${label} is busy or failing (HTTP ${res.status}): ${detail}`;
          continue;
        }
        if (res.status === 401 || res.status === 403) throw new ApiError(`${label} rejected the API key (HTTP ${res.status}). Check it in Braid > Settings.`);
        if (isRetired(res.status, text)) {
          const gone = String(body.model ?? 'that model');
          throw new RetiredModelError(gone, `${label} has retired the model ${gone} (HTTP ${res.status}): ${detail}. Pick another in Braid > Settings, or leave the model empty so braid chooses one that works.`);
        }
        if (res.status === 404) throw new ApiError(`${label} does not know that model or endpoint (HTTP 404): ${detail}`);
        if (res.status === 400 && !this.noStreamUsage && /stream_options|include_usage/i.test(detail)) {
          this.noStreamUsage = true; // streams without the closing token counts
          continue;
        }
        if (res.status === 400 && !this.noStream && /\bstream\b/i.test(detail)) {
          this.noStream = true; // this endpoint wants plain requests
          continue;
        }
        const wanted = body.max_tokens as number | undefined;
        if (res.status === 400 && wanted && wanted > 1024 && /max_tokens|max_completion_tokens|maximum context|context length|context window/i.test(detail)) {
          // The endpoint (or this model) allows fewer reply tokens than asked for: ask for half, and try again.
          body.max_tokens = Math.floor(wanted / 2);
          lastError = `${label} refused max_tokens ${wanted} (HTTP 400): ${detail}`;
          continue;
        }
        if (res.status === 400 && /tool|function/i.test(detail)) {
          throw new ApiError(`${label} refused the request, probably because this model does not support tool calling (HTTP 400): ${detail}. Pick another model in Settings.`);
        }
        throw new ApiError(`${label} error (HTTP ${res.status}): ${detail}`);
      } catch (err) {
        stop();
        if (signal?.aborted) throw new Error('aborted');
        // Our own timers fired: nothing arrived for a while, or the answer went on for too long.
        if (ours.signal.aborted) {
          const capped = (ours.signal.reason as Error | undefined)?.message === 'total';
          lastError = capped
            ? `${label} was still answering after ${Math.round(totalMs / 60_000)} minutes, so it was stopped. Pick a faster model in Settings.`
            : heardAnything
              ? `${label} started to answer and then went silent for ${Math.round(idleMs / 1000)} s. The service may be overloaded; try again or pick another model in Settings.`
              : `${label} did not answer within ${Math.round(idleMs / 1000)} s. The model may be queued or too large for the hosted service; try again or pick a smaller model in Settings.`;
          // A model that sat silent for the whole timeout will usually do it again; do not stall a run for minutes retrying.
          if (capped || ++timeouts >= 2) throw new Error(lastError);
          continue;
        }
        // Everything thrown above on purpose (a rejected key, a retired model, an unusable reply) is already a message.
        if (err instanceof ApiError) throw err;
        lastError = `Could not reach ${label}: ${(err as Error).message}`;
        continue;
      }
    }
    throw new Error(lastError || `${label} did not answer`);
  }
}

/**
 * Put a chat completion stream (server-sent events) back together as one reply: the text, the tool calls (their names and
 * arguments arrive in pieces, keyed by index), the finish reason, and the token counts when the server sends them.
 * `heard` runs on every chunk that arrives, so the caller can tell a quiet connection from a slow answer.
 */
export async function readStream(body: ReadableStream<Uint8Array>, heard: () => void = () => undefined): Promise<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finish: string | undefined;
  let usage: unknown;
  const calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];

  const apply = (json: any) => {
    if (json.error) throw new ApiError(`NVIDIA NIM error (stream): ${String(json.error.message ?? JSON.stringify(json.error)).slice(0, 300)}`);
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? choice.message ?? {};
    if (typeof delta.content === 'string') content += delta.content;
    for (const piece of delta.tool_calls ?? []) {
      const at = Number.isInteger(piece.index) ? piece.index : calls.length;
      const call = (calls[at] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.function.name += piece.function.name;
      if (piece.function?.arguments) call.function.arguments += piece.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  let ended = false;
  while (!ended) {
    const { value, done } = await reader.read();
    if (done) break;
    heard();
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') {
        ended = true;
        break;
      }
      try {
        apply(JSON.parse(data));
      } catch (err) {
        if (err instanceof SyntaxError) continue; // a keep-alive or a half chunk: the next one carries on
        throw err;
      }
    }
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  return { choices: [{ message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage };
}

// ---------------------------------------------------------------- tools

const MAX_TOOL_OUTPUT = 20_000;
const MAX_FILE_BYTES = 200_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.braid']);

interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

const def = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const str = (description: string) => ({ type: 'string', description });

const READ_FILE = def('read_file', 'Read a text file. Paths are relative to the worktree root.', { path: str('File path') }, ['path']);
const LIST_FILES = def(
  'list_files',
  'List files under a directory, recursively (skips .git and node_modules). Use `contains` to filter by a substring of the path.',
  { dir: str('Directory, default "."'), contains: str('Only paths containing this text') },
  [],
);
const SEARCH = def('search', 'Search file contents with a JavaScript regular expression. Returns path:line: text.', { pattern: str('Regular expression'), dir: str('Directory, default "."') }, ['pattern']);
const WRITE_FILE = def('write_file', 'Create or overwrite a file with the given full content.', { path: str('File path'), content: str('Full file content') }, ['path', 'content']);
const EDIT_FILE = def(
  'edit_file',
  'Replace text in a file. `old_string` must match exactly once unless replace_all is true.',
  { path: str('File path'), old_string: str('Exact text to replace'), new_string: str('Replacement text'), replace_all: { type: 'boolean' } },
  ['path', 'old_string', 'new_string'],
);
const RUN_COMMAND = def('run_command', 'Run a shell command in the worktree root and return its output. Only certain commands are allowed.', { command: str('The command line') }, ['command']);

/** Which tools this run may use: the plan's allowedTools, and never anything that changes things for a read-only agent. */
function toolsFor(opts: DriverRunOptions): ToolDef[] {
  const allowed = opts.allowedTools;
  const has = (n: string) => allowed.includes(n);
  const out: ToolDef[] = [];
  if (has('Read')) out.push(READ_FILE);
  if (has('Glob')) out.push(LIST_FILES);
  if (has('Grep')) out.push(SEARCH);
  if (opts.canEdit) {
    if (has('Write')) out.push(WRITE_FILE);
    if (has('Edit')) out.push(EDIT_FILE);
    if (allowed.some((t) => t === 'Bash' || t.startsWith('Bash('))) out.push(RUN_COMMAND);
  }
  return out;
}

function systemPrompt(canEdit: boolean, canRun: boolean): string {
  return [
    'You are a coding agent working inside a git worktree. The current directory is the repository root, and every path you use is relative to it.',
    canEdit
      ? 'Use the tools to read the code and make the change the task asks for. Keep the change small and consistent with the surrounding code. Do not run git commands and do not commit; the harness does that.'
      : 'You can only read. Use the tools to look at the code, then answer.',
    canRun ? 'Run the project\'s checks with run_command before you finish when the task says to.' : '',
    'Call tools as needed, one step at a time. When you are done, reply without calling a tool: a short summary of what you did and anything left undone. If the task asks for a specific output format, reply in exactly that format.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Resolve `p` inside `cwd`, refusing anything that leaves it (`..`, absolute paths, symlinks out). */
async function inside(cwd: string, p: unknown): Promise<string> {
  if (typeof p !== 'string' || !p) throw new Error('a path is required');
  const abs = resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`"${p}" is outside the worktree`);
  const root = await realpath(cwd);
  // Follow symlinks on the deepest part that exists, then compare.
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      const back = relative(root, real);
      if (back.startsWith('..') || isAbsolute(back)) throw new Error(`"${p}" resolves outside the worktree`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\')) throw new Error('the .git directory is off limits');
  return abs;
}

async function* walk(dir: string, cwd: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, cwd);
    else if (entry.isFile()) yield relative(cwd, full);
  }
}

async function runTool(name: string, args: any, opts: DriverRunOptions): Promise<{ ok: boolean; text: string }> {
  const cwd = opts.cwd;
  switch (name) {
    case 'read_file': {
      const file = await inside(cwd, args.path);
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) return { ok: false, text: `${args.path} is ${info.size} bytes; too large to read whole. Use search to find the part you need.` };
      return { ok: true, text: await readFile(file, 'utf8') };
    }
    case 'list_files': {
      const dir = await inside(cwd, args.dir || '.');
      const contains = typeof args.contains === 'string' ? args.contains : '';
      const files: string[] = [];
      for await (const f of walk(dir, cwd)) {
        if (!contains || f.includes(contains)) files.push(f);
        if (files.length >= 1000) break;
      }
      return { ok: true, text: files.join('\n') || '(no files)' };
    }
    case 'search': {
      let re: RegExp;
      try {
        re = new RegExp(String(args.pattern), 'm');
      } catch (err) {
        return { ok: false, text: `Invalid regular expression: ${(err as Error).message}` };
      }
      const dir = await inside(cwd, args.dir || '.');
      const hits: string[] = [];
      for await (const f of walk(dir, cwd)) {
        const info = await stat(join(cwd, f));
        if (info.size > 500_000) continue;
        const text = await readFile(join(cwd, f), 'utf8').catch(() => '');
        if (text.includes('\0')) continue;
        text.split('\n').forEach((line, i) => {
          if (hits.length < 200 && re.test(line)) hits.push(`${f}:${i + 1}: ${line.slice(0, 200)}`);
        });
        if (hits.length >= 200) break;
      }
      return { ok: true, text: hits.join('\n') || 'no matches' };
    }
    case 'write_file': {
      const file = await inside(cwd, args.path);
      if (typeof args.content !== 'string') return { ok: false, text: 'content must be a string' };
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, args.content);
      return { ok: true, text: `wrote ${args.path} (${args.content.length} characters)` };
    }
    case 'edit_file': {
      const file = await inside(cwd, args.path);
      const before = await readFile(file, 'utf8');
      const oldText = String(args.old_string ?? '');
      if (!oldText) return { ok: false, text: 'old_string must not be empty' };
      const count = before.split(oldText).length - 1;
      if (count === 0) return { ok: false, text: `old_string was not found in ${args.path}. Read the file again and copy the text exactly.` };
      if (count > 1 && !args.replace_all) return { ok: false, text: `old_string appears ${count} times in ${args.path}. Include more surrounding text so it matches once, or set replace_all.` };
      await writeFile(file, before.split(oldText).join(String(args.new_string ?? '')));
      return { ok: true, text: `edited ${args.path} (${count} replacement${count > 1 ? 's' : ''})` };
    }
    case 'run_command': {
      const command = String(args.command ?? '').trim();
      if (!command) return { ok: false, text: 'command is empty' };
      if (!commandAllowed(command, opts.allowedTools)) {
        return { ok: false, text: `That command is not allowed. Allowed: ${opts.allowedTools.filter((t) => t.startsWith('Bash')).join(', ')}` };
      }
      return runCommand(command, cwd, opts);
    }
    default:
      return { ok: false, text: `unknown tool ${name}` };
  }
}

/** `Bash` allows anything; `Bash(cmd)` an exact command; `Bash(cmd:*)` or `Bash(cmd *)` a command and its arguments. */
export function commandAllowed(command: string, allowedTools: string[]): boolean {
  return allowedTools.some((t) => {
    if (t === 'Bash') return true;
    const m = /^Bash\((.*)\)$/.exec(t);
    if (!m) return false;
    const pattern = m[1]!.trim();
    if (pattern.endsWith(':*') || pattern.endsWith(' *')) {
      const prefix = pattern.slice(0, -2).trim();
      return command === prefix || command.startsWith(prefix + ' ');
    }
    return command === pattern;
  });
}

async function runCommand(command: string, cwd: string, opts: DriverRunOptions): Promise<{ ok: boolean; text: string }> {
  // Inside a container when the plan sandboxes the agent; otherwise on the host in the worktree. Through the same
  // helper as setup and verify, so Stop, the time limit and quitting braid reach everything the command started.
  const spec = opts.wrap ? opts.wrap({ cmd: 'sh', args: ['-c', command] }) : undefined;
  const res = await shell(command, cwd, 120_000, spec, opts.signal);
  const out = res.stdout + res.stderr;
  const tail = out.length > 8000 ? `...${out.slice(-8000)}` : out;
  if (res.timedOut) return { ok: false, text: `The command was stopped after 120 seconds.\n${tail}` };
  return { ok: res.code === 0, text: `exit code ${res.code}\n${tail}` };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

/** Where braid looks first for a NIM model; the one used is chosen at run time (see src/nim.ts). */
export const NIM_DEFAULT_MODEL = NIM_PREFERRED_MODELS[0]!;
DRIVER_DEFAULT_MODEL.nim = NIM_DEFAULT_MODEL;
