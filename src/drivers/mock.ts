import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentResult } from '../types.js';
import type { Driver, DriverRunOptions } from './driver.js';

export interface MockStep {
  /** Files to write, relative to the worktree. */
  files?: Record<string, string>;
  text?: string;
  ok?: boolean;
  costUsd?: number;
}

/**
 * Deterministic driver for tests and dry runs. `script` picks the step for a call;
 * the default writes nothing and approves (so reviewers pass).
 */
export class MockDriver implements Driver {
  readonly name = 'mock';
  readonly calls: DriverRunOptions[] = [];

  constructor(private readonly script: (opts: DriverRunOptions, callIndex: number) => MockStep = () => ({})) {}

  async run(opts: DriverRunOptions): Promise<AgentResult> {
    const step = this.script(opts, this.calls.length);
    this.calls.push(opts);
    opts.onEvent?.({ kind: 'start', sessionId: `mock-${this.calls.length}` });
    if (opts.canEdit) {
      for (const [rel, content] of Object.entries(step.files ?? {})) {
        const path = join(opts.cwd, rel);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
    }
    const text = step.text ?? '{"approve": true, "issues": []}';
    const res = { ok: step.ok ?? true, text, costUsd: step.costUsd ?? 0 };
    opts.onEvent?.({ kind: 'result', ...res });
    return res;
  }
}
