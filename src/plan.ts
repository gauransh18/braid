import { readFile } from 'node:fs/promises';
import type { PlanSpec, TaskSpec } from './types.js';

export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

export interface ResolvedTask extends Required<Omit<TaskSpec, 'model' | 'maxTurns'>> {
  model?: string;
  maxTurns?: number;
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
  }
  for (const t of plan?.tasks ?? []) {
    for (const d of t.deps ?? []) if (!ids.has(d)) errors.push(`task "${t.id}" depends on unknown "${d}"`);
  }
  if (errors.length === 0) {
    const cycle = findCycle(plan.tasks);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }
  if (errors.length) throw new Error(`invalid plan:\n  - ${errors.join('\n  - ')}`);
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

/** Apply plan-level defaults to a task. */
export function resolveTask(plan: PlanSpec, t: TaskSpec): ResolvedTask {
  return {
    id: t.id,
    title: t.title ?? t.id,
    prompt: t.prompt,
    deps: t.deps ?? [],
    driver: t.driver ?? plan.driver ?? 'claude',
    model: t.model ?? plan.model,
    verify: t.verify ?? plan.verify ?? [],
    review: t.review ?? plan.review ?? false,
    maxAttempts: Math.max(1, t.maxAttempts ?? plan.maxAttempts ?? 2),
    allowedTools: t.allowedTools ?? plan.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
    maxTurns: t.maxTurns ?? plan.maxTurns,
  };
}
