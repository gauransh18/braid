import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import { stateRoot } from '../src/store.js';
import type { HarnessEvent } from '../src/store.js';
import type { PlanSpec } from '../src/types.js';

// The hooks are POSIX shell scripts.
const skip = process.platform === 'win32' && 'POSIX shell hooks';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A killed process stays a zombie until its parent reaps it, and inside a container nothing may.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
};

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

interface Scratch {
  repo: string;
  mark: string;
  slow(hook: string, on?: boolean): void;
  git: (...a: string[]) => Promise<string>;
}

/** A repository whose pre-commit, pre-merge-commit and post-checkout hooks hang for a minute while switched on. */
async function scratch(): Promise<Scratch> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-stoprun-'));
  const mark = mkdtempSync(join(tmpdir(), 'braid-stopmark-'));
  temps.push(dir, mark);
  const git = async (...a: string[]) => (await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir })).stdout;
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  // A global core.hooksPath (husky, a company template) would hide the hooks of this repository.
  await git('config', 'core.hooksPath', join(dir, '.git', 'hooks'));
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  for (const hook of ['pre-commit', 'pre-merge-commit', 'post-checkout']) {
    const file = join(dir, '.git', 'hooks', hook);
    // The run's own worktree is named _integration and is made before any task: only the tasks' worktrees are slow to check out.
    const own = hook === 'post-checkout' ? 'case "$(basename "$PWD")" in _integration) exit 0;; esac\n' : '';
    writeFileSync(
      file,
      `#!/bin/sh
${own}if [ -f "${mark}/slow-${hook}" ]; then
  echo $$ >> "${mark}/pids"
  sleep 60 &
  echo $! >> "${mark}/pids"
  touch "${mark}/started-${hook}"
  wait
fi
`,
    );
    chmodSync(file, 0o755);
  }
  const slow = (hook: string, on = true) => (on ? writeFileSync(join(mark, `slow-${hook}`), '') : rmSync(join(mark, `slow-${hook}`), { force: true }));
  return { repo: await Git.toplevel(dir), mark, slow, git };
}

const started = (s: Scratch, hook: string) => existsSync(join(s.mark, `started-${hook}`));
const hookPids = (s: Scratch) => (existsSync(join(s.mark, 'pids')) ? readFileSync(join(s.mark, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number) : []);

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
const work = (o: DriverRunOptions): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' } });

const plan: PlanSpec = { goal: 'g', driver: 'mock', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };

function orchestrator(repo: string, extra: { signal?: AbortSignal; runId?: string; resume?: boolean } = {}) {
  const orch = new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(new MockDriver(work)), ...extra });
  const events: HarnessEvent[] = [];
  orch.store.onEvent((e) => events.push(e));
  return { orch, events };
}

/** Everything a worktree could be left wedged by. Synchronous, so it can run inside an event handler. */
function wedges(dir: string): { lock: boolean; merging: boolean; status: string; head: string } {
  const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  return {
    lock: existsSync(resolve(dir, git('rev-parse', '--git-path', 'index.lock').stdout.trim())),
    merging: git('rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0,
    status: git('status', '--porcelain').stdout.trim(),
    head: git('rev-parse', 'HEAD').stdout.trim(),
  };
}

const firstParent = async (s: Scratch, ref: string) => (await s.git('log', '--first-parent', '--format=%s', ref)).trim().split('\n');

describe('Stop in the middle of a git hook, then resume', { skip }, () => {
  it('pre-commit: ends the task skipped, kills the hook, and resume completes the run', async () => {
    const s = await scratch();
    const base = (await s.git('rev-parse', 'main')).trim();
    s.slow('pre-commit');
    const ac = new AbortController();
    const { orch } = orchestrator(s.repo, { signal: ac.signal });
    const running = orch.run();
    await until(() => started(s, 'pre-commit'), 'the pre-commit hook to start');
    const at = Date.now();
    ac.abort();
    const state = await running;
    assert.ok(Date.now() - at < 8000, 'the Stop did not wait for the minute-long hook');
    assert.equal(state.status, 'aborted');
    assert.equal(state.tasks.a!.status, 'skipped');
    assert.equal(state.tasks.a!.error, 'run aborted');
    for (const pid of hookPids(s)) await until(() => !alive(pid), `hook process ${pid} to die`);
    assert.equal((await s.git('rev-parse', state.integrationBranch)).trim(), base, 'nothing reached the integration branch');
    const task = wedges(join(stateRoot(s.repo), 'worktrees', orch.runId, 'a'));
    assert.equal(task.lock, false, 'no index.lock in the task worktree');
    assert.equal(task.merging, false);

    s.slow('pre-commit', false);
    const second = orchestrator(s.repo, { runId: orch.runId, resume: true });
    const done = await second.orch.run();
    assert.equal(done.status, 'done');
    assert.equal(done.tasks.a!.status, 'done');
    assert.equal((await s.git('show', `${state.integrationBranch}:a.txt`)).trim(), 'ok');
    assert.deepEqual(await firstParent(s, state.integrationBranch), ['braid: merge a - A', 'init'], 'the integration branch holds the base and the one verified merge');
  });

  it('pre-merge-commit: undoes the half-made merge, and resume completes the run', async () => {
    const s = await scratch();
    const base = (await s.git('rev-parse', 'main')).trim();
    s.slow('pre-merge-commit');
    const ac = new AbortController();
    const { orch, events } = orchestrator(s.repo, { signal: ac.signal });
    // Looked at the moment the run says it undid the merge, before it removes the integration worktree.
    let left: ReturnType<typeof wedges> | undefined;
    orch.store.onEvent((e) => {
      if (e.type === 'merge_aborted') left = wedges(join(stateRoot(s.repo), 'worktrees', orch.runId, '_integration'));
    });
    const running = orch.run();
    await until(() => started(s, 'pre-merge-commit'), 'the pre-merge-commit hook to start');
    const at = Date.now();
    ac.abort();
    const state = await running;
    assert.ok(Date.now() - at < 8000, 'the Stop did not wait for the minute-long hook');
    assert.equal(state.status, 'aborted');
    assert.equal(state.tasks.a!.status, 'skipped');
    assert.equal(state.tasks.a!.error, 'run aborted');
    assert.ok(events.some((e) => e.type === 'merge_aborted'));
    assert.ok(!events.some((e) => e.type === 'merge_reverted'), 'a Stop is not a failed combined build');
    for (const pid of hookPids(s)) await until(() => !alive(pid), `hook process ${pid} to die`);
    assert.ok(left, 'the merge was undone');
    assert.deepEqual(left, { lock: false, merging: false, status: '', head: base }, 'the integration worktree is back at the verified head, clean, with nothing to wedge it');
    assert.equal((await s.git('rev-parse', state.integrationBranch)).trim(), base, 'the integration branch holds only verified states');

    s.slow('pre-merge-commit', false);
    const done = await orchestrator(s.repo, { runId: orch.runId, resume: true }).orch.run();
    assert.equal(done.status, 'done');
    assert.equal((await s.git('show', `${state.integrationBranch}:a.txt`)).trim(), 'ok');
    assert.deepEqual(await firstParent(s, state.integrationBranch), ['braid: merge a - A', 'init']);
  });

  it('worktree add: ends the task skipped, leaves no half-made worktree, and resume completes the run', async () => {
    const s = await scratch();
    s.slow('post-checkout');
    const ac = new AbortController();
    const { orch } = orchestrator(s.repo, { signal: ac.signal });
    const running = orch.run();
    await until(() => started(s, 'post-checkout'), "the task worktree's post-checkout hook to start");
    const at = Date.now();
    ac.abort();
    const state = await running;
    assert.ok(Date.now() - at < 8000, 'the Stop did not wait for the minute-long hook');
    assert.equal(state.status, 'aborted');
    assert.equal(state.tasks.a!.status, 'skipped');
    assert.equal(state.tasks.a!.error, 'run aborted');
    for (const pid of hookPids(s)) await until(() => !alive(pid), `hook process ${pid} to die`);
    assert.ok(!existsSync(join(stateRoot(s.repo), 'worktrees', orch.runId, 'a')), 'no half-made worktree');
    const worktrees = await s.git('worktree', 'list', '--porcelain');
    assert.ok(!worktrees.includes(`braid/${orch.runId}`), 'git lists no braid worktree');
    assert.equal(spawnSync('git', ['-C', s.repo, 'rev-parse', '-q', '--verify', `refs/heads/braid/${orch.runId}/task-a`]).status, 1, 'and the task branch is gone');

    s.slow('post-checkout', false);
    const done = await orchestrator(s.repo, { runId: orch.runId, resume: true }).orch.run();
    assert.equal(done.status, 'done');
    assert.equal((await s.git('show', `${state.integrationBranch}:a.txt`)).trim(), 'ok');
  });

  it('a Stop that arrives while the run is starting still ends it as aborted, with a branch to resume from', async () => {
    const s = await scratch();
    const ac = new AbortController();
    ac.abort();
    const { orch } = orchestrator(s.repo, { signal: ac.signal });
    const state = await orch.run();
    assert.equal(state.status, 'aborted');
    assert.equal(state.tasks.a!.status, 'skipped');
    const done = await orchestrator(s.repo, { runId: orch.runId, resume: true }).orch.run();
    assert.equal(done.status, 'done');
  });
});
