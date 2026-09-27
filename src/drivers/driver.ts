import type { AgentEvent, AgentResult } from '../types.js';

export interface DriverRunOptions {
  prompt: string;
  cwd: string;
  model?: string;
  maxTurns?: number;
  /** Tools usable without a prompt. Empty array = read-only analysis. */
  allowedTools: string[];
  /** Allow file edits. False for planner/reviewer agents. */
  canEdit: boolean;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

/** A driver runs one headless agent turn-loop to completion and reports structured events. */
export interface Driver {
  readonly name: string;
  run(opts: DriverRunOptions): Promise<AgentResult>;
}

export class DriverRegistry {
  private drivers = new Map<string, Driver>();

  register(d: Driver): this {
    this.drivers.set(d.name, d);
    return this;
  }

  get(name: string): Driver {
    const d = this.drivers.get(name);
    if (!d) throw new Error(`unknown driver "${name}" (have: ${[...this.drivers.keys()].join(', ')})`);
    return d;
  }
}
