// Shared by the `braid clean` and `braid pr` tests: a scratch repository and runs laid out the way the orchestrator
// leaves them (state.json, plan.json, an integration branch, kept task worktrees), without running an agent.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { Git } from '../src/git.js';
import { exec } from '../src/proc.js';
import type { PlanSpec, RunState, TaskState } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

export const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
export const git = (cwd: string, ...args: string[]) => exec('git', [...IDENTITY, ...args], { cwd });
export const gitOut = async (cwd: string, ...args: string[]): Promise<string> => (await git(cwd, ...args)).stdout.trim();

export async function makeRepo(): Promise<string> {
  const dir = tmp('braid-cp-');
  await git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

/** A repo whose `origin` is a bare repository on disk, so a push has somewhere to go and nothing leaves the machine. */
export async function makeRepoWithOrigin(): Promise<{ repo: string; origin: string }> {
  const repo = await makeRepo();
  const origin = tmp('braid-origin-');
  await git(origin, 'init', '-q', '--bare', '-b', 'main');
  await git(repo, 'remote', 'add', 'origin', origin);
  await git(repo, 'push', '-q', 'origin', 'main');
  return { repo, origin };
}

/** The pid of a process that has exited. */
export function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    child.on('exit', () => resolve(child.pid!));
  });
}

export interface FakeRun {
  status?: RunState['status'];
  pid?: number;
  endedAt?: string;
  /** Tasks that keep a worktree and a branch, as a failed task or --keep-worktrees leaves them. */
  kept?: string[];
  /** Commits on the integration branch beyond main. */
  integrationCommits?: number;
  /** Commits a kept task branch has that the integration branch does not. */
  taskCommits?: Record<string, number>;
  /** A crashed run leaves its integration worktree behind. */
  integrationWorktree?: boolean;
  goal?: string;
  tasks?: Record<string, Partial<TaskState>>;
  verify?: string[];
  planTasks?: PlanSpec['tasks'];
  /** Leave state.json out (a run that is only just starting). */
  noState?: boolean;
}

export async function makeRun(repo: string, id: string, o: FakeRun = {}): Promise<{ integration: string; worktrees: string }> {
  const g = new Git(repo);
  const worktrees = join(repo, '.braid', 'worktrees', id);
  const integration = `braid/${id}/integration`;
  const integDir = join(worktrees, '_integration');
  await g.addWorktree(integDir, integration, 'main');
  for (let i = 0; i < (o.integrationCommits ?? 0); i++) await git(integDir, 'commit', '-q', '--allow-empty', '-m', `work ${i + 1}`);
  for (const t of o.kept ?? []) {
    const dir = join(worktrees, t);
    await g.addWorktree(dir, `braid/${id}/task-${t}`, integration);
    for (let i = 0; i < (o.taskCommits?.[t] ?? 0); i++) await git(dir, 'commit', '-q', '--allow-empty', '-m', `${t} attempt ${i + 1}`);
  }
  if (!o.integrationWorktree) await g.removeWorktree(integDir);

  const runDir = join(repo, '.braid', 'runs', id);
  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  const status = o.status ?? 'done';
  const tasks: Record<string, TaskState> = {};
  for (const [taskId, extra] of Object.entries(o.tasks ?? Object.fromEntries((o.kept ?? ['a']).map((t) => [t, {}])))) {
    tasks[taskId] = { id: taskId, status: status === 'done' ? 'done' : 'failed', attempts: 1, costUsd: 0, ...extra };
  }
  const plan: PlanSpec = {
    goal: o.goal ?? 'make it better',
    driver: 'mock',
    ...(o.verify ? { verify: o.verify } : {}),
    tasks: o.planTasks ?? Object.keys(tasks).map((t) => ({ id: t, title: `Task ${t}`, prompt: 'p' })),
  };
  const state: RunState = {
    runId: id,
    repo,
    base: 'main',
    integrationBranch: integration,
    status,
    costUsd: 0,
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    ...(status === 'running' ? {} : { endedAt: o.endedAt ?? new Date().toISOString() }),
    ...(o.pid ? { pid: o.pid } : {}),
    tasks,
  };
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(plan, null, 2));
  if (!o.noState) writeFileSync(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
  return { integration, worktrees };
}
