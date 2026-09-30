import { join } from 'node:path';
import type { DriverRegistry } from './drivers/driver.js';
import { Git } from './git.js';
import { applyReplan, READ_ONLY_TOOLS, resolveTask, validatePlan, type ReplanDraft, type ResolvedTask } from './plan.js';
import { shell } from './proc.js';
import { Sandbox } from './sandbox.js';
import { readFile } from 'node:fs/promises';
import { conflictPrompt, extractJson, replanPrompt, reviewerPrompt, workerPrompt, type Feedback } from './prompts.js';
import { newRunId, RunStore, stateRoot } from './store.js';
import { addTokens } from './tokens.js';
import type { AgentResult, PlanSpec, RunState, TaskState, TaskStatus } from './types.js';

export interface OrchestratorOptions {
  repo: string;
  plan: PlanSpec;
  drivers: DriverRegistry;
  runId?: string;
  signal?: AbortSignal;
  /** Keep worktrees of successful tasks (debugging). */
  keepWorktrees?: boolean;
  /** Continue the existing run `runId`: merged tasks stay done, everything else is retried. */
  resume?: boolean;
  /** Pre-built sandbox (tests). Otherwise one is created from `plan.sandbox`. */
  sandbox?: Sandbox;
}

const TERMINAL: TaskStatus[] = ['done', 'failed', 'blocked', 'skipped', 'replaced'];
/** Finished for the purposes of calling the run a success. */
const COMPLETE: TaskStatus[] = ['done', 'replaced'];

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
  private sandbox?: Sandbox;
  private resumeEvent?: Record<string, unknown>;
  private mergeChain: Promise<unknown> = Promise.resolve();
  private saveChain: Promise<void> = Promise.resolve();
  private saveQueued = false;

  constructor(private readonly opts: OrchestratorOptions) {
    validatePlan(opts.plan);
    // The run rewrites its own copy when it replans; the caller's plan object is left alone.
    this.plan = structuredClone(opts.plan);
    if (opts.resume && !opts.runId) throw new Error('resume needs a runId');
    this.runId = opts.runId ?? newRunId();
    this.git = new Git(opts.repo);
    this.store = new RunStore(opts.repo, this.runId);
    this.tasks = new Map(this.plan.tasks.map((t) => [t.id, resolveTask(opts.plan, t)]));
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
    if (plan.sandbox) {
      // Fail before creating any worktree if there is no working container runtime.
      this.sandbox = this.opts.sandbox ?? (await Sandbox.create(plan.sandbox));
    }
    this.integrationDir = this.worktreeDir('_integration');
    if (this.opts.resume) {
      await this.restore();
      await this.git.removeWorktree(this.integrationDir);
      await this.git.attachWorktree(this.integrationDir, this.state.integrationBranch);
      // Rewind to the last verified state: a crash mid-merge may have left an unverified commit or markers.
      await this.git.resetHard(this.integrationDir, this.state.verifiedHead!);
      await this.git.cleanUntracked(this.integrationDir);
    } else {
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
      await this.git.addWorktree(this.integrationDir, this.state.integrationBranch, base);
      this.state.verifiedHead = await this.git.revParse('HEAD', this.integrationDir);
    }
    this.state.pid = process.pid;
    await this.runSetup(this.integrationDir);
    // Persist before announcing: anyone who reacts to run_start by reading state.json must see this run, not a stale one.
    await this.save();
    if (this.resumeEvent) this.store.event('run_resume', this.resumeEvent);
    else this.store.event('run_start', { base: this.state.base, integrationBranch: this.state.integrationBranch, tasks: [...this.tasks.keys()] });
    if (this.sandbox) {
      this.store.event('sandbox', { runtime: this.sandbox.runtime, image: this.sandbox.spec.image, agent: !!this.sandbox.spec.agent });
    }

    try {
      await this.schedule();
    } finally {
      await this.git.removeWorktree(this.integrationDir);
    }

    const all = Object.values(this.state.tasks);
    this.state.status = this.opts.signal?.aborted ? 'aborted' : all.every((t) => COMPLETE.includes(t.status)) ? 'done' : 'failed';
    this.state.endedAt = new Date().toISOString();
    this.store.event('run_end', { status: this.state.status, costUsd: this.state.costUsd, tokens: this.state.tokens, costEstimated: this.state.costEstimated });
    await this.save();
    return this.state;
  }

  /**
   * Load state.json of an interrupted run. Merged tasks stay done; every other task goes back to
   * pending with fresh attempts (its spend is kept, so the budget still covers the whole run).
   */
  private async restore(): Promise<void> {
    const prev = await RunStore.loadState(this.opts.repo, this.runId);
    if (prev.status === 'running' && prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
      throw new Error(`run ${this.runId} is still running (pid ${prev.pid})`);
    }
    if (prev.status === 'done') throw new Error(`run ${this.runId} already finished`);
    const unknown = Object.keys(prev.tasks).filter((id) => !this.tasks.has(id));
    if (unknown.length) throw new Error(`plan no longer has task(s) from this run: ${unknown.join(', ')}`);
    if (!(await this.git.branchExists(prev.integrationBranch))) {
      throw new Error(`integration branch ${prev.integrationBranch} is gone; cannot resume`);
    }
    prev.verifiedHead ??= await this.git.revParse(prev.integrationBranch);
    const done: string[] = [];
    const retry: string[] = [];
    for (const id of this.tasks.keys()) {
      const t = prev.tasks[id];
      if (t?.status === 'done' || t?.status === 'replaced') {
        done.push(id);
        continue;
      }
      retry.push(id);
      prev.tasks[id] = { id, status: 'pending', attempts: 0, costUsd: t?.costUsd ?? 0, ...(t?.tokens ? { tokens: t.tokens } : {}) };
    }
    prev.status = 'running';
    delete prev.endedAt;
    prev.resumes = (prev.resumes ?? 0) + 1;
    this.state = prev;
    this.resumeEvent = { done, retry, costUsd: prev.costUsd };
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

  /** Run a setup or verify command on the host, or in the sandbox container when the plan has one. */
  private sh(command: string, cwd: string, phase: 'setup' | 'verify') {
    return shell(command, cwd, undefined, this.sandbox?.command(cwd, command, phase));
  }

  private async runSetup(cwd: string): Promise<{ ok: boolean; output: string }> {
    for (const cmd of this.plan.setup ?? []) {
      const res = await this.sh(cmd, cwd, 'setup');
      if (res.code !== 0) return { ok: false, output: `setup \`${cmd}\` exited ${res.code}\n${tail(res.stdout + res.stderr)}` };
    }
    return { ok: true, output: '' };
  }

  private async verify(task: ResolvedTask, cwd: string): Promise<{ ok: boolean; report: string }> {
    for (const cmd of task.verify) {
      const res = await this.sh(cmd, cwd, 'verify');
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
    /** Files with unresolved conflict markers from merging newer integration work into this branch. */
    let conflicts: string[] = [];
    let leftover: string[] = [];
    s.startedAt = new Date().toISOString();

    try {
      while (s.attempts < task.maxAttempts) {
        if (this.opts.signal?.aborted) return this.setStatus(s, 'skipped', { error: 'run aborted' });
        if (this.overBudget()) return this.setStatus(s, 'failed', { error: 'budget exhausted' });
        s.attempts++;
        const attempt = s.attempts;

        // Create the worktree on top of the latest integration branch so deps' merged work is present.
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

        const resolving = conflicts.length > 0;
        this.setStatus(s, resolving ? 'resolving' : 'running', { error: undefined });
        const work = await driver.run({
          prompt: resolving ? conflictPrompt(this.plan, task, conflicts, leftover) : workerPrompt(this.plan, task, feedback),
          cwd: dir,
          model: task.model,
          maxTurns: task.maxTurns,
          allowedTools: task.allowedTools,
          canEdit: true,
          signal: this.opts.signal,
          wrap: this.sandbox?.agentWrap(dir),
          onEvent: this.store.agentLog(task.id, attempt, resolving ? 'resolver' : 'worker'),
        });
        this.addUsage(s, work);
        s.sessionId = work.sessionId;
        s.summary = work.text.slice(0, 2000);

        if (resolving) {
          // Never commit a merge that still has markers; the next attempt finishes the job.
          leftover = await filesWithMarkers(dir, conflicts);
          this.store.event('resolve', { task: task.id, files: conflicts, leftover });
          if (leftover.length || !work.ok) {
            feedback.push({ attempt, reason: `Conflict resolution incomplete. Markers remain in: ${leftover.join(', ') || '(none)'}. ${work.ok ? '' : work.text.slice(0, 500)}` });
            continue;
          }
          conflicts = [];
          await this.git.commitAll(dir, `braid(${task.id}): resolve conflicts with integration\n\n${task.title}`);
        } else {
          await this.git.commitAll(dir, `braid(${task.id}): attempt ${attempt}\n\n${task.title}`);
        }

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
          // Keep the finished work: bring the newer integration state into this branch instead of redoing.
          const sync = await this.syncWithIntegration(task, dir);
          forkPoint = sync.head;
          conflicts = sync.conflicts;
          leftover = [];
          continue;
        }

        this.setStatus(s, 'done', { endedAt: new Date().toISOString() });
        if (!this.opts.keepWorktrees) await this.git.removeWorktree(dir);
        return;
      }
      const error = feedback.at(-1)?.reason.slice(0, 4000) ?? 'no attempts made';
      // Not "failed" yet: that would block the dependents before the planner has had its say.
      if (this.canReplan()) {
        this.setStatus(s, 'replanning', { error });
        if (await this.replan(task, dir, feedback)) return;
      }
      this.setStatus(s, 'failed', { endedAt: new Date().toISOString(), error });
    } catch (err) {
      this.setStatus(s, 'failed', { endedAt: new Date().toISOString(), error: String(err) });
    } finally {
      await this.save();
    }
  }

  /**
   * A task failed for good: ask the planner to split or rewrite it so its dependents can still run.
   * True when the task became `replaced` and the graph gained the new tasks; false leaves the caller to fail it.
   */
  private canReplan(): boolean {
    return (this.state.replans ?? 0) < (this.plan.maxReplans ?? 0) && !this.opts.signal?.aborted && !this.overBudget();
  }

  private async replan(task: ResolvedTask, dir: string, feedback: Feedback[]): Promise<boolean> {
    const s = this.state.tasks[task.id]!;
    const used = this.state.replans ?? 0;
    this.state.replans = used + 1;
    const fail = (reason: string) => {
      this.store.event('replan', { task: task.id, ok: false, reason: reason.slice(0, 500) });
      return false;
    };

    try {
      const others = [...this.tasks.values()]
        .filter((t) => t.id !== task.id)
        .map((t) => ({ id: t.id, title: t.title, status: this.state.tasks[t.id]!.status, deps: t.deps }));
      const res = await this.opts.drivers.get(task.driver).run({
        prompt: replanPrompt(this.plan, task, feedback, others),
        cwd: dir,
        model: task.model,
        allowedTools: READ_ONLY_TOOLS,
        canEdit: false,
        maxTurns: 20,
        signal: this.opts.signal,
        wrap: this.sandbox?.agentWrap(dir),
        onEvent: this.store.agentLog(task.id, used + 1, 'replanner'),
      });
      this.addUsage(s, res);
      if (!res.ok) return fail(`planner failed: ${res.text}`);
      const draft = extractJson<ReplanDraft>(res.text);
      if (!draft) return fail('planner returned no JSON');

      const done = new Set(Object.values(this.state.tasks).filter((t) => t.status === 'done').map((t) => t.id));
      const { added, rewired } = applyReplan(this.plan, task.id, draft, done);

      for (const [id, deps] of Object.entries(rewired)) {
        this.plan.tasks.find((t) => t.id === id)!.deps = deps;
        this.tasks.get(id)!.deps = deps;
      }
      for (const spec of added) {
        this.plan.tasks.push(spec);
        this.tasks.set(spec.id, resolveTask(this.plan, spec));
        this.state.tasks[spec.id] = { id: spec.id, status: 'pending', attempts: 0, costUsd: 0, replanOf: task.id };
      }
      await this.store.savePlan(this.plan);
      const ids = added.map((t) => t.id);
      this.store.event('replan', { task: task.id, ok: true, reason: draft.reason ?? '', added: ids });
      this.setStatus(s, 'replaced', { replacedBy: ids, endedAt: new Date().toISOString() });
      return true;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private addUsage(s: TaskState, r: AgentResult): void {
    s.costUsd += r.costUsd;
    this.state.costUsd += r.costUsd;
    if (r.tokens) {
      s.tokens = addTokens(s.tokens, r.tokens);
      this.state.tokens = addTokens(this.state.tokens, r.tokens);
    }
    if (r.costEstimated) this.state.costEstimated = true;
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
      wrap: this.sandbox?.agentWrap(dir),
      onEvent: this.store.agentLog(task.id, attempt, 'reviewer'),
    });
    this.addUsage(s, res);
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
        return { ok: false, reason: `Your change conflicted with work other tasks merged first.\n${tail(m.detail, 1500)}` };
      }
      const v = await this.verify(task, this.integrationDir);
      if (!v.ok) {
        await this.git.resetHard(this.integrationDir, before);
        this.store.event('merge_reverted', { task: task.id });
        return { ok: false, reason: `Your change passed on its own but broke verification once combined with other tasks' merged work, which is now in your worktree. Fix your change so the combined tree passes; do not redo the task.\n${v.report}` };
      }
      this.state.verifiedHead = await this.git.revParse('HEAD', this.integrationDir);
      return { ok: true, reason: '' };
    });
    this.mergeChain = job.catch(() => undefined);
    return job;
  }

  /**
   * Merge the current integration head into a task branch. Serialized with merges so the
   * head cannot move mid-read. Conflicts are left in the worktree for the resolver agent.
   */
  private syncWithIntegration(task: ResolvedTask, dir: string): Promise<{ head: string; conflicts: string[] }> {
    const job = this.mergeChain.then(async () => {
      const head = await this.git.revParse('HEAD', this.integrationDir);
      const { conflicts } = await this.git.mergeIn(dir, head, `braid(${task.id}): merge latest integration`);
      this.store.event('sync', { task: task.id, conflicts });
      return { head, conflicts };
    });
    this.mergeChain = job.catch(() => undefined);
    return job;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const MARKER_RE = /^(<{7}|>{7})(\s|$)|^={7}$/m;

/** Conflicted files that still contain git conflict markers. Deleted files count as resolved. */
async function filesWithMarkers(dir: string, files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf8').catch(() => '');
    if (MARKER_RE.test(text)) out.push(f);
  }
  return out;
}

function tail(text: string, n = 4000): string {
  return text.length > n ? `...${text.slice(-n)}` : text;
}
