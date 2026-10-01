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

    const { code, stderr } = await streamLines(
      this.bin,
      this.buildArgs(opts),
      { cwd: opts.cwd, input: opts.prompt, signal: opts.signal, wrap: opts.wrap },
      (line) => {
        for (const e of parser.feed(line)) if (e.kind !== 'result') emit(e);
      },
    );

    const res = parser.finish(code, stderr);
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
        if (msg.role !== 'assistant' || typeof msg.content !== 'string') return [];
        this.answer = msg.delta ? this.answer + msg.content : msg.content;
        return [{ kind: 'text', text: msg.content }];
      case 'tool_use':
        this.answer = '';
        return [{ kind: 'tool', name: String(msg.tool_name ?? 'tool'), input: msg.parameters }];
      case 'tool_result': {
        const isError = msg.status === 'error';
        const preview = String((isError ? msg.error?.message : msg.output) ?? '').slice(0, 300);
        return [{ kind: 'tool_result', isError, preview }];
      }
      case 'error':
        if (msg.severity === 'error') this.errorText += `${msg.message ?? ''}\n`;
        return [];
      case 'result':
        this.status = msg.status === 'success' ? 'success' : 'error';
        this.usage = usageFromStats(msg.stats, this.model ?? this.requestedModel);
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
    return { ok, text: text || `gemini exited ${exitCode} without a result`, costUsd: estimateCostUsd(this.usage, this.requestedModel ?? DRIVER_DEFAULT_MODEL.gemini), tokens: sumUsage(this.usage), costEstimated: true, sessionId: this.sessionId, ...(error ? { error } : {}) };
  }
}

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
