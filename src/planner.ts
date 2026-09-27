import type { Driver } from './drivers/driver.js';
import { READ_ONLY_TOOLS, validatePlan } from './plan.js';
import { extractJson, plannerPrompt } from './prompts.js';
import type { PlanSpec } from './types.js';

/** Ask a read-only agent to turn a goal into a validated task graph. */
export async function planGoal(
  driver: Driver,
  opts: { repo: string; goal: string; verify?: string[]; model?: string },
): Promise<{ plan: PlanSpec; costUsd: number }> {
  const res = await driver.run({
    prompt: plannerPrompt(opts.goal, opts.verify ?? []),
    cwd: opts.repo,
    model: opts.model,
    allowedTools: READ_ONLY_TOOLS,
    canEdit: false,
    maxTurns: 30,
  });
  if (!res.ok) throw new Error(`planner failed: ${res.text.slice(0, 1000)}`);
  const draft = extractJson<PlanSpec>(res.text);
  if (!draft) throw new Error(`planner returned no JSON plan:\n${res.text.slice(0, 1000)}`);
  const plan: PlanSpec = {
    goal: draft.goal || opts.goal,
    concurrency: 3,
    maxAttempts: 2,
    review: true,
    ...(opts.verify?.length ? { verify: opts.verify } : {}),
    tasks: draft.tasks,
  };
  validatePlan(plan);
  return { plan, costUsd: res.costUsd };
}
