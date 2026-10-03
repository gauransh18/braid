import { readFile } from 'node:fs/promises';
import type { ContractSpec, PlanSpec, TaskSpec } from './types.js';

export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
/** Safety nets for a run that sets no limits of its own. Generous: they stop a runaway, not a big task. */
export const DEFAULT_TIMEOUT_MIN = 30;
/** What one task may use, in fresh input and output tokens, when neither the task nor the plan says otherwise. */
export const DEFAULT_TOKENS_PER_TASK = 3_000_000;

export interface ResolvedTask extends Required<Omit<TaskSpec, 'model' | 'maxTurns'>> {
  model?: string;
  maxTurns?: number;
  /** Who reviews the diff: the driver always set (the task's own unless a reviewer names another). */
  reviewer: { driver: string; model?: string };
}

export async function loadPlan(path: string): Promise<PlanSpec> {
  const plan = JSON.parse(await readFile(path, 'utf8')) as PlanSpec;
  validatePlan(plan);
  return plan;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Structural checks: ids, deps, and no cycles. Throws with every problem found. */
export function validatePlan(plan: PlanSpec): void {
  const errors: string[] = [];
  if (!plan || typeof plan.goal !== 'string') errors.push('plan.goal must be a string');
  if (!Array.isArray(plan?.tasks) || plan.tasks.length === 0) errors.push('plan.tasks must be a non-empty array');
  const ids = new Set<string>();
  for (const t of plan?.tasks ?? []) {
    if (!ID_RE.test(t.id ?? '')) errors.push(`task id "${t.id}" must match ${ID_RE}`);
    if (ids.has(t.id)) errors.push(`duplicate task id "${t.id}"`);
    ids.add(t.id);
    if (!t.prompt) errors.push(`task "${t.id}" has no prompt`);
    checkLimit(errors, `task "${t.id}" timeoutMin`, t.timeoutMin);
    checkLimit(errors, `task "${t.id}" budgetTokens`, t.budgetTokens);
    checkStrings(errors, `task "${t.id}" touches`, t.touches, true);
    checkStrings(errors, `task "${t.id}" verifyMerge`, t.verifyMerge, false);
    checkReviewer(errors, `task "${t.id}" reviewer`, t.reviewer);
  }
  checkStrings(errors, 'plan.verifyMerge', plan?.verifyMerge, false);
  checkReviewer(errors, 'plan.reviewer', plan?.reviewer);
  checkLimit(errors, 'plan.budgetTokens', plan?.budgetTokens);
  checkLimit(errors, 'plan.taskBudgetTokens', plan?.taskBudgetTokens);
  checkLimit(errors, 'plan.timeoutMin', plan?.timeoutMin);
  for (const t of plan?.tasks ?? []) {
    for (const d of t.deps ?? []) if (!ids.has(d)) errors.push(`task "${t.id}" depends on unknown "${d}"`);
  }
  checkContracts(errors, plan?.contracts, ids);
  const sb = plan?.sandbox;
  if (sb) {
    if (!sb.image || typeof sb.image !== 'string') errors.push('sandbox.image must be a string');
    for (const name of sb.env ?? []) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) errors.push(`sandbox.env "${name}" must be a variable NAME, not NAME=value`);
    if (sb.env?.length && !sb.agent) errors.push('sandbox.env only applies when sandbox.agent is true');
  }
  if (errors.length === 0) {
    const cycle = findCycle(plan.tasks);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }
  if (errors.length) throw new Error(`invalid plan:\n  - ${errors.join('\n  - ')}`);
}

/** An optional array of non-empty strings (`touches`, `verifyMerge`). An empty array is allowed: nothing listed. */
function checkStrings(errors: string[], name: string, value: unknown, patterns: boolean): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string' || !x.trim())) {
    errors.push(`${name} must be an array of non-empty strings${patterns ? ' (paths or globs such as "src/auth/**")' : ' (shell commands)'}`);
  }
}

function checkContracts(errors: string[], value: unknown, ids: ReadonlySet<string>): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push('plan.contracts must be an array like [{"name": "amount", "meaning": "integer cents", "tasks": ["billing"]}]');
    return;
  }
  const names = new Set<string>();
  value.forEach((c: unknown, i) => {
    const at = `plan.contracts[${i}]`;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return void errors.push(`${at} must be an object`);
    const { name, meaning, tasks } = c as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) errors.push(`${at}.name must be a non-empty string`);
    else if (names.has(name)) errors.push(`${at}: duplicate contract "${name}"`);
    else names.add(name);
    if (typeof meaning !== 'string' || !meaning.trim()) errors.push(`${at}.meaning must be a non-empty string`);
    if (tasks === undefined) return;
    if (!Array.isArray(tasks) || tasks.some((t) => typeof t !== 'string')) errors.push(`${at}.tasks must be an array of task ids`);
    else for (const t of tasks) if (!ids.has(t)) errors.push(`${at} names unknown task "${t}"`);
  });
}

function checkReviewer(errors: string[], name: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${name} must be an object like {"driver": "codex", "model": "..."}`);
    return;
  }
  for (const key of ['driver', 'model'] as const) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined && (typeof v !== 'string' || !v.trim())) errors.push(`${name}.${key} must be a non-empty string`);
  }
}

function checkLimit(errors: string[], name: string, value: unknown): void {
  if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) errors.push(`${name} must be a number, 0 or more (0 turns the limit off)`);
}

function findCycle(tasks: TaskSpec[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.deps ?? []]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const t of tasks) {
    const c = visit(t.id);
    if (c) return c;
  }
  return null;
}

/**
 * The reviewer of a task: fields on the task win over the plan's, and the task's own agent and model fill the rest. A
 * model belongs to one agent, so one is only carried over to a reviewer on the agent it was meant for.
 */
function resolveReviewer(plan: PlanSpec, t: TaskSpec, driver: string, model: string | undefined): ResolvedTask['reviewer'] {
  const own = t.reviewer;
  const shared = plan.reviewer;
  const rdriver = own?.driver ?? shared?.driver ?? driver;
  const sharedModel = shared?.model && rdriver === (shared.driver ?? driver) ? shared.model : undefined;
  const fallback = rdriver === driver ? model : rdriver === (plan.driver ?? 'claude') ? plan.model : undefined;
  return { driver: rdriver, model: own?.model ?? sharedModel ?? fallback };
}

/** The contracts a task is told: those that name it, and those that name no task (they hold everywhere). */
export function contractsFor(plan: PlanSpec, taskId: string): ContractSpec[] {
  return (plan.contracts ?? []).filter((c) => !c.tasks || c.tasks.includes(taskId));
}

/**
 * Keep the contracts a planner proposed that can be used. A model slips on a task id now and then, and one bad id
 * should not throw the whole plan away: unknown ids are dropped from a contract, and a contract left naming no task
 * (it named some, none exist) is dropped with them.
 */
export function cleanContracts(raw: unknown, taskIds: ReadonlySet<string>): ContractSpec[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ContractSpec[] = [];
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) continue;
    const { name, meaning, tasks } = c as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || typeof meaning !== 'string' || !meaning.trim() || seen.has(name)) continue;
    const named = Array.isArray(tasks) ? tasks.filter((t): t is string => typeof t === 'string' && taskIds.has(t)) : undefined;
    if (Array.isArray(tasks) && !named?.length) continue;
    seen.add(name);
    out.push({ name: name.trim(), meaning: meaning.trim(), ...(named ? { tasks: named } : {}) });
  }
  return out;
}

/** Tasks that replace a failed one are held to the same contracts as the task they replace. */
export function inheritContracts(plan: PlanSpec, failedId: string, addedIds: string[]): void {
  for (const c of plan.contracts ?? []) if (c.tasks?.includes(failedId)) c.tasks = [...c.tasks, ...addedIds];
}

/** Apply plan-level defaults to a task. */
export function resolveTask(plan: PlanSpec, t: TaskSpec): ResolvedTask {
  const driver = t.driver ?? plan.driver ?? 'claude';
  const model = t.model ?? plan.model;
  const verify = t.verify ?? plan.verify ?? [];
  return {
    id: t.id,
    title: t.title ?? t.id,
    prompt: t.prompt,
    deps: t.deps ?? [],
    driver,
    model,
    verify,
    verifyMerge: t.verifyMerge ?? plan.verifyMerge ?? verify,
    touches: t.touches ?? [],
    reviewer: resolveReviewer(plan, t, driver, model),
    review: t.review ?? plan.review ?? false,
    maxAttempts: Math.max(1, t.maxAttempts ?? plan.maxAttempts ?? 2),
    allowedTools: t.allowedTools ?? plan.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
    maxTurns: t.maxTurns ?? plan.maxTurns,
    timeoutMin: t.timeoutMin ?? plan.timeoutMin ?? DEFAULT_TIMEOUT_MIN,
    budgetTokens: t.budgetTokens ?? plan.taskBudgetTokens ?? DEFAULT_TOKENS_PER_TASK,
  };
}

export interface ReplanDraft {
  action?: string;
  reason?: string;
  tasks?: { id: string; title?: string; prompt: string; deps?: string[] }[];
}

export const MAX_REPLACEMENT_TASKS = 6;

/**
 * Turn the planner's proposal for a failed task into graph edits, or throw why it is unusable.
 * Replacement tasks may depend only on tasks already merged or on each other; one with no deps
 * inherits the failed task's. Whatever waited on the failed task now waits on the replacements
 * nothing else depends on. The replacements inherit the failed task's driver, checks and limits.
 */
export function applyReplan(
  plan: PlanSpec,
  failedId: string,
  draft: ReplanDraft,
  doneIds: ReadonlySet<string>,
): { added: TaskSpec[]; rewired: Record<string, string[]> } {
  const failed = plan.tasks.find((t) => t.id === failedId);
  if (!failed) throw new Error(`unknown task "${failedId}"`);
  const proposed = draft.tasks ?? [];
  if (draft.action === 'give_up' || !proposed.length) {
    throw new Error(draft.reason ? `planner gave up: ${draft.reason}` : 'planner proposed no replacement tasks');
  }
  if (proposed.length > MAX_REPLACEMENT_TASKS) throw new Error(`planner proposed ${proposed.length} tasks; the limit is ${MAX_REPLACEMENT_TASKS}`);

  const existing = new Set(plan.tasks.map((t) => t.id));
  const newIds = new Set(proposed.map((t) => t.id));
  const errors: string[] = [];
  if (newIds.size !== proposed.length) errors.push('duplicate replacement ids');
  for (const t of proposed) {
    if (!ID_RE.test(t.id ?? '')) errors.push(`replacement id "${t.id}" must match ${ID_RE}`);
    else if (existing.has(t.id)) errors.push(`replacement id "${t.id}" is already used`);
    if (!t.prompt) errors.push(`replacement "${t.id}" has no prompt`);
    for (const d of t.deps ?? []) {
      if (d === t.id) errors.push(`replacement "${t.id}" depends on itself`);
      else if (!doneIds.has(d) && !newIds.has(d)) errors.push(`replacement "${t.id}" depends on "${d}", which is neither merged nor a replacement`);
    }
  }
  if (errors.length) throw new Error(`unusable replan:\n  - ${errors.join('\n  - ')}`);

  const { id: _id, title: _title, prompt: _prompt, deps: _deps, ...inherited } = failed;
  const added: TaskSpec[] = proposed.map((t) => ({
    ...inherited,
    id: t.id,
    title: t.title || t.id,
    prompt: t.prompt,
    deps: t.deps?.length ? t.deps : failed.deps ?? [],
  }));
  const used = new Set(added.flatMap((t) => t.deps ?? []));
  const sinks = added.map((t) => t.id).filter((id) => !used.has(id));

  const rewired: Record<string, string[]> = {};
  for (const t of plan.tasks) {
    if (t.deps?.includes(failedId)) rewired[t.id] = [...t.deps.filter((d) => d !== failedId), ...sinks];
  }
  validatePlan({ ...plan, tasks: [...plan.tasks.map((t) => (rewired[t.id] ? { ...t, deps: rewired[t.id] } : t)), ...added] });
  return { added, rewired };
}
