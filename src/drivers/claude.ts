import type { AgentEvent, AgentResult } from '../types.js';
import { streamLines } from '../proc.js';
import type { TokenUsage } from '../types.js';
import type { Driver, DriverRunOptions } from './driver.js';

const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

/**
 * Claude Code in headless mode: `claude -p --output-format stream-json`.
 * The prompt goes over stdin so no shell quoting is involved on any platform.
 */
export class ClaudeDriver implements Driver {
  readonly name = 'claude';

  constructor(private readonly bin = process.env.BRAID_CLAUDE_BIN ?? 'claude') {}

  buildArgs(opts: DriverRunOptions): string[] {
    // Ignore the operator's personal settings, plugins, hooks and MCP servers so a plan behaves
    // the same on every teammate's machine. Repo settings and CLAUDE.md still apply; auth is untouched.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local', '--strict-mcp-config'];
    args.push('--permission-mode', opts.canEdit ? 'acceptEdits' : 'default');
    const allowed = opts.canEdit ? opts.allowedTools : opts.allowedTools.filter((t) => !WRITE_TOOLS.includes(t));
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    if (!opts.canEdit) args.push('--disallowedTools', WRITE_TOOLS.join(','));
    if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));
    if (opts.model) args.push('--model', opts.model);
    return args;
  }

  async run(opts: DriverRunOptions): Promise<AgentResult> {
    let result: AgentResult | undefined;
    const emit = (e: AgentEvent) => opts.onEvent?.(e);

    const { code, stderr } = await streamLines(
      this.bin,
      this.buildArgs(opts),
      { cwd: opts.cwd, input: opts.prompt, signal: opts.signal, wrap: opts.wrap },
      (line) => {
        for (const e of parseClaudeLine(line)) {
          if (e.kind === 'result') result = { ok: e.ok, text: e.text, costUsd: e.costUsd, tokens: e.tokens, sessionId: e.sessionId };
          emit(e);
        }
      },
    );

    if (!result) {
      return { ok: false, text: `claude exited ${code} without a result. ${stderr.trim().slice(-2000)}`, costUsd: 0 };
    }
    return result;
  }
}

/** Map one stream-json line to normalized events. Unknown shapes pass through as raw. */
export function parseClaudeLine(line: string): AgentEvent[] {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return [{ kind: 'raw', line }];
  }
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init' ? [{ kind: 'start', sessionId: msg.session_id, model: msg.model }] : [];
    case 'assistant': {
      const out: AgentEvent[] = [];
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text) out.push({ kind: 'text', text: block.text });
        if (block.type === 'tool_use') out.push({ kind: 'tool', name: block.name, input: block.input });
      }
      return out;
    }
    case 'user': {
      const out: AgentEvent[] = [];
      for (const block of msg.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        out.push({ kind: 'tool_result', isError: !!block.is_error, preview: content.slice(0, 300) });
      }
      return out;
    }
    case 'result':
      return [
        {
          kind: 'result',
          ok: msg.subtype === 'success' && !msg.is_error,
          text: typeof msg.result === 'string' ? msg.result : String(msg.subtype ?? ''),
          costUsd: Number(msg.total_cost_usd ?? 0),
          tokens: claudeTokens(msg.usage),
          sessionId: msg.session_id,
          turns: msg.num_turns,
        },
      ];
    default:
      return [];
  }
}

/** Claude bills cache writes like fresh input, so they count as `input`; cache reads are `cached`. */
export function claudeTokens(usage: any): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  return {
    input: Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0),
    cached: Number(usage.cache_read_input_tokens ?? 0),
    output: Number(usage.output_tokens ?? 0),
  };
}
