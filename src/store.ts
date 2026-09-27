import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile, readdir, rename, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanSpec, RunState } from './types.js';

export interface HarnessEvent {
  ts: string;
  type: string;
  task?: string;
  [k: string]: unknown;
}

export function stateRoot(repo: string): string {
  return join(repo, '.braid');
}

/** On-disk record of one run: plan, state snapshot, append-only event log, per-attempt agent transcripts. */
export class RunStore {
  readonly dir: string;
  private listeners: ((e: HarnessEvent) => void)[] = [];

  constructor(repo: string, readonly runId: string) {
    this.dir = join(stateRoot(repo), 'runs', runId);
    mkdirSync(join(this.dir, 'tasks'), { recursive: true });
  }

  onEvent(fn: (e: HarnessEvent) => void): void {
    this.listeners.push(fn);
  }

  event(type: string, data: Omit<HarnessEvent, 'ts' | 'type'> = {}): void {
    const e: HarnessEvent = { ts: new Date().toISOString(), type, ...data };
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(e) + '\n');
    for (const l of this.listeners) l(e);
  }

  agentLog(taskId: string, attempt: number, role: string): (e: unknown) => void {
    const dir = join(this.dir, 'tasks', taskId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${role}-${attempt}.jsonl`);
    return (e) => appendFileSync(file, JSON.stringify(e) + '\n');
  }

  async savePlan(plan: PlanSpec): Promise<void> {
    await writeFile(join(this.dir, 'plan.json'), JSON.stringify(plan, null, 2));
  }

  /** Atomic snapshot write so a crash never leaves half a state file. */
  async saveState(state: RunState): Promise<void> {
    const tmp = join(this.dir, 'state.json.tmp');
    await writeFile(tmp, JSON.stringify(state, null, 2));
    // Windows refuses to replace a file another process has open (e.g. the watch server reading it).
    for (let i = 0; ; i++) {
      try {
        await rename(tmp, join(this.dir, 'state.json'));
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (i >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  static async loadState(repo: string, runId: string): Promise<RunState> {
    return JSON.parse(await readFile(join(stateRoot(repo), 'runs', runId, 'state.json'), 'utf8'));
  }

  static async listRuns(repo: string): Promise<string[]> {
    const dir = join(stateRoot(repo), 'runs');
    await mkdir(dir, { recursive: true });
    return (await readdir(dir)).sort();
  }
}

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
