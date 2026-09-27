import { join } from 'node:path';
import type { DriverRegistry } from './drivers/driver.js';
import { Git } from './git.js';
import { READ_ONLY_TOOLS, resolveTask, validatePlan, type ResolvedTask } from './plan.js';
import { shell } from './proc.js';
import { extractJson, reviewerPrompt, workerPrompt, type Feedback } from './prompts.js';
import { newRunId, RunStore, stateRoot } from './store.js';
import type { PlanSpec, RunState, TaskState, TaskStatus } from './types.js';

export interface OrchestratorOptions {
  repo: string;
  plan: PlanSpec;
  drivers: DriverRegistry;
  runId?: string;
  signal?: AbortSignal;
  /** Keep worktrees of successful tasks (debugging). */
  keepWorktrees?: boolean;
}

const TERMINAL: TaskStatus[] = ['done', 'failed', 'blocked', 'skipped'];

/**
 * Deterministic scheduler. The LLM does the work inside each task; code decides
 * ordering, isolation, verification, retries, merging and spend.
 */
export class Orchestrator {
  readonly runId: string;
  readonly store: RunStore;
  private readonly git: Git;
  private readonly plan: PlanSpec;
  private readonly tasks: Map<string, ResolvedTask>;
  private state!: RunState;
  private integrationDir!: string;
  private mergeChain: Promise<unknown> = Promise.resolve();
  private saveChain: Promise<void> = Promise.resolve();
  private saveQueued = false;

  constructor(private readonly opts: OrchestratorOptions) {
    validatePlan(opts.plan);
    this.plan = opts.plan;
    this.runId = opts.runId ?? newRunId();
    this.git = new Git(opts.repo);
    this.store = new RunStore(opts.repo, this.runId);
    this.tasks = new Map(opts.plan.tasks.map((t) => [t.id, resolveTask(opts.plan, t)]));
  }

  get repo(): string {
    return this.opts.repo;
  }

  private worktreeDir(name: string): string {
    return join(stateRoot(this.opts.repo), 'worktrees', this.runId, name);
  }

  private branch(name: string): string {
    return `braid/${this.runId}/${name}`;
  }

  /** Serialized, coalesced snapshot writes: concurrent callers share the next write. */
  private save(): Promise<void> {
    if (this.saveQueued) return this.saveChain;
    this.saveQueued = true;
    this.saveChain = this.saveChain.then(async () => {
      this.saveQueued = false;
      await this.store.saveState(this.state);
    });
    return this.saveChain;
  }

  private setStatus(t: TaskState, status: TaskStatus, extra: Partial<TaskState> = {}): void {
    Object.assign(t, extra, { status });
    this.store.event('task_status', { task: t.id, status, ...extra });
    void this.save().catch(() => undefined);
  }

  async run(): Promise<RunState> {
    const { repo, plan } = this.opts;
    await this.git.excludeStateDir();
    const base = plan.base ?? (await this.git.currentBranch());
    this.state = {
      runId: this.runId,
      repo,
      base,
      integrationBranch: this.branch('integration'),
      status: 'running',
      costUsd: 0,
      createdAt: new Date().toISOString(),
      tasks: Object.fromEntries([...this.tasks.keys()].map((id) => [id, { id, status: 'pending', attempts: 0, costUsd: 0 }])),
    };
    await this.store.savePlan(plan);
    this.integrationDir = this.worktreeDir('_integration');
    await this.git.addWorktree(this.integrationDir, this.state.integrationBranch, base);
    await this.runSetup(this.integrationDir);
    this.store.event('run_start', { base, integrationBranch: this.state.integrationBranch, tasks: [...this.tasks.keys()] });
    await this.save();

    try {
      await this.schedule();
    } finally {
      await this.git.removeWorktree(this.integrationDir);
    }

    const all = Object.values(this.state.tasks);
    this.state.status = this.opts.signal?.aborted ? 'aborted' : all.every((t) => t.status === 'done') ? 'done' : 'failed';
    this.state.endedAt = new Date().toISOString();
    this.store.event('run_end', { status: this.state.status, costUsd: this.state.costUsd });
    await this.save();
    return this.state;
  }

  private overBudget(): boolean {
    return this.plan.budgetUsd !== undefined && this.state.costUsd >= this.plan.budgetUsd;
  }

  private async schedule(): Promise<void> {
    const concurrency = Math.max(1, this.plan.concurrency ?? 3);
    const running = new Map<string, Promise<void>>();

    for (;;) {
      const states = this.state.tasks;
      const stopping = this.opts.signal?.aborted || this.overBudget();

      for (const [id, task] of this.tasks) {
        const s = states[id]!;
        if (s.status !== 'pending') continue;
        if (stopping) {
          this.setStatus(s, 'skipped', { error: this.opts.signal?.aborted ? 'run aborted' : 'budget exhausted' });
          continue;
        }
        const bad = task.deps.find((d) => ['failed', 'blocked', 'skipped'].includes(states[d]!.status));
        if (bad) {
          this.setStatus(s, 'blocked', { error: `dependency "${bad}" did not complete` });
          continue;
        }
        const ready = task.deps.every((d) => states[d]!.status === 'done');
        if (ready && running.size < concurrency) {
          running.set(id, this.runTask(task).finally(() => running.delete(id)));
        }
      }
      await this.save();

      if (running.size === 0) {
        if (Object.values(states).every((s) => TERMINAL.includes(s.status))) return;
        // Pending tasks with nothing running and nothing ready means a scheduling bug; fail loudly.
        throw new Error('scheduler stalled: pending tasks but none runnable');
      }
      await Promise.race(running.values());
    }
  }

  private async runSetup(cwd: string): Promise<{ ok: boolean; output: string }> {
    for (const cmd of this.plan.setup ?? []) {
      const res = await shell(cmd, cwd);
      if (res.code !== 0) return { ok: false, output: `setup \`${cmd}\` exited ${res.code}\n${tail(res.stdout + res.stderr)}` };
    }
    return { ok: true, output: '' };
  }

  private async verify(task: ResolvedTask, cwd: string): Promise<{ ok: boolean; report: string }> {
    for (const cmd of task.verify) {
      const res = await shell(cmd, cwd);
      this.store.event('verify', { task: task.id, cmd, code: res.code, dir: cwd === this.integrationDir ? 'integration' : 'task' });
      if (res.code !== 0) return { ok: false, report: `\`${cmd}\` exited ${res.code}:\n${tail(res.stdout + res.stderr)}` };
    }
    return { ok: true, report: '' };
  }

  private async runTask(task: ResolvedTask): Promise<void> {
    const s = this.state.tasks[task.id]!;
    const driver = this.opts.drivers.get(task.driver);
    const dir = this.worktreeDir(task.id);
    const branch = this.branch(`task-${task.id}`);
    const feedback: Feedback[] = [];
    let forkPoint = '';
    let fresh = true;
    s.startedAt = new Date().toISOString();

    try {
      while (s.attempts < task.maxAttempts) {
        if (this.opts.signal?.aborted) return this.setStatus(s, 'skipped', { error: 'run aborted' });
        if (this.overBudget()) return this.setStatus(s, 'failed', { error: 'budget exhausted' });
        s.attempts++;
        const attempt = s.attempts;

        // (Re)create the worktree on top of the latest integration branch so deps' merged work is present.
        if (fresh) {
          await this.git.removeWorktree(dir);
          await this.git.deleteBranch(branch);
          forkPoint = await this.git.revParse('HEAD', this.integrationDir);
          await this.git.addWorktree(dir, branch, forkPoint);
          const setup = await this.runSetup(dir);
          if (!setup.ok) return this.setStatus(s, 'failed', { error: setup.output });
          fresh = false;
        }
        s.branch = branch;

        this.setStatus(s, 'running', { error: undefined });
        const log = this.store.agentLog(task.id, attempt, 'worker');
        const work = await driver.run({
          prompt: workerPrompt(this.plan, task, feedback),
          cwd: dir,
          model: task.model,
          maxTurns: task.maxTurns,
          allowedTools: task.allowedTools,
          canEdit: true,
          signal: this.opts.signal,
          onEvent: log,
        });
        this.addCost(s, work.costUsd);
        s.sessionId = work.sessionId;
        s.summary = work.text.slice(0, 2000);
        await this.git.commitAll(dir, `braid(${task.id}): attempt ${attempt}\n\n${task.title}`);

        if (!work.ok) {
          feedback.push({ attempt, reason: `The agent run ended with an error: ${work.text.slice(0, 1500)}` });
          continue;
        }

        this.setStatus(s, 'verifying');
        const v = await this.verify(task, dir);
        if (!v.ok) {
          feedback.push({ attempt, reason: `Verification failed.\n${v.report}` });
          continue;
        }

        if (task.review) {
          this.setStatus(s, 'reviewing');
          const verdict = await this.review(task, dir, forkPoint, attempt);
          if (!verdict.approve) {
            feedback.push({ attempt, reason: `Reviewer requested changes:\n- ${verdict.issues.join('\n- ')}` });
            continue;
          }
        }

        this.setStatus(s, 'merging');
        const merged = await this.serialMerge(task, branch);
        if (!merged.ok) {
          feedback.push({ attempt, reason: merged.reason });
          fresh = true; // redo on top of the newer integration branch
          continue;
        }

        this.setStatus(s, 'done', { endedAt: new Date().toISOString() });
        if (!this.opts.keepWorktrees) await this.git.removeWorktree(dir);
        return;
      }
      this.setStatus(s, 'failed', {
        endedAt: new Date().toISOString(),
        error: feedback.at(-1)?.reason.slice(0, 4000) ?? 'no attempts made',
      });
    } catch (err) {
      this.setStatus(s, 'failed', { endedAt: new Date().toISOString(), error: String(err) });
    } finally {
      await this.save();
    }
  }

  private addCost(s: TaskState, usd: number): void {
    s.costUsd += usd;
    this.state.costUsd += usd;
  }

  private async review(task: ResolvedTask, dir: string, forkPoint: string, attempt: number) {
    const s = this.state.tasks[task.id]!;
    const diff = await this.git.diff(dir, forkPoint);
    const res = await this.opts.drivers.get(task.driver).run({
      prompt: reviewerPrompt(this.plan, task, diff),
      cwd: dir,
      model: task.model,
      allowedTools: READ_ONLY_TOOLS,
      canEdit: false,
      maxTurns: 15,
      signal: this.opts.signal,
      onEvent: this.store.agentLog(task.id, attempt, 'reviewer'),
    });
    this.addCost(s, res.costUsd);
    const verdict = extractJson<{ approve?: boolean; issues?: string[] }>(res.text);
    const out = {
      approve: res.ok && verdict?.approve === true,
      issues: verdict?.issues?.length ? verdict.issues : [res.ok ? 'reviewer gave no parseable verdict' : `reviewer failed: ${res.text.slice(0, 500)}`],
    };
    this.store.event('review', { task: task.id, approve: out.approve, issues: out.approve ? [] : out.issues });
    return out;
  }

  /**
   * Merges are serialized: merge into integration, then re-run verification on the
   * combined tree. A merge that breaks the build is rolled back, so the integration
   * branch only ever holds verified states.
   */
  private serialMerge(task: ResolvedTask, branch: string): Promise<{ ok: boolean; reason: string }> {
    const job = this.mergeChain.then(async () => {
      const before = await this.git.revParse('HEAD', this.integrationDir);
      const m = await this.git.merge(this.integrationDir, branch, `braid: merge ${task.id} - ${task.title}`);
      this.store.event('merge', { task: task.id, ok: m.ok });
      if (!m.ok) {
        return { ok: false, reason: `Your change conflicted with work other tasks merged first. The worktree was reset onto the latest merged state; redo the task on top of it.\n${tail(m.detail, 1500)}` };
      }
      const v = await this.verify(task, this.integrationDir);
      if (!v.ok) {
        await this.git.resetHard(this.integrationDir, before);
        this.store.event('merge_reverted', { task: task.id });
        return { ok: false, reason: `Your change passed on its own but broke verification once combined with other tasks' merged work. The worktree was reset onto the latest merged state; redo the task on top of it.\n${v.report}` };
      }
      return { ok: true, reason: '' };
    });
    this.mergeChain = job.catch(() => undefined);
    return job;
  }
}

function tail(text: string, n = 4000): string {
  return text.length > n ? `...${text.slice(-n)}` : text;
}
