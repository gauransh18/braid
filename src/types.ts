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
}

export interface PlanSpec {
  goal: string;
  /** Branch the run starts from. Never modified by the harness. */
  base?: string;
  concurrency?: number;
  /** Hard cap on total agent spend for the run, in USD. */
  budgetUsd?: number;
  driver?: string;
  model?: string;
  verify?: string[];
  /** Shell commands run in every fresh worktree before the agent starts (e.g. `npm ci`). */
  setup?: string[];
  review?: boolean;
  maxAttempts?: number;
  allowedTools?: string[];
  maxTurns?: number;
  tasks: TaskSpec[];
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'merging'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'skipped';

export interface TaskState {
  id: string;
  status: TaskStatus;
  attempts: number;
  costUsd: number;
  branch?: string;
  sessionId?: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface RunState {
  runId: string;
  repo: string;
  base: string;
  /** Branch that accumulates merged task work. The human merges it into base. */
  integrationBranch: string;
  status: 'running' | 'done' | 'failed' | 'aborted';
  costUsd: number;
  createdAt: string;
  endedAt?: string;
  tasks: Record<string, TaskState>;
}

/** Normalized event emitted by every driver, whatever CLI sits underneath. */
export type AgentEvent =
  | { kind: 'start'; sessionId?: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'tool_result'; isError: boolean; preview: string }
  | { kind: 'result'; ok: boolean; text: string; costUsd: number; sessionId?: string; turns?: number }
  | { kind: 'raw'; line: string };

export interface AgentResult {
  ok: boolean;
  text: string;
  costUsd: number;
  sessionId?: string;
}
