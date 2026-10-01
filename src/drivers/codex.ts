import type { AgentEvent, AgentResult } from '../types.js';
import { DRIVER_DEFAULT_MODEL, estimateCostUsd, sumUsage, type Usage } from '../pricing.js';
import { streamLines } from '../proc.js';
import type { Driver, DriverRunOptions } from './driver.js';

/**
 * OpenAI Codex CLI in headless mode: `codex exec --json -`.
 * Keeps Codex's own OS sandbox (workspace-write for workers, read-only for reviewers).
 * UNVERIFIED against a live codex install; event names follow `codex exec --json` docs.
 */
export class CodexDriver implements Driver {
  readonly name = 'codex';

  constructor(private readonly bin = process.env.BRAID_CODEX_BIN ?? 'codex') {}

  buildArgs(opts: DriverRunOptions): string[] {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    args.push('--sandbox', opts.canEdit ? 'workspace-write' : 'read-only');
    if (opts.model) args.push('--model', opts.model);
    args.push('-');
    return args;
  }

  async run(opts: DriverRunOptions): Promise<AgentResult> {
    let lastText = '';
    let failed = false;
    /** What Codex itself reported about a failure (the provider's message), kept apart from the agent's words. */
    const problems: string[] = [];
    const usage: Usage[] = [];
    const emit = (e: AgentEvent) => opts.onEvent?.(e);

    let exit: { code: number; stderr: string };
    try {
      exit = await streamLines(
        this.bin,
        this.buildArgs(opts),
        { cwd: opts.cwd, input: opts.prompt, signal: opts.signal, wrap: opts.wrap },
        (line) => {
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            emit({ kind: 'raw', line });
            return;
          }
          const item = msg.item ?? {};
          if (msg.type === 'thread.started') emit({ kind: 'start', sessionId: msg.thread_id });
          else if (msg.type === 'item.completed' && item.type === 'agent_message') {
            lastText = item.text ?? '';
            emit({ kind: 'text', text: lastText });
          } else if (msg.type === 'item.started' && item.type === 'command_execution') {
            emit({ kind: 'tool', name: 'shell', input: item.command });
          } else if (msg.type === 'turn.completed' && msg.usage) {
            // input_tokens includes the cached share, which is billed at a lower rate.
            const cached = Number(msg.usage.cached_input_tokens ?? 0);
            usage.push({ model: opts.model, input: Math.max(0, Number(msg.usage.input_tokens ?? 0) - cached), cached, output: Number(msg.usage.output_tokens ?? 0) });
          } else if (msg.type === 'turn.failed' || msg.type === 'error') {
            failed = true;
            // `codex exec --json` reports the provider's error on stdout (stderr stays empty).
            const why = String(msg.type === 'error' ? msg.message ?? '' : msg.error?.message ?? '').trim();
            if (why && !problems.includes(why)) problems.push(why);
          }
        },
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err;
      // Stopped: report the turns that finished.
      return { ok: false, text: 'aborted', costUsd: estimateCostUsd(usage, DRIVER_DEFAULT_MODEL.codex), tokens: sumUsage(usage), costEstimated: true };
    }
    const { code, stderr } = exit;

    const ok = code === 0 && !failed;
    const error = ok ? undefined : [...problems, stderr.trim().slice(-2000)].filter(Boolean).join('\n') || undefined;
    const text = ok ? lastText : [...problems, lastText, stderr.trim().slice(-2000)].filter(Boolean).join('\n');
    // Codex reports tokens, not dollars; spend is estimated from list prices (see pricing.ts).
    const costUsd = estimateCostUsd(usage, DRIVER_DEFAULT_MODEL.codex);
    const tokens = sumUsage(usage);
    emit({ kind: 'result', ok, text, costUsd, tokens, costEstimated: true });
    return { ok, text, costUsd, tokens, costEstimated: true, ...(error ? { error } : {}) };
  }
}
