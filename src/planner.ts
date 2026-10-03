import type { Driver } from './drivers/driver.js';
import { cleanContracts, DEFAULT_TIMEOUT_MIN, READ_ONLY_TOOLS, validatePlan } from './plan.js';
import { extractJson, plannerPrompt } from './prompts.js';
import type { PlanSpec } from './types.js';

/** Longest a planner agent may take, like the time limit on any agent call in a run. */
const PLANNER_TIMEOUT_MS = DEFAULT_TIMEOUT_MIN * 60_000;

/** Ask a read-only agent to turn a goal into a validated task graph. */
export async function planGoal(
  driver: Driver,
  opts: { repo: string; goal: string; verify?: string[]; model?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ plan: PlanSpec; costUsd: number }> {
  const limit = AbortSignal.timeout(opts.timeoutMs ?? PLANNER_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, limit]) : limit;
  const stopped = new Error(`the planner was stopped after ${Math.round((opts.timeoutMs ?? PLANNER_TIMEOUT_MS) / 60_000)} minutes without a plan`);
  let res;
  try {
    res = await driver.run({
      prompt: plannerPrompt(opts.goal, opts.verify ?? []),
      cwd: opts.repo,
      model: opts.model,
      allowedTools: READ_ONLY_TOOLS,
      canEdit: false,
      maxTurns: 30,
      signal,
    });
  } catch (err) {
    if (limit.aborted && (err as Error).name === 'AbortError') throw stopped;
    throw err;
  }
  if (limit.aborted && !res.ok) throw stopped;
  if (!res.ok) throw new Error(`planner failed: ${res.text.slice(0, 1000)}`);
  const draft = extractJson<PlanSpec>(res.text);
  if (!draft) throw new Error(`planner returned no JSON plan:\n${res.text.slice(0, 1000)}`);
  const contracts = cleanContracts(draft.contracts, new Set((draft.tasks ?? []).map((t) => t?.id)));
  const plan: PlanSpec = {
    goal: draft.goal || opts.goal,
    concurrency: 3,
    maxAttempts: 2,
    review: true,
    ...(opts.verify?.length ? { verify: opts.verify } : {}),
    ...(contracts.length ? { contracts } : {}),
    tasks: draft.tasks,
  };
  validatePlan(plan);
  return { plan, costUsd: res.costUsd };
}
