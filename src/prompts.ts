import type { PlanSpec } from './types.js';
import type { ResolvedTask } from './plan.js';

export interface Feedback {
  attempt: number;
  reason: string;
}

export function workerPrompt(plan: PlanSpec, task: ResolvedTask, feedback: Feedback[]): string {
  const parts = [
    `You are one worker in a team of coding agents. Overall goal: ${plan.goal}`,
    `Your task (${task.id}): ${task.title}`,
    task.prompt,
    [
      'Rules:',
      '- Work only inside the current directory. It is an isolated git worktree; do not run git commands.',
      '- Stay inside your task scope. Other workers handle the other tasks.',
      '- Do not commit. The harness commits, verifies and merges your changes.',
      task.verify.length ? `- Your work must pass: ${task.verify.map((c) => `\`${c}\``).join(', ')}` : '',
      '- End with a short summary of what you changed and anything left undone.',
    ]
      .filter(Boolean)
      .join('\n'),
  ];
  if (feedback.length) {
    parts.push(
      'Previous attempts were rejected. The worktree still contains the last attempt; fix it rather than starting over.',
      ...feedback.map((f) => `Attempt ${f.attempt} rejected:\n${f.reason}`),
    );
  }
  return parts.join('\n\n');
}

/**
 * Narrow follow-up after a merge conflict: keep the agent's finished work and only
 * reconcile it with what other tasks merged meanwhile. Much cheaper than a redo.
 */
export function conflictPrompt(plan: PlanSpec, task: ResolvedTask, files: string[], leftover: string[] = []): string {
  return [
    `You are one worker in a team of coding agents. Overall goal: ${plan.goal}`,
    `Your task (${task.id}): ${task.title}`,
    task.prompt,
    'You already finished this task. Meanwhile other workers merged their own tasks, and the harness has merged that newer work into your branch. Git could not combine these files automatically and left conflict markers (<<<<<<<, =======, >>>>>>>) in them:',
    files.map((f) => `- ${f}`).join('\n'),
    leftover.length ? `Your previous resolution left markers in: ${leftover.join(', ')}. Finish those.` : '',
    [
      'Resolve every conflict:',
      "- Keep BOTH sides' intent: your task's changes and the other workers' changes. Do not drop either unless they are truly incompatible.",
      '- Remove every marker line. Touch only what the conflicts require; do not redo or refactor the task.',
      '- Do not run git commands. The harness commits the merge.',
      task.verify.length ? `- The result must pass: ${task.verify.map((c) => `\`${c}\``).join(', ')}` : '',
      '- End with one line per file saying how you combined it.',
    ]
      .filter(Boolean)
      .join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function reviewerPrompt(plan: PlanSpec, task: ResolvedTask, diff: string): string {
  return [
    `You are a strict code reviewer. Overall goal: ${plan.goal}`,
    `The change below implements task "${task.id}": ${task.title}\n${task.prompt}`,
    'Review the diff for correctness bugs, missing requirements, and changes outside the task scope. You may read files in the current directory for context. Ignore style nits.',
    `Diff:\n\`\`\`diff\n${diff || '(empty diff)'}\n\`\`\``,
    'Reply with ONLY a JSON object, no prose: {"approve": boolean, "issues": ["concrete problem and where", ...]}. Approve when there are no blocking issues.',
  ].join('\n\n');
}

export function plannerPrompt(goal: string, verify: string[]): string {
  return [
    'You are the planner for a team of coding agents working in parallel on this repository.',
    `Goal: ${goal}`,
    'Read the repository as needed, then break the goal into 1-8 tasks. Each task runs in its own git worktree, is merged after it passes verification, and must be completable independently given its deps. Prefer fewer, well-scoped tasks. Tasks that touch the same files should depend on each other rather than run in parallel.',
    'Each prompt must be self-contained: objective, files or areas to touch, and definition of done.',
    verify.length ? `Every task will be verified with: ${verify.join(', ')}` : '',
    'Reply with ONLY a JSON object, no prose:',
    '{"goal": string, "tasks": [{"id": "kebab-case", "title": string, "prompt": string, "deps": [task ids]}]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Pull the first JSON object out of model text (tolerates code fences and prose). */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1)) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}
