import type { AgentEvent, AgentResult } from '../types.js';
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
    const emit = (e: AgentEvent) => opts.onEvent?.(e);

    const { code, stderr } = await streamLines(
      this.bin,
      this.buildArgs(opts),
      { cwd: opts.cwd, input: opts.prompt, signal: opts.signal },
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
        } else if (msg.type === 'turn.failed' || msg.type === 'error') failed = true;
      },
    );

    const ok = code === 0 && !failed;
    const text = ok ? lastText : `${lastText}\n${stderr.trim().slice(-2000)}`.trim();
    // Codex does not report spend in exec mode; budget accounting treats it as 0.
    emit({ kind: 'result', ok, text, costUsd: 0 });
    return { ok, text, costUsd: 0 };
  }
}
