import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DriverRegistry } from './drivers/driver.js';
import { Orchestrator } from './orchestrator.js';
import { validatePlan } from './plan.js';
import { planGoal } from './planner.js';
import { RunStore, stateRoot } from './store.js';
import type { PlanSpec } from './types.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const START_TIMEOUT_MS = 30_000;

/**
 * Starts, stops and resumes runs inside the watch server's process, one at a time. Only reachable
 * through the token-guarded control endpoints.
 */
export class RunManager {
  private active?: { runId: string; ac: AbortController };

  constructor(
    private readonly repo: string,
    private readonly drivers: () => DriverRegistry,
  ) {}

  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  /** Every run started from a window must have a spend cap: nobody is watching a terminal to press Ctrl-C. */
  private checkPlan(plan: PlanSpec): void {
    try {
      validatePlan(plan);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    if (typeof plan.budgetUsd !== 'number' || !(plan.budgetUsd > 0)) {
      throw new HttpError(400, 'set budgetUsd (a spend cap in dollars) before starting a run from here');
    }
  }

  async start(plan: PlanSpec, resumeId?: string): Promise<{ runId: string }> {
    this.checkPlan(plan);
    if (this.active) throw new HttpError(409, `run ${this.active.runId} is still active`);

    const ac = new AbortController();
    let orch: Orchestrator;
    try {
      orch = new Orchestrator({ repo: this.repo, plan, drivers: this.drivers(), signal: ac.signal, runId: resumeId, resume: !!resumeId });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    this.active = { runId: orch.runId, ac };

    let failEarly!: (err: Error) => void;
    const failed = new Promise<never>((_, reject) => (failEarly = reject));
    const started = new Promise<void>((resolve) =>
      orch.store.onEvent((e) => {
        if (e.type === 'run_start' || e.type === 'run_resume') resolve();
      }),
    );

    void orch
      .run()
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err);
        orch.store.event('run_error', { message });
        await markFailed(this.repo, orch.runId);
        failEarly(new HttpError(500, message));
      })
      .finally(() => {
        this.active = undefined;
      });
    failed.catch(() => undefined); // a failure after the run began is reported through events, not this promise

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        started,
        failed,
        new Promise<void>((resolve) => (timer = setTimeout(resolve, START_TIMEOUT_MS))),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return { runId: orch.runId };
  }

  async resume(runId: string, budgetUsd?: number): Promise<{ runId: string }> {
    let plan: PlanSpec;
    try {
      plan = JSON.parse(await readFile(join(stateRoot(this.repo), 'runs', runId, 'plan.json'), 'utf8'));
    } catch {
      throw new HttpError(404, 'no such run');
    }
    if (budgetUsd !== undefined) plan.budgetUsd = budgetUsd;
    return this.start(plan, runId);
  }

  stop(runId: string): void {
    if (this.active?.runId !== runId) throw new HttpError(409, 'that run is not active');
    this.active.ac.abort();
  }

  async draft(goal: string, verify: string[], driver = 'claude'): Promise<{ plan: PlanSpec; costUsd: number }> {
    if (!goal.trim()) throw new HttpError(400, 'goal is required');
    try {
      return await planGoal(this.drivers().get(driver), { repo: this.repo, goal, verify });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  }
}

/** A run that died outside the scheduler would otherwise stay "running" forever. */
async function markFailed(repo: string, runId: string): Promise<void> {
  try {
    const state = await RunStore.loadState(repo, runId);
    if (state.status !== 'running') return;
    state.status = 'failed';
    state.endedAt = new Date().toISOString();
    await new RunStore(repo, runId).saveState(state);
  } catch {
    /* no state yet: the run never got going */
  }
}

/**
 * A check command to offer as the default, from what the repository looks like. Only a suggestion the person
 * can change: getting it wrong costs nothing, and offering one nudges people to verify at all.
 */
export async function detectVerify(repo: string): Promise<string | null> {
  // Unreadable or malformed package.json just means no suggestion.
  const pkg = await readFile(join(repo, 'package.json'), 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  const test: unknown = pkg?.scripts?.test;
  // `npm init` writes a placeholder script that always fails.
  if (typeof test === 'string' && !/no test specified/.test(test)) return 'npm test';
  if (existsSync(join(repo, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(repo, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(repo, 'pytest.ini')) || existsSync(join(repo, 'pyproject.toml')) || existsSync(join(repo, 'tox.ini'))) return 'pytest';
  return null;
}
