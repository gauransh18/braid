import type { AgentEvent, AgentResult } from '../types.js';
import { streamLines } from '../proc.js';
import type { Driver, DriverRunOptions } from './driver.js';

/**
 * Gemini CLI in headless mode: `gemini -p "" -o stream-json`, prompt over stdin.
 * Event shapes were read from the gemini-cli 0.53 source; NOT yet exercised against a signed-in install.
 *
 * Tool control is coarser than Claude's: workers run in `auto_edit` (file edits auto-approved, anything
 * else, including shell, is denied because nobody can answer a prompt) and reviewers in `plan` (read-only).
 * `allowedTools` and `maxTurns` are therefore ignored. Gemini reports tokens, not dollars, so spend is 0
 * and `budgetUsd` does not bind this driver.
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
    const parser = new GeminiStreamParser();
    const emit = (e: AgentEvent) => opts.onEvent?.(e);

    const { code, stderr } = await streamLines(
      this.bin,
      this.buildArgs(opts),
      { cwd: opts.cwd, input: opts.prompt, signal: opts.signal },
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
  private sessionId?: string;
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
        if (msg.error?.message) this.errorText += `${msg.error.message}\n`;
        return [];
      default:
        return [];
    }
  }

  finish(exitCode: number, stderr: string): AgentResult {
    const ok = exitCode === 0 && this.status === 'success';
    const text = ok ? this.answer.trim() : [this.answer.trim(), this.errorText.trim(), stderr.trim().slice(-1500)].filter(Boolean).join('\n');
    return { ok, text: text || `gemini exited ${exitCode} without a result`, costUsd: 0, sessionId: this.sessionId };
  }
}
