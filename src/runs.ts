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

/** Provider keys the desktop app's Settings may hand to this process. Anything else is refused. */
export const KEY_ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY'] as const;

/** What a plan uses when it does not choose for itself. */
export interface AgentDefaults {
  driver?: string;
  /** Model per driver; a missing or empty entry means the CLI's own default. */
  models?: Record<string, string>;
  /** Agents the person switched off in Settings. Plans that need one are refused; defaults skip them. */
  disabled?: string[];
}

export interface SettingsInput {
  /** Provider keys by variable name. A string sets it, null removes what Settings set. */
  env?: Record<string, string | null>;
  defaults?: AgentDefaults;
}

/**
 * Starts, stops and resumes runs inside the watch server's process, one at a time. Only reachable
 * through the token-guarded control endpoints.
 */
export class RunManager {
  private active?: { runId: string; ac: AbortController };
  private defaults: AgentDefaults = {};
  /** Environment values as they were before Settings overrode them, so removing a key restores them. */
  private originalEnv = new Map<string, string | undefined>();

  constructor(
    private readonly repo: string,
    private readonly drivers: () => DriverRegistry,
  ) {}

  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  get agentDefaults(): AgentDefaults {
    return this.defaults;
  }

  /**
   * Apply what the desktop app's Settings window pushed: provider keys go into this process's environment (only
   * this dedicated process, so every agent it spawns from now on inherits them) and the default agent and models
   * are remembered for plans that do not name their own.
   */
  applySettings(input: SettingsInput): void {
    const env = input.env ?? {};
    for (const name of Object.keys(env)) {
      if (!(KEY_ENV_NAMES as readonly string[]).includes(name)) throw new HttpError(400, `${name} is not a provider key braid manages`);
    }
    const d = input.defaults;
    if (d?.driver) {
      try {
        this.drivers().get(d.driver);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === 'string' && value.length > 0) {
        if (!this.originalEnv.has(name)) this.originalEnv.set(name, process.env[name]);
        process.env[name] = value;
      } else if (this.originalEnv.has(name)) {
        const original = this.originalEnv.get(name);
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
        this.originalEnv.delete(name);
      }
    }
    if (d) {
      this.defaults = {
        driver: d.driver || undefined,
        models: Object.fromEntries(Object.entries(d.models ?? {}).filter(([, m]) => m)),
        disabled: (d.disabled ?? []).filter((n) => typeof n === 'string'),
      };
    }
  }

  isDisabled(agent: string): boolean {
    return !!this.defaults.disabled?.includes(agent);
  }

  /** The agent a plan that names none will use: the chosen default unless it is switched off, else the first one that is on. */
  effectiveDriver(): string {
    const d = this.defaults.driver;
    if (d && !this.isDisabled(d)) return d;
    return this.drivers().names().find((n) => !this.isDisabled(n)) ?? d ?? 'claude';
  }

  /** Refuse a plan that needs an agent the person turned off. */
  private checkEnabled(plan: PlanSpec): void {
    const main = plan.driver ?? this.effectiveDriver();
    const used = new Set([main, ...(plan.tasks ?? []).map((t) => t.driver ?? main)]);
    for (const agent of used) {
      if (this.isDisabled(agent)) throw new HttpError(400, `The ${agent} agent is switched off in Settings. Switch it on there, or choose another agent in the plan.`);
    }
  }

  /** A copy of `plan` with the default agent and model filled in wherever it left them open. */
  private withDefaults(plan: PlanSpec): PlanSpec {
    const d = this.defaults;
    const out = structuredClone(plan);
    if (!out.driver && (d.driver || d.disabled?.length)) out.driver = this.effectiveDriver();
    const main = out.driver ?? 'claude';
    if (!out.model && d.models?.[main]) out.model = d.models[main];
    for (const t of out.tasks ?? []) {
      // A task on a different agent than the plan's would otherwise inherit the wrong agent's model.
      if (t.driver && t.driver !== main && !t.model && d.models?.[t.driver]) t.model = d.models[t.driver];
    }
    return out;
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

  async start(given: PlanSpec, resumeId?: string): Promise<{ runId: string }> {
    // A resumed run keeps the agent and model it started with; the stored plan already has them.
    const plan = resumeId ? given : this.withDefaults(given);
    this.checkPlan(plan);
    this.checkEnabled(plan);
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

  async draft(goal: string, verify: string[], requested?: string): Promise<{ plan: PlanSpec; costUsd: number }> {
    if (!goal.trim()) throw new HttpError(400, 'goal is required');
    const driver = requested ?? this.effectiveDriver();
    if (this.isDisabled(driver)) throw new HttpError(400, `The ${driver} agent is switched off in Settings.`);
    try {
      return await planGoal(this.drivers().get(driver), { repo: this.repo, goal, verify, model: this.defaults.models?.[driver] });
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
