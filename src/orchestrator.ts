import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DriverRegistry, DriverRunOptions } from './drivers/driver.js';
import { AgentUnavailableError, classifyAgentFailure } from './failures.js';
import { Git } from './git.js';
import { terminalHint } from './hints.js';
import { applyReplan, READ_ONLY_TOOLS, resolveTask, validatePlan, type ReplanDraft, type ResolvedTask } from './plan.js';
import { hostIdentity } from './host.js';
import { abortError, pidAlive, SHELL_TIMEOUT_MS, shell, type ShellResult } from './proc.js';
import { Sandbox } from './sandbox.js';
import { readFile } from 'node:fs/promises';
import { conflictPrompt, extractJson, replanPrompt, reviewerPrompt, workerPrompt, type Feedback } from './prompts.js';
import { newRunId, RunStore, stateRoot } from './store.js';
import { addTokens, formatTokens } from './tokens.js';
import { touchesOverlap } from './touches.js';
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
  /** Pauses before each retry of an agent call the provider turned away (rate limit, overload, network). Tests shorten it. */
  retryDelaysMs?: number[];
}

/** The longest delay a timer takes: above it Node fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A task used up its own token allowance. Ends that task as failed; the run carries on with the others. */
class TaskBudgetError extends Error {}

/**
 * A call that was waiting to be retried found, on waking, that something stopped the run meanwhile (a limit, its agent
 * out of quota). Ends the task as failed, saying what it was; like any call the provider never answered, it is no try.
 */
class CallStoppedError extends Error {
  constructor(
    reason: string,
    readonly role: string,
  ) {
    super(reason);
  }
}

/** After a rate limit or an outage: wait, try again, wait longer. About five minutes in all before giving up. */
const RETRY_DELAYS_MS = [20_000, 40_000, 80_000, 160_000];

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
  /** Agents that are out of usage or credit, with the message. Tasks that need one do not start; the others carry on. */
  private halted = new Map<string, string>();
  /** Fresh and output tokens the run had used before this process took it over; a resumed run gets a fresh allowance. */
  private tokenBaseline = 0;
  /** Fresh and output tokens each task had used before this process took it over: a resumed task gets a fresh allowance. */
  private taskBaseline = new Map<string, number>();
  private mergeChain: Promise<unknown> = Promise.resolve();
  private saveChain: Promise<void> = Promise.resolve();
  private saveQueued = false;

  constructor(private readonly opts: OrchestratorOptions) {
    validatePlan(opts.plan);
    // The run rewrites its own copy when it replans; the caller's plan object is left alone.
    this.plan = structuredClone(opts.plan);
    if (opts.resume && !opts.runId) throw new Error('resume needs a runId');
    this.tasks = new Map(this.plan.tasks.map((t) => [t.id, resolveTask(opts.plan, t)]));
    // Fail before any work starts (and before a run folder exists) if a task, or its reviewer, names an agent braid does not have.
    for (const t of this.tasks.values()) {
      opts.drivers.get(t.driver);
      opts.drivers.get(t.reviewer.driver);
    }
    this.runId = opts.runId ?? newRunId();
    this.git = new Git(opts.repo, opts.signal);
    this.store = new RunStore(opts.repo, this.runId);
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

  /** Serialized, coalesced snapshot writes: concurrent callers share the next write. Never rejects. */
  private save(): Promise<void> {
    if (this.saveQueued) return this.saveChain;
    this.saveQueued = true;
    // A failed write must not poison the chain: every later snapshot would reject without even trying.
    this.saveChain = this.saveChain.catch(() => undefined).then(async () => {
      this.saveQueued = false;
      try {
        await this.store.saveState(this.state);
      } catch (err) {
        // The snapshot is a view of the run, not the run: a failed write (disk full, a locked file) must not take
        // down tasks that are mid-flight. The next write carries the same state.
        try {
          this.store.event('state_save_failed', { message: String(err).slice(0, 300) });
        } catch {
          /* the log is as unwritable as the snapshot */
        }
      }
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
    this.integrationDir = this.worktreeDir('_integration');
    // A resumed run is claimed first: restore() writes this process into state.json before anything slow. Until then
    // the file still shows the run's previous end, and `braid clean` takes the run for finished while its worktrees
    // are being set up again.
    const previous = this.opts.resume ? await this.restore() : undefined;
    let setup: { ok: boolean; output: string };
    try {
      if (plan.sandbox) {
        // Fail before creating any worktree if there is no working container runtime.
        this.sandbox = this.opts.sandbox ?? (await Sandbox.create(plan.sandbox, this.opts.signal));
      }
      if (previous) {
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
        await this.git.addWorktree(this.integrationDir, this.state.integrationBranch, base, false);
        this.state.verifiedHead = await this.git.revParse('HEAD', this.integrationDir);
      }
      this.state.pid = process.pid;
      this.state.host = hostIdentity();
      await this.save();
      setup = await this.runSetup(this.integrationDir);
    } catch (err) {
      // The run never started. A resume that failed this early leaves state.json as it found it, not as a run that is running.
      if (previous) await this.store.saveState(previous).catch(() => undefined);
      throw err;
    }
    // Persist before announcing: anyone who reacts to run_start by reading state.json must see this run, not a stale one.
    await this.save();
    if (this.resumeEvent) this.store.event('run_resume', this.resumeEvent);
    else this.store.event('run_start', { base: this.state.base, integrationBranch: this.state.integrationBranch, tasks: [...this.tasks.keys()] });
    if (this.sandbox) {
      this.store.event('sandbox', { runtime: this.sandbox.runtime, image: this.sandbox.spec.image, agent: !!this.sandbox.spec.agent });
      if (this.sandbox.swept.length) this.store.event('sandbox_sweep', { count: this.sandbox.swept.length });
    }

    try {
      if (!setup.ok && !this.opts.signal?.aborted) {
        // Every post-merge check runs in this tree: with it half-prepared each task would be blamed for the setup.
        const error = `setup failed in the integration worktree, so nothing was started. ${setup.output}`.slice(0, 4000);
        this.store.event('run_error', { message: error });
        for (const t of Object.values(this.state.tasks)) if (t.status === 'pending') this.setStatus(t, 'skipped', { error });
      } else {
        await this.schedule();
      }
    } finally {
      await this.git.removeWorktree(this.integrationDir);
    }

    const all = Object.values(this.state.tasks);
    // A Stop that lands after the last task merged still leaves a finished run.
    this.state.status = all.every((t) => COMPLETE.includes(t.status)) ? 'done' : this.opts.signal?.aborted ? 'aborted' : 'failed';
    this.state.endedAt = new Date().toISOString();
    this.store.event('run_end', { status: this.state.status, costUsd: this.state.costUsd, tokens: this.state.tokens, costEstimated: this.state.costEstimated });
    await this.save();
    return this.state;
  }

  /**
   * Load state.json of an interrupted run. Merged tasks stay done; every other task goes back to
   * pending with fresh attempts (its spend is kept, so the budget still covers the whole run). Marks the run as
   * running under this process on disk at once, and returns state.json as it was, for putting back if the resume fails.
   */
  private async restore(): Promise<RunState> {
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
    const onDisk = structuredClone(prev);
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
      if (t?.tokens) this.taskBaseline.set(id, t.tokens.input + t.tokens.output);
      prev.tasks[id] = { id, status: 'pending', attempts: 0, costUsd: t?.costUsd ?? 0, ...(t?.tokens ? { tokens: t.tokens } : {}) };
    }
    prev.status = 'running';
    delete prev.endedAt;
    prev.resumes = (prev.resumes ?? 0) + 1;
    this.tokenBaseline = prev.tokens ? prev.tokens.input + prev.tokens.output : 0;
    this.state = prev;
    this.resumeEvent = { done, retry, costUsd: prev.costUsd };
    // Only what changes the verdict on the run: the rest of the file stays as the interrupted run left it until the
    // first full snapshot, after the worktrees are back.
    const { endedAt: _ended, ...claimed } = onDisk;
    await this.store.saveState({ ...claimed, status: 'running', pid: process.pid, host: hostIdentity() });
    return onDisk;
  }

  /** Why the run has used up what it was allowed, or undefined while it has not. */
  private limitReached(): string | undefined {
    if (this.plan.budgetUsd !== undefined && this.state.costUsd >= this.plan.budgetUsd) return 'budget exhausted';
    // Only a run-wide cap the plan asks for; what keeps a loop from spending without end is the allowance per task.
    const cap = this.plan.budgetTokens ?? 0;
    const used = this.state.tokens ? this.state.tokens.input + this.state.tokens.output - this.tokenBaseline : 0;
    if (cap > 0 && used >= cap) {
      return `token budget exhausted (${formatTokens(used)} fresh and output tokens used; the limit is ${formatTokens(cap)}). Raise budgetTokens in the plan, or set it to 0 for no limit`;
    }
    return undefined;
  }

  /** Why this task has used up its own token allowance, or undefined while it has not. */
  private taskLimitReached(task: ResolvedTask): string | undefined {
    const t = this.state.tasks[task.id]!;
    const cap = task.budgetTokens;
    const used = (t.tokens ? t.tokens.input + t.tokens.output : 0) - (this.taskBaseline.get(task.id) ?? 0);
    if (cap > 0 && used >= cap) {
      return `token budget exhausted for this task (${formatTokens(used)} fresh and output tokens used by its agent calls; the limit is ${formatTokens(cap)}). Raise taskBudgetTokens in the plan or budgetTokens on this task, or set it to 0 for no limit`;
    }
    return undefined;
  }

  /**
   * Why nothing new should start (for `task`, when given, and its driver), or undefined to carry on. A task that is
   * reviewed on another agent is as stuck as one whose worker's agent ran out of quota: it can no more finish.
   */
  private stopReason(driver?: string, task?: ResolvedTask): string | undefined {
    if (this.opts.signal?.aborted) return 'run aborted';
    return (
      this.limitReached() ??
      (task ? this.taskLimitReached(task) : undefined) ??
      (driver ? this.halted.get(driver) : undefined) ??
      (task?.review ? this.halted.get(task.reviewer.driver) : undefined)
    );
  }

  /** Throws the abort the run was given, so every phase ends through the same path in runTask. */
  private checkpoint(): void {
    if (this.opts.signal?.aborted) throw abortError();
  }

  /** End a task that must not go on because a limit was hit or an agent ran out of quota between two steps. */
  private halt(s: TaskState, stop: string): void {
    if (this.opts.signal?.aborted) this.setStatus(s, 'skipped', { error: 'run aborted' });
    else this.setStatus(s, 'failed', { endedAt: new Date().toISOString(), error: stop });
  }

  private async schedule(): Promise<void> {
    const concurrency = Math.max(1, this.plan.concurrency ?? 3);
    const running = new Map<string, Promise<void>>();

    for (;;) {
      const states = this.state.tasks;

      // Stops and failures first, until nothing changes: a dependent can be listed before the task it waits for, and a
      // task already started (still in setup, so still "pending") is not ours to skip.
      for (let changed = true; changed; ) {
        changed = false;
        for (const [id, task] of this.tasks) {
          const s = states[id]!;
          if (s.status !== 'pending' || running.has(id)) continue;
          const stop = this.stopReason(task.driver, task);
          if (stop) {
            this.setStatus(s, 'skipped', { error: stop });
            changed = true;
            continue;
          }
          const bad = task.deps.find((d) => ['failed', 'blocked', 'skipped'].includes(states[d]!.status));
          if (bad) {
            this.setStatus(s, 'blocked', { error: `dependency "${bad}" did not complete` });
            changed = true;
          }
        }
      }

      for (const [id, task] of this.tasks) {
        const s = states[id]!;
        if (s.status !== 'pending' || running.has(id)) continue;
        const ready = task.deps.every((d) => states[d]!.status === 'done');
        const free = ready && running.size < concurrency;
        // Say why a task with a free slot still waits, so the dashboard need not guess that it is short of an agent.
        const holders = free ? this.overlapping(task, running) : [];
        if (holders.length) s.heldBy = holders;
        else delete s.heldBy;
        if (free && !holders.length) running.set(id, this.runTask(task).finally(() => running.delete(id)));
      }
      // Whether this pass left nothing running. Tasks end while the snapshot is written, so what is running after the
      // write says nothing about whether the pass left the run stuck.
      const idle = running.size === 0;
      await this.save();

      if (running.size === 0) {
        if (Object.values(states).every((s) => TERMINAL.includes(s.status))) return;
        // A ready task that was held back for one that ended during the write only needs another pass.
        if (!idle) continue;
        // Pending tasks with nothing running and nothing ready means a scheduling bug; fail loudly.
        throw new Error('scheduler stalled: pending tasks but none runnable');
      }
      await Promise.race(running.values());
    }
  }

  /**
   * The tasks that have started and would change the same paths as this one. Counts everything in `running`, not just
   * tasks whose status says so: one still in worktree setup is "pending" but already owns its paths. With nothing
   * running this is empty, so overlapping tasks wait for each other but the scheduler cannot stall on them.
   */
  private overlapping(task: ResolvedTask, running: ReadonlyMap<string, unknown>): string[] {
    return [...running.keys()].filter((id) => id !== task.id && touchesOverlap(task.touches, this.tasks.get(id)?.touches ?? []));
  }

  /** Run a setup or verify command on the host, or in the sandbox container when the plan has one. */
  private sh(command: string, cwd: string, phase: 'setup' | 'verify') {
    return shell(command, cwd, SHELL_TIMEOUT_MS, this.sandbox?.command(cwd, command, phase), this.opts.signal);
  }

  private async runSetup(cwd: string): Promise<{ ok: boolean; output: string }> {
    for (const cmd of this.plan.setup ?? []) {
      const res = await this.sh(cmd, cwd, 'setup');
      if (res.code !== 0) return { ok: false, output: `setup \`${cmd}\` ${describeExit(res)}\n${failureTail(res.stdout + res.stderr)}` };
    }
    return { ok: true, output: '' };
  }

  private async verify(task: ResolvedTask, cwd: string, commands: string[] = task.verify): Promise<{ ok: boolean; report: string }> {
    for (const cmd of commands) {
      const res = await this.sh(cmd, cwd, 'verify');
      // Cut short by an abort: not a verdict on the work, so it is neither logged as a check nor fed back.
      if (res.aborted) throw abortError();
      this.store.event('verify', { task: task.id, cmd, code: res.code, dir: cwd === this.integrationDir ? 'integration' : 'task' });
      if (res.code !== 0) return { ok: false, report: `\`${cmd}\` ${describeExit(res)}:\n${failureTail(res.stdout + res.stderr)}` };
    }
    return { ok: true, report: '' };
  }

  private async runTask(task: ResolvedTask): Promise<void> {
    const s = this.state.tasks[task.id]!;
    const dir = this.worktreeDir(task.id);
    const branch = this.branch(`task-${task.id}`);
    const feedback: Feedback[] = [];
    let forkPoint = '';
    let fresh = true;
    /** Files with unresolved conflict markers from merging newer integration work into this branch. */
    let conflicts: string[] = [];
    /** For those files, how many `=======` lines are content (a Markdown or RST heading underline), not a conflict separator. */
    let underlines = new Map<string, number>();
    let leftover: string[] = [];
    s.startedAt = new Date().toISOString();

    try {
      while (s.attempts < task.maxAttempts) {
        const stop = this.stopReason(task.driver, task);
        if (stop) return this.halt(s, stop);
        s.attempts++;
        const attempt = s.attempts;

        // Create the worktree on top of the latest integration branch so deps' merged work is present.
        if (fresh) {
          await this.git.removeWorktree(dir);
          await this.git.deleteBranch(branch);
          // The last verified head, not the live one: while another task's merge is being checked the head already is
          // that merge, and a task forked from it would carry the merge along even when the check rolls it back.
          forkPoint = this.state.verifiedHead ?? (await this.git.revParse('HEAD', this.integrationDir));
          await this.git.addWorktree(dir, branch, forkPoint);
          const setup = await this.runSetup(dir);
          if (!setup.ok) return this.opts.signal?.aborted ? this.setStatus(s, 'skipped', { error: 'run aborted' }) : this.setStatus(s, 'failed', { error: setup.output });
          fresh = false;
        }
        s.branch = branch;
        // Setup can take minutes, long enough for a Stop, a limit or an agent's quota to have arrived meanwhile.
        const stopAfterSetup = this.stopReason(task.driver, task);
        if (stopAfterSetup) {
          s.attempts--;
          return this.halt(s, stopAfterSetup);
        }

        const resolving = conflicts.length > 0;
        this.setStatus(s, resolving ? 'resolving' : 'running', { error: undefined });
        const role = resolving ? 'resolver' : 'worker';
        const work = await this.callAgent(task, role, {
          prompt: resolving ? conflictPrompt(this.plan, task, conflicts, leftover) : workerPrompt(this.plan, task, feedback),
          cwd: dir,
          model: task.model,
          maxTurns: task.maxTurns,
          allowedTools: task.allowedTools,
          canEdit: true,
          wrap: this.sandbox?.agentWrap(dir),
          onEvent: this.store.agentLog(task.id, attempt, role),
        });
        s.sessionId = work.sessionId;
        s.summary = work.text.slice(0, 2000);

        if (resolving) {
          // Never commit a merge that still has markers; the next attempt finishes the job.
          leftover = await filesWithMarkers(dir, conflicts, underlines);
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

        this.checkpoint();
        this.setStatus(s, 'verifying');
        const v = await this.verify(task, dir);
        if (!v.ok) {
          feedback.push({ attempt, reason: `Verification failed.\n${v.report}` });
          continue;
        }

        if (task.review) {
          this.checkpoint();
          this.setStatus(s, 'reviewing');
          const verdict = await this.review(task, dir, forkPoint, attempt);
          if (!verdict.approve) {
            feedback.push({ attempt, reason: `Reviewer requested changes:\n- ${verdict.issues.join('\n- ')}` });
            continue;
          }
        }

        this.checkpoint();
        this.setStatus(s, 'merging');
        const merged = await this.serialMerge(task, branch);
        if (!merged.ok) {
          feedback.push({ attempt, reason: merged.reason });
          // Keep the finished work: bring the newer integration state into this branch instead of redoing.
          const sync = await this.syncWithIntegration(task, dir);
          forkPoint = sync.head;
          conflicts = sync.conflicts;
          underlines = await contentSeparators(dir, conflicts);
          leftover = [];
          continue;
        }

        this.setStatus(s, 'done', { endedAt: new Date().toISOString() });
        if (!this.opts.keepWorktrees) await this.git.removeWorktree(dir);
        return;
      }
      const error = feedback.at(-1)?.reason.slice(0, 4000) ?? 'no attempts made';
      // Not "failed" yet: that would block the dependents before the planner has had its say.
      if (this.canReplan(task)) {
        this.setStatus(s, 'replanning', { error });
        if (await this.replan(task, dir, feedback)) return;
      }
      this.setStatus(s, 'failed', { endedAt: new Date().toISOString(), error });
    } catch (err) {
      if (this.opts.signal?.aborted) {
        // Stopping the agent mid-call throws; that is the person's Stop, not a failure of the task.
        this.setStatus(s, 'skipped', { error: 'run aborted' });
      } else if (err instanceof TaskBudgetError) {
        this.setStatus(s, 'failed', { endedAt: new Date().toISOString(), error: err.message });
      } else if (err instanceof CallStoppedError) {
        if (err.role === 'worker' || err.role === 'resolver') s.attempts = Math.max(0, s.attempts - 1);
        this.setStatus(s, 'failed', { endedAt: new Date().toISOString(), error: err.message });
      } else if (err instanceof AgentUnavailableError) {
        // Not the work's fault, so a worker or resolver call that never got an answer does not count as a try. The
        // reviewer and the planner only run after the work itself used its attempts.
        if (err.role === 'worker' || err.role === 'resolver') s.attempts = Math.max(0, s.attempts - 1);
        const agent = this.agentFor(task, err.role);
        // Waiting does not bring back an account out of usage or a program that is not there, so nothing more starts on it.
        if (err.kind !== 'transient' && !this.halted.has(agent)) this.halted.set(agent, err.message);
        // Say what the task itself failed on when only the planner could not be reached.
        const earlier = err.role === 'replanner' ? feedback.at(-1)?.reason.slice(0, 3000) : undefined;
        const error = earlier ? `${earlier}\n\nThe planner could not be reached to replace this task: ${err.message}` : err.message;
        this.setStatus(s, 'failed', { endedAt: new Date().toISOString(), error });
      } else {
        this.setStatus(s, 'failed', { endedAt: new Date().toISOString(), error: String(err) });
      }
    } finally {
      await this.save();
    }
  }

  /**
   * A task failed for good: ask the planner to split or rewrite it so its dependents can still run.
   * True when the task became `replaced` and the graph gained the new tasks; false leaves the caller to fail it.
   */
  private canReplan(task: ResolvedTask): boolean {
    return (this.state.replans ?? 0) < (this.plan.maxReplans ?? 0) && !this.stopReason(task.driver, task);
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
      const res = await this.callAgent(task, 'replanner', {
        prompt: replanPrompt(this.plan, task, feedback, others),
        cwd: dir,
        model: task.model,
        allowedTools: READ_ONLY_TOOLS,
        canEdit: false,
        maxTurns: 20,
        wrap: this.sandbox?.agentWrap(dir),
        onEvent: this.store.agentLog(task.id, used + 1, 'replanner'),
      });
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
      // The provider is down, or the run was stopped: no replan happened, so it is not spent, and runTask says why.
      if (err instanceof AgentUnavailableError || this.opts.signal?.aborted) {
        this.state.replans = used;
        throw err;
      }
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * One agent call, with the two safety nets around it. It is stopped after `timeoutMin` (the attempt then fails like
   * any other and is retried), and when the provider turns it away (rate limit, overload, network) it is retried
   * after a pause instead of being counted against the task. Throws AgentUnavailableError when that keeps happening,
   * when a run-wide limit is reached meanwhile, or at once when the account is out of usage or credit, a
   * TaskBudgetError when the task's own token allowance is used up meanwhile, and an AbortError when the run is
   * stopped. Spend is recorded for every call that reports it; a call killed before its agent reported anything
   * (a timeout, a Stop) adds nothing.
   */
  private async callAgent(task: ResolvedTask, role: string, opts: Omit<DriverRunOptions, 'signal'>): Promise<AgentResult> {
    const agent = this.agentFor(task, role);
    const driver = this.opts.drivers.get(agent);
    const delays = this.opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    const s = this.state.tasks[task.id]!;
    const userAbort = () => this.opts.signal?.aborted === true;

    for (let retry = 0; ; retry++) {
      // Timers above 2^31 - 1 ms fire at once, so a huge limit has to be capped rather than passed on.
      const limit = task.timeoutMin > 0 ? AbortSignal.timeout(Math.min(task.timeoutMin * 60_000, MAX_TIMER_MS)) : undefined;
      const signals = [this.opts.signal, limit].filter((x): x is AbortSignal => !!x);
      let res: AgentResult;
      try {
        res = await driver.run({ ...opts, signal: signals.length ? AbortSignal.any(signals) : undefined });
      } catch (err) {
        if (!limit?.aborted || userAbort()) {
          // The reviewer is set up apart from the worker, so its program can be missing when the worker's is not.
          if (role === 'reviewer' && !userAbort() && (err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            throw new AgentUnavailableError('missing', `the ${agent} agent could not be started: ${(err as Error).message}`, retry, role);
          }
          throw err;
        }
        res = { ok: false, text: '', costUsd: 0 };
      }
      this.addUsage(s, res);
      // A Stop is not an outcome of the call: whatever the driver made of it, every phase ends the same way.
      if (userAbort()) throw abortError();
      if (res.ok) return res;

      if (limit?.aborted) {
        const partial = role === 'worker' || role === 'resolver' ? ' Its partial work is still in the worktree.' : '';
        const text = `The agent was stopped after ${task.timeoutMin} minutes without finishing.${partial}`;
        this.store.event('agent_timeout', { task: task.id, role, minutes: task.timeoutMin });
        return { ...res, text, error: undefined, timedOut: true };
      }

      // Only what the provider or the CLI said is judged, never the agent's own words.
      const kind = res.error ? classifyAgentFailure(res.error) : null;
      if (!kind) return res;
      // The task's own allowance ran out meanwhile: say that, not that the provider is down.
      const spent = kind === 'quota' ? undefined : this.taskLimitReached(task);
      if (spent) throw new TaskBudgetError(spent);
      if (kind === 'quota' || retry >= delays.length || this.stopReason(agent)) throw new AgentUnavailableError(kind, res.error!, retry, role);
      const delayMs = Math.round(delays[retry]! * (1 + Math.random() * 0.25));
      this.store.event('agent_retry', { task: task.id, role, retry: retry + 1, of: delays.length, delayMs, reason: res.error!.trim().split('\n')[0]!.slice(0, 200) });
      await sleep(delayMs, undefined, { signal: this.opts.signal }).catch(() => undefined);
      this.checkpoint();
      // Seconds to minutes passed: the others may have used up the run's limit or this agent's quota meanwhile.
      const stop = this.stopReason(agent);
      if (stop) throw new CallStoppedError(stop, role);
    }
  }

  /** The agent a call of this role goes to: the reviewer can be another one than the worker. */
  private agentFor(task: ResolvedTask, role: string): string {
    return role === 'reviewer' ? task.reviewer.driver : task.driver;
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
    const diff = await this.git.diff(dir, forkPoint);
    const res = await this.callAgent(task, 'reviewer', {
      prompt: reviewerPrompt(this.plan, task, diff),
      cwd: dir,
      model: task.reviewer.model,
      allowedTools: READ_ONLY_TOOLS,
      canEdit: false,
      maxTurns: 15,
      wrap: this.sandbox?.agentWrap(dir),
      onEvent: this.store.agentLog(task.id, attempt, 'reviewer'),
    });
    // Not a verdict, so not a reason to send the worker back: the review itself did not fit in the time.
    if (res.timedOut) throw new Error(`The reviewer was stopped after ${task.timeoutMin} minutes without a verdict. Raise timeoutMin in the plan or on the task if reviews of this size need longer.`);
    const verdict = extractJson<{ approve?: boolean; issues?: string[] }>(res.text);
    // A reviewer that failed without a verdict has not judged the work, so there is nothing to send the worker back
    // with: redoing finished, verified work cannot fix a reviewer that is set up wrongly (a model it does not have, a
    // login it lacks).
    if (!res.ok && typeof verdict?.approve !== 'boolean') {
      const who = `${task.reviewer.driver}${task.reviewer.model ? ` (${task.reviewer.model})` : ''}`;
      throw new Error(`The reviewer ${who} failed without giving a verdict, so the work was not reviewed: ${res.text.trim().slice(0, 500)}`);
    }
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
      let m: { ok: boolean; detail: string };
      try {
        m = await this.git.merge(this.integrationDir, branch, `braid: merge ${task.id} - ${task.title}`);
      } catch (err) {
        // A Stop killed git inside the merge (a slow hook): whatever it left half-done goes, back to the last verified state.
        await this.git.resetHard(this.integrationDir, this.state.verifiedHead ?? before);
        if (this.opts.signal?.aborted) this.store.event('merge_aborted', { task: task.id });
        throw err;
      }
      this.store.event('merge', { task: task.id, ok: m.ok });
      if (!m.ok) {
        return { ok: false, reason: `Your change conflicted with work other tasks merged first.\n${tail(m.detail, 1500)}` };
      }
      let v: { ok: boolean; report: string };
      try {
        v = await this.verify(task, this.integrationDir, task.verifyMerge);
      } catch (err) {
        // A Stop cut the combined check short. The integration branch only holds verified states, so the merge goes,
        // but this is not a failed check: nothing is logged as one and nothing is fed back to the agent.
        await this.git.resetHard(this.integrationDir, before);
        this.store.event('merge_aborted', { task: task.id });
        throw err;
      }
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

const MARKER_RE = /^(<{7}|>{7})(\s|$)/m;
const OPENING_RE = /^<{7}(\s|$)/gm;
const SEPARATOR_RE = /^={7}$/gm;

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/**
 * Per conflicted file, how many of its `=======` lines are not conflict separators. Every conflict has one opening
 * line and one separator, so what is left over in the file as the merge wrote it is content: the underline of a
 * Markdown or RST heading, which no resolution should be blamed for keeping. Read before the resolver touches the file.
 */
async function contentSeparators(dir: string, files: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf8').catch(() => '');
    out.set(f, Math.max(0, count(text, SEPARATOR_RE) - count(text, OPENING_RE)));
  }
  return out;
}

/**
 * Conflicted files that still contain conflict markers. Deleted files count as resolved. A `=======` line is a marker
 * only beyond the `underlines` the file had as content, so a heading underline does not fail a correct resolution
 * while a separator left behind after the other markers were removed still does.
 */
async function filesWithMarkers(dir: string, files: string[], underlines: ReadonlyMap<string, number> = new Map()): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf8').catch(() => '');
    if (MARKER_RE.test(text) || count(text, SEPARATOR_RE) > (underlines.get(f) ?? 0)) out.push(f);
  }
  return out;
}

/** "exited 1", or what happened when braid had to stop the command. */
function describeExit(res: ShellResult): string {
  return res.timedOut ? `was killed after running longer than ${SHELL_TIMEOUT_MS / 60_000} minutes` : `exited ${res.code}`;
}

function tail(text: string, n = 4000): string {
  return text.length > n ? `...${text.slice(-n)}` : text;
}

/** The end of a failed command's output, plus a hint line when it failed for want of a terminal. Matched on all of the output; the shorter tail keeps the hint clear of the 4000-character cut stored errors get. */
function failureTail(output: string): string {
  const hint = terminalHint(output);
  return hint ? `${tail(output, 3000)}\n${hint}` : tail(output);
}
