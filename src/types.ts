// Core data model. A Plan is a DAG of Tasks; a Run executes one Plan.

export interface TaskSpec {
  id: string;
  title: string;
  /** Self-contained instructions for the agent. */
  prompt: string;
  /** Task ids that must be merged before this task starts. */
  deps?: string[];
  /** Driver name (claude, codex, mock). Falls back to plan default. */
  driver?: string;
  model?: string;
  /** Shell commands that must all exit 0 in the task worktree. Overrides plan default. */
  verify?: string[];
  /** Run a read-only reviewer agent over the diff before merge. */
  review?: boolean;
  /** Total attempts (first try + retries with failure feedback). */
  maxAttempts?: number;
  /** Tools the agent may use without prompting. Headless agents cannot be asked, so anything else is denied. */
  allowedTools?: string[];
  maxTurns?: number;
  /** Minutes one agent call may run before it is stopped (the attempt then fails and is retried). 0 = no limit. Overrides the plan default. */
  timeoutMin?: number;
}

/** Run task commands (and optionally the agent) in a container. Needs Docker or Podman. */
export interface SandboxSpec {
  /** Image for setup, verify and, with `agent`, the agent. Must contain your toolchain (e.g. node:22). */
  image: string;
  /** Also run the agent CLI in the container, which makes it safe to allow `Bash`. The image must contain the CLI. */
  agent?: boolean;
  /** Host environment variable NAMES to pass to the agent, e.g. ANTHROPIC_API_KEY. Values are never read by braid. */
  env?: string[];
  /** Give verify commands network access. Setup and the agent always have it. Default false. */
  network?: boolean;
  /** Container memory limit, e.g. "4g". */
  memory?: string;
  /** Container CPU limit, e.g. "2". */
  cpus?: string;
}

export interface PlanSpec {
  goal: string;
  /** Branch the run starts from. Never modified by the harness. */
  base?: string;
  concurrency?: number;
  /** Hard cap on total agent spend for the run, in USD. */
  budgetUsd?: number;
  /**
   * Stop scheduling once the run has used this many fresh input and output tokens (cached input is left out: it is
   * re-read context and costs a tenth as much). Counts from the start of each `run` or `resume`, so a resumed run
   * gets a fresh allowance. Default: 3 million per task. 0 = no limit.
   */
  budgetTokens?: number;
  /** Minutes one agent call may run before it is stopped. Default 30. 0 = no limit. A task can set its own. */
  timeoutMin?: number;
  driver?: string;
  model?: string;
  verify?: string[];
  /** Shell commands run in every fresh worktree before the agent starts (e.g. `npm ci`). */
  setup?: string[];
  review?: boolean;
  maxAttempts?: number;
  allowedTools?: string[];
  maxTurns?: number;
  /** How many times the run may ask the planner to split or rewrite a task that failed for good. 0 (default) = never. */
  maxReplans?: number;
  sandbox?: SandboxSpec;
  tasks: TaskSpec[];
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'resolving'
  | 'verifying'
  | 'reviewing'
  /** Failed for good; the planner is deciding how to split or rewrite it. Dependents keep waiting. */
  | 'replanning'
  | 'merging'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'skipped'
  /** Failed for good, then swapped for new tasks by the planner. Counts as complete for the run. */
  | 'replaced';

/**
 * Tokens as the agent CLI reported them, split by how they are billed.
 * `input` is fresh input (cache writes included), `cached` is input served from cache, `output` is generated text.
 */
export interface TokenUsage {
  input: number;
  cached: number;
  output: number;
}

export interface TaskState {
  id: string;
  status: TaskStatus;
  attempts: number;
  costUsd: number;
  /** Tokens across all of this task's agent calls (worker, resolver, reviewer, planner). */
  tokens?: TokenUsage;
  branch?: string;
  sessionId?: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  /** Set on a replaced task: the tasks that took its place. */
  replacedBy?: string[];
  /** Set on a task the planner created: the failed task it replaces. */
  replanOf?: string;
}

export interface RunState {
  runId: string;
  repo: string;
  base: string;
  /** Branch that accumulates merged task work. The human merges it into base. */
  integrationBranch: string;
  status: 'running' | 'done' | 'failed' | 'aborted';
  costUsd: number;
  tokens?: TokenUsage;
  /** True when `costUsd` includes a list-price estimate (Codex, Gemini) rather than a figure the CLI reported. Tokens are always as reported. */
  costEstimated?: boolean;
  createdAt: string;
  endedAt?: string;
  /** Integration head after the last verified merge. Resume rewinds to it, dropping any half-done merge. */
  verifiedHead?: string;
  /** Process driving the run, so resume can refuse a run that is still alive. */
  pid?: number;
  resumes?: number;
  /** Planner calls made to replace failed tasks. */
  replans?: number;
  tasks: Record<string, TaskState>;
}

/** Normalized event emitted by every driver, whatever CLI sits underneath. */
export type AgentEvent =
  | { kind: 'start'; sessionId?: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'tool_result'; isError: boolean; preview: string }
  | { kind: 'result'; ok: boolean; text: string; costUsd: number; tokens?: TokenUsage; costEstimated?: boolean; sessionId?: string; turns?: number }
  | { kind: 'raw'; line: string };

export interface AgentResult {
  ok: boolean;
  text: string;
  costUsd: number;
  tokens?: TokenUsage;
  /** `costUsd` was computed from tokens and list prices, not reported by the CLI. */
  costEstimated?: boolean;
  sessionId?: string;
  /**
   * On failure, what the provider or the CLI itself said (an API error, a usage-limit notice), never the agent's own
   * words. This is the only text braid judges as "the provider turned the call away"; `text` can hold agent prose.
   */
  error?: string;
  /** Set by the orchestrator when it stopped the call for running past its time limit. */
  timedOut?: boolean;
}
