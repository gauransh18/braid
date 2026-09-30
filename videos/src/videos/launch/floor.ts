import { b } from "./cues";
import { TASK_COLORS } from "./tokens";

/** The `braid demo` plan (src/demo.ts), in plan order so colors match the dashboard. */
export const TASKS = [
  { id: "schema", title: "Note schema and validation", deps: [] as string[], col: 0, row: 0 },
  { id: "auth", title: "Token auth middleware", deps: [], col: 0, row: 1 },
  { id: "errors", title: "Error responses", deps: [], col: 0, row: 2 },
  { id: "routes", title: "CRUD routes", deps: ["schema", "auth", "errors"], col: 1, row: 0 },
  { id: "tests", title: "Route tests", deps: ["routes"], col: 2, row: 0 },
  { id: "docs", title: "API reference", deps: ["schema"], col: 1, row: 1 },
  { id: "sdk", title: "Typed client SDK", deps: ["routes"], col: 2, row: 1 },
].map((task, index) => ({ ...task, color: TASK_COLORS[index] }));

export const GOAL = "Add a notes API with auth, validation, tests and docs";
export const RUN_ID = "20260930-133204-urvg";
export const BRANCH = `braid/${RUN_ID}/integration`;
export const BUDGET = 10;
export const MAX_ATTEMPTS = 3;

type Status = "pending" | "running" | "verifying" | "reviewing" | "merging" | "done";
type Step = readonly [time: number, status: Status, attempt?: number, failedBefore?: boolean];

/** Each task's lifecycle on the beat grid. Order follows the scheduler: deps first, merges serialized. */
const LIFE: Record<string, Step[]> = {
  schema: [[b(11, 1), "running", 1], [b(12, 1), "verifying"], [b(13, 2), "merging"], [b(13, 3), "done"]],
  auth: [[b(11, 1), "running", 1], [b(12, 3), "verifying"], [b(13, 3), "running", 2, true], [b(14, 3), "verifying"], [b(15, 1), "merging"], [b(15, 2), "done"]],
  errors: [[b(11, 1, 0.5), "running", 1], [b(12, 2), "verifying"], [b(13, 4), "merging"], [b(14, 1), "done"]],
  docs: [[b(13, 3, 0.5), "running", 1], [b(14, 2), "verifying"], [b(14, 4), "reviewing"], [b(15, 3), "merging"], [b(15, 4), "done"]],
  routes: [[b(15, 2, 0.5), "running", 1], [b(15, 4, 0.5), "verifying"], [b(16, 1, 0.5), "reviewing"], [b(16, 2, 0.5), "merging"], [b(16, 3), "done"]],
  tests: [[b(16, 3, 0.5), "running", 1], [b(17, 1), "verifying"], [b(17, 3), "merging"], [b(17, 3, 0.5), "done"]],
  sdk: [[b(16, 4), "running", 1], [b(17, 1, 0.5), "verifying"], [b(17, 2), "merging"], [b(17, 2, 0.5), "done"]],
};

/** What each task costs by the end (demo numbers, same range as src/demo.ts). */
const COST: Record<string, number> = { schema: 0.31, auth: 0.52, errors: 0.18, routes: 0.44, tests: 0.36, docs: 0.22, sdk: 0.29 };
const TOKENS_PER_USD = 290_000;

export type TaskState = { status: Status; attempts: number; failed: number; cost: number; tokens: number; doneAt?: number };

export function taskState(id: string, t: number): TaskState {
  const life = LIFE[id];
  let status: Status = "pending", attempts = 0, failed = 0;
  for (const [time, s, attempt, failedBefore] of life) {
    if (t < time) break;
    status = s;
    if (attempt) attempts = attempt;
    if (failedBefore) failed = 1;
  }
  const start = life[0][0];
  const end = life[life.length - 1][0];
  const share = t <= start ? 0 : t >= end ? 1 : (t - start) / (end - start);
  const stepped = Math.floor(share * 16) / 16; // costs tick in steps, like the polled dashboard
  const cost = COST[id] * stepped;
  return { status, attempts, failed, cost, tokens: Math.round(cost * TOKENS_PER_USD), doneAt: status === "done" ? end : undefined };
}

export function runState(t: number) {
  const tasks = TASKS.map((task) => ({ task, state: taskState(task.id, t) }));
  const merged = tasks
    .filter(({ state }) => state.doneAt !== undefined)
    .sort((a, b2) => (a.state.doneAt ?? 0) - (b2.state.doneAt ?? 0));
  const spend = tasks.reduce((sum, { state }) => sum + state.cost, 0);
  const tokens = tasks.reduce((sum, { state }) => sum + state.tokens, 0);
  const active = tasks.filter(({ state }) => ["running", "verifying", "reviewing", "merging"].includes(state.status)).length;
  return { tasks, merged, spend, tokens, active };
}

/** Merge times in order, for the rope. */
export const MERGES = TASKS.map((task) => ({ task, at: LIFE[task.id][LIFE[task.id].length - 1][0] })).sort((a, c) => a.at - c.at);

/** Knot's lines, copied from knotSays() in ui/index.html with this run's numbers. */
export const KNOT_LINES: [number, string][] = [
  [b(7), "Warming up the loom..."],
  [b(10, 3), "Picking the next strands..."],
  [b(11, 1, 0.5), "Weaving 3 strands. 0 braided, 4 waiting."],
  [b(13, 3), "auth failed `node check.js`. Sending it back with the output."],
  [b(15, 3), "Weaving 2 strands. 3 braided, 2 waiting."],
  [b(17, 4), `All 7 strands braided. Review ${BRANCH} and merge it when you're happy.`],
];

export const fmtTok = (n: number) =>
  n < 1e3 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 2 : 1).replace(/\.?0+$/, "") + "k" : (n / 1e6).toFixed(2) + "M";
export const fmtUsd = (usd: number) => "$" + usd.toFixed(2);
