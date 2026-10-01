import type { AgentEvent, AgentResult } from '../types.js';
import { DRIVER_DEFAULT_MODEL, estimateCostUsd, sumUsage, type Usage } from '../pricing.js';
import { streamLines } from '../proc.js';
import type { Driver, DriverRunOptions } from './driver.js';

/**
 * Gemini CLI in headless mode: `gemini -p "" -o stream-json`, prompt over stdin.
 * Event shapes were read from the gemini-cli 0.53 source; NOT yet exercised against a signed-in install.
 *
 * Tool control is coarser than Claude's: workers run in `auto_edit` (file edits auto-approved, anything
 * else, including shell, is denied because nobody can answer a prompt) and reviewers in `plan` (read-only).
 * `allowedTools` and `maxTurns` are therefore ignored. Gemini reports tokens, not dollars, so spend is
 * estimated from list prices (see pricing.ts); it is approximate, and 0 for models with no known price.
 *
 * Gemini reports token counts only in the final `result` event (0.53 emits init, message, tool_use, tool_result,
 * error and result; nothing carries usage before that). A call that is stopped, or that dies, before the result
 * therefore has no figures from the CLI, and braid estimates them from what streamed: see GeminiStreamParser.
 */
export class GeminiDriver implements Driver {
  readonly name = 'gemini';

  constructor(private readonly bin = process.env.BRAID_GEMINI_BIN ?? 'gemini') {}

  buildArgs(opts: DriverRunOptions): string[] {
    // `-p ""` switches to headless mode; the real prompt is appended from stdin.
    const args = ['-p', '', '-o', 'stream-json', '--skip-trust'];
    args.push('--approval-mode', opts.canEdit ? 'auto_edit' : 'plan');
    if (opts.model) args.push('--model', opts.model);
    return args;
  }

  async run(opts: DriverRunOptions): Promise<AgentResult> {
    const parser = new GeminiStreamParser(opts.model);
    const emit = (e: AgentEvent) => opts.onEvent?.(e);

    let exit: { code: number; stderr: string };
    try {
      exit = await streamLines(
        this.bin,
        this.buildArgs(opts),
        { cwd: opts.cwd, input: opts.prompt, signal: opts.signal, wrap: opts.wrap },
        (line) => {
          for (const e of parser.feed(line)) if (e.kind !== 'result') emit(e);
        },
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err;
      // Stopped: report what the call used so far, like the Claude and Codex drivers.
      return parser.aborted();
    }

    const res = parser.finish(exit.code, exit.stderr);
    emit({ kind: 'result', ...res });
    return res;
  }
}

/** Stateful because Gemini streams the answer as deltas and only reports success at the very end. */
export class GeminiStreamParser {
  constructor(private readonly requestedModel?: string) {}

  private sessionId?: string;
  private model?: string;
  private usage: Usage[] = [];
  /** Assistant text since the last tool call: the final answer, not the narration between tools. */
  private answer = '';
  private status?: 'success' | 'error';
  private errorText = '';
  /** The CLI's `result` event carried token counts, so `usage` is what it reported and not an estimate. */
  private reported = false;
  /** Characters the model was sent (the prompt, tool output) and generated (answer text, tool call arguments). */
  private charsIn = 0;
  private charsOut = 0;

  feed(line: string): AgentEvent[] {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return [{ kind: 'raw', line }];
    }
    switch (msg.type) {
      case 'init':
        this.sessionId = msg.session_id;
        this.model = msg.model;
        return [{ kind: 'start', sessionId: msg.session_id, model: msg.model }];
      case 'message':
        if (typeof msg.content === 'string') {
          if (msg.role === 'user') this.charsIn += msg.content.length;
          else if (msg.role === 'assistant') this.charsOut += msg.content.length;
        }
        if (msg.role !== 'assistant' || typeof msg.content !== 'string') return [];
        this.answer = msg.delta ? this.answer + msg.content : msg.content;
        return [{ kind: 'text', text: msg.content }];
      case 'tool_use':
        this.charsOut += JSON.stringify(msg.parameters ?? '').length;
        this.answer = '';
        return [{ kind: 'tool', name: String(msg.tool_name ?? 'tool'), input: msg.parameters }];
      case 'tool_result': {
        const isError = msg.status === 'error';
        this.charsIn += String((isError ? msg.error?.message : msg.output) ?? '').length;
        const preview = String((isError ? msg.error?.message : msg.output) ?? '').slice(0, 300);
        return [{ kind: 'tool_result', isError, preview }];
      }
      case 'error':
        if (msg.severity === 'error') this.errorText += `${msg.message ?? ''}\n`;
        return [];
      case 'result':
        this.status = msg.status === 'success' ? 'success' : 'error';
        this.usage = usageFromStats(msg.stats, this.model ?? this.requestedModel);
        this.reported = !!msg.stats && typeof msg.stats === 'object';
        if (msg.error?.message) this.errorText += `${msg.error.message}\n`;
        return [];
      default:
        return [];
    }
  }

  finish(exitCode: number, stderr: string): AgentResult {
    const ok = exitCode === 0 && this.status === 'success';
    const text = ok ? this.answer.trim() : [this.answer.trim(), this.errorText.trim(), stderr.trim().slice(-1500)].filter(Boolean).join('\n');
    // What Gemini itself reported, apart from the agent's answer that opens `text`.
    const error = ok ? undefined : [this.errorText.trim(), stderr.trim().slice(-1500)].filter(Boolean).join('\n') || undefined;
    const usage = this.usageSoFar();
    return { ok, text: text || `gemini exited ${exitCode} without a result`, costUsd: estimateCostUsd(usage, this.requestedModel ?? DRIVER_DEFAULT_MODEL.gemini), tokens: sumUsage(usage), costEstimated: true, sessionId: this.sessionId, ...(error ? { error } : {}) };
  }

  /** The result of a call that was stopped: what it had used so far, which for Gemini is mostly an estimate. */
  aborted(): AgentResult {
    const usage = this.usageSoFar();
    return { ok: false, text: 'aborted', costUsd: estimateCostUsd(usage, this.requestedModel ?? DRIVER_DEFAULT_MODEL.gemini), tokens: sumUsage(usage), costEstimated: true, sessionId: this.sessionId };
  }

  /**
   * The CLI's own figures when its result event had them, otherwise an ESTIMATE from what streamed, at about 4
   * characters per token (a rule of thumb for English text and code, not a tokenizer): the prompt and tool output
   * count as fresh input, the answer text and tool call arguments as output. Each turn re-sends the whole
   * conversation, mostly from cache, so only the new content is counted once. The real figure is higher: reasoning
   * tokens and the CLI's own system prompt and tool definitions never stream. Good enough for the token limit to see
   * most of what a killed call cost. Only for a call that ended without a successful result: one that succeeded and
   * reported nothing is left at zero.
   */
  private usageSoFar(): Usage[] {
    // A call that finished successfully and carried no figures is not "a call that was cut off": the CLI stopped
    // reporting usage (a renamed field, say). That has to stay visible as zero tokens, as the weekly canary looks
    // for exactly that, and not be covered by a number that only resembles the real one.
    if (this.reported || this.status === 'success') return this.usage;
    return [{ model: this.model ?? this.requestedModel, input: Math.ceil(this.charsIn / CHARS_PER_TOKEN), cached: 0, output: Math.ceil(this.charsOut / CHARS_PER_TOKEN) }];
  }
}

const CHARS_PER_TOKEN = 4;

/** `stats.models` maps model name to token counts; `input_tokens` includes cached, `input` does not. */
export function usageFromStats(stats: any, fallbackModel?: string): Usage[] {
  const models = stats?.models;
  if (models && typeof models === 'object' && Object.keys(models).length) {
    return Object.entries<any>(models).map(([model, m]) => {
      const cached = Number(m.cached ?? 0);
      return { model, input: Number(m.input ?? Math.max(0, Number(m.input_tokens ?? 0) - cached)), cached, output: Number(m.output_tokens ?? 0) };
    });
  }
  if (!stats) return [];
  const cached = Number(stats.cached ?? 0);
  return [{ model: fallbackModel, input: Number(stats.input ?? Math.max(0, Number(stats.input_tokens ?? 0) - cached)), cached, output: Number(stats.output_tokens ?? 0) }];
}
