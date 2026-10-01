import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentEvent, AgentResult, TokenUsage } from '../types.js';
import type { Driver, DriverRunOptions } from './driver.js';

export interface MockStep {
  /** Files to write, relative to the worktree. */
  files?: Record<string, string>;
  text?: string;
  /** What the provider itself said when `ok` is false (defaults to `text`). Set apart to script agent prose around a failure. */
  error?: string;
  ok?: boolean;
  costUsd?: number;
  tokens?: TokenUsage;
  /** Transcript events to emit before finishing (demo mode). */
  events?: AgentEvent[];
  /** Total simulated run time, spread across the events. */
  delayMs?: number;
}

/**
 * Deterministic driver for tests and demos. `script` picks the step for a call;
 * the default writes nothing and approves (so reviewers pass).
 */
export class MockDriver implements Driver {
  readonly calls: DriverRunOptions[] = [];

  constructor(
    private readonly script: (opts: DriverRunOptions, callIndex: number) => MockStep = () => ({}),
    /** Register several under different names to stand in for different agents. */
    readonly name = 'mock',
  ) {}

  async run(opts: DriverRunOptions): Promise<AgentResult> {
    const step = this.script(opts, this.calls.length);
    this.calls.push(opts);
    opts.onEvent?.({ kind: 'start', sessionId: `mock-${this.calls.length}` });
    const events = step.events ?? [];
    const gap = (step.delayMs ?? 0) / (events.length + 1);
    for (const e of events) {
      if (gap) await sleep(gap, undefined, { signal: opts.signal }).catch(() => undefined);
      opts.onEvent?.(e);
    }
    if (gap) await sleep(gap, undefined, { signal: opts.signal }).catch(() => undefined);
    if (opts.signal?.aborted) return { ok: false, text: 'aborted', costUsd: 0 };
    if (opts.canEdit) {
      for (const [rel, content] of Object.entries(step.files ?? {})) {
        const path = join(opts.cwd, rel);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
    }
    const text = step.text ?? '{"approve": true, "issues": []}';
    const ok = step.ok ?? true;
    // A scripted failure stands for the provider's own message, which is what braid judges.
    const res = { ok, text, costUsd: step.costUsd ?? 0, ...(step.tokens ? { tokens: step.tokens } : {}), ...(ok ? {} : { error: step.error ?? text }) };
    opts.onEvent?.({ kind: 'result', ...res });
    return res;
  }
}
