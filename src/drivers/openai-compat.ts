import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  /** Model used when the plan and Settings name none. */
  defaultModel: string;
  /** Human name for error messages, e.g. "NVIDIA NIM". */
  label?: string;
  /** Base delay between retries of rate-limit and server errors. Tests shorten it. */
  retryDelayMs?: number;
  /** How long one request may take before it is abandoned. Default 180 s. */
  requestTimeoutMs?: number;
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

    const model = opts.model || this.cfg.defaultModel;
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
      let reply: any;
      try {
        reply = await this.chat(key, { model, messages, tools: tools.length ? tools : undefined, tool_choice: tools.length ? 'auto' : undefined, temperature: 0.2 }, opts.signal);
      } catch (err) {
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
      if (typeof message.content === 'string' && message.content.trim()) emit({ kind: 'text', text: message.content });
      messages.push({ role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });

      const calls: any[] = message.tool_calls ?? [];
      if (!calls.length) return finish(true, String(message.content ?? '').trim(), usage, model);

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

  private async chat(key: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const label = this.cfg.label ?? this.cfg.name;
    const delay = this.cfg.retryDelayMs ?? 1500;
    const timeoutMs = this.cfg.requestTimeoutMs ?? 180_000;
    let lastError = '';
    let timeouts = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(delay * attempt, signal);
      let res: Response;
      try {
        res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (signal?.aborted) throw new Error('aborted');
        const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
        lastError = timedOut
          ? `${label} did not answer within ${Math.round(timeoutMs / 1000)} s. The model may be queued or too large for the hosted service; try again or pick a smaller model in Settings.`
          : `Could not reach ${label}: ${(err as Error).message}`;
        // A model that sat silent for the whole timeout will usually do it again; do not stall a run for minutes retrying.
        if (timedOut && ++timeouts >= 2) throw new Error(lastError);
        continue;
      }
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`${label} sent a reply that is not JSON: ${text.slice(0, 200)}`);
        }
      }
      const detail = text.slice(0, 400).replace(/\s+/g, ' ');
      if (res.status === 429 || res.status >= 500) {
        lastError = `${label} is busy or failing (HTTP ${res.status}): ${detail}`;
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error(`${label} rejected the API key (HTTP ${res.status}). Check it in Braid > Settings.`);
      if (res.status === 404) throw new Error(`${label} does not know that model or endpoint (HTTP 404): ${detail}`);
      if (res.status === 400 && /tool|function/i.test(detail)) {
        throw new Error(`${label} refused the request, probably because this model does not support tool calling (HTTP 400): ${detail}. Pick another model in Settings.`);
      }
      throw new Error(`${label} error (HTTP ${res.status}): ${detail}`);
    }
    throw new Error(lastError || `${label} did not answer`);
  }
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

export const NIM_DEFAULT_MODEL = 'meta/llama-3.3-70b-instruct';
DRIVER_DEFAULT_MODEL.nim = NIM_DEFAULT_MODEL;
