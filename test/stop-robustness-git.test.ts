import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import { Git } from '../src/git.js';
import { exec, STOP_TIMING } from '../src/proc.js';

// The hooks are POSIX shell scripts.
const skip = process.platform === 'win32' && 'POSIX shell hooks';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

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

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

interface Scratch {
  repo: string;
  /** Where the hooks leave their markers: `started-<hook>` when one is running, `pids` for what it started. */
  mark: string;
  /** Make `hook` take a minute from now on (the hook already exists; this is what switches it on). */
  slow(hook: string, on?: boolean): void;
  git: (...a: string[]) => Promise<string>;
}

/**
 * A repository whose hooks hang for a minute when switched on: the kind of pre-commit hook that runs a whole test
 * suite. They write their pids down, so a test can see that everything they started is gone. With `ignoreTerm` they
 * also ignore SIGTERM, so only SIGKILL stops them.
 */
async function scratch(opts: { ignoreTerm?: boolean } = {}): Promise<Scratch> {
  const repo = tmp('braid-stop-');
  const mark = tmp('braid-mark-');
  const git = async (...a: string[]) => (await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo })).stdout;
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  // A global core.hooksPath (husky, a company template) would hide the hooks of this repository.
  await git('config', 'core.hooksPath', join(repo, '.git', 'hooks'));
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  for (const hook of ['pre-commit', 'pre-merge-commit', 'post-checkout']) {
    const file = join(repo, '.git', 'hooks', hook);
    // The run's own worktree is named _integration and is made before any task: only the tasks' worktrees are slow to check out.
    const own = hook === 'post-checkout' ? 'case "$(basename "$PWD")" in _integration) exit 0;; esac\n' : '';
    writeFileSync(
      file,
      `#!/bin/sh
${own}if [ -f "${mark}/slow-${hook}" ]; then
  ${opts.ignoreTerm ? "trap '' TERM" : ''}
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
  return { repo: await Git.toplevel(repo), mark, slow, git };
}

const started = (s: Scratch, hook: string) => existsSync(join(s.mark, `started-${hook}`));
const hookPids = (s: Scratch) => (existsSync(join(s.mark, 'pids')) ? readFileSync(join(s.mark, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number) : []);

async function lockFree(dir: string): Promise<boolean> {
  const out = (await exec('git', ['rev-parse', '--git-path', 'index.lock'], { cwd: dir })).stdout.trim();
  return !existsSync(resolve(dir, out));
}

/** A task-like worktree on its own branch, with a file waiting to be committed. */
async function taskWorktree(s: Scratch, git: Git, name = 'task'): Promise<string> {
  const dir = join(tmp('braid-wt-'), name);
  await git.addWorktree(dir, `braid/test/${name}`, 'HEAD');
  writeFileSync(join(dir, `${name}.txt`), 'work\n');
  return dir;
}

describe('git commands a Stop can end', { skip }, () => {
  it('ends a commit that is inside a slow pre-commit hook, and kills the hook', async () => {
    const s = await scratch();
    const ac = new AbortController();
    const git = new Git(s.repo, ac.signal);
    const dir = await taskWorktree(s, git);
    s.slow('pre-commit');
    const run = git.commitAll(dir, 'wip');
    const settled = run.then(() => 'finished', (e: Error) => e.name);
    await until(() => started(s, 'pre-commit'), 'the hook to start');
    const at = Date.now();
    ac.abort();
    assert.equal(await settled, 'AbortError');
    assert.ok(Date.now() - at < 5000, 'did not wait for the minute-long hook');
    for (const pid of hookPids(s)) await until(() => !alive(pid), `hook process ${pid} to die`);
    assert.ok(await lockFree(dir), 'no index.lock left behind');
    assert.ok(!(await new Git(s.repo).inMerge(dir)));
    const log = await s.git('log', '--format=%s', 'braid/test/task');
    assert.ok(!log.includes('wip'), 'the killed commit did not land');
  });

  it('still ends a hook that ignores SIGTERM, by escalating to SIGKILL', async () => {
    const s = await scratch({ ignoreTerm: true });
    const ac = new AbortController();
    const git = new Git(s.repo, ac.signal);
    const dir = await taskWorktree(s, git);
    s.slow('pre-commit');
    const saved = { ...STOP_TIMING };
    Object.assign(STOP_TIMING, { termAfterMs: 100, killAfterMs: 400 });
    try {
      const settled = git.commitAll(dir, 'wip').then(() => 'finished', (e: Error) => e.name);
      await until(() => started(s, 'pre-commit'), 'the hook to start');
      ac.abort();
      assert.equal(await settled, 'AbortError');
      for (const pid of hookPids(s)) await until(() => !alive(pid), `hook process ${pid} to die`);
      assert.ok(await lockFree(dir));
    } finally {
      Object.assign(STOP_TIMING, saved);
    }
  });

  it('ends a merge that is inside a slow pre-merge-commit hook and leaves no merge in progress', async () => {
    const s = await scratch();
    const ac = new AbortController();
    const git = new Git(s.repo, ac.signal);
    const side = await taskWorktree(s, git, 'side');
    assert.equal(await git.commitAll(side, 'side work'), true);
    const integration = join(tmp('braid-wt-'), '_integration');
    await git.addWorktree(integration, 'braid/test/integration', 'main', false);
    const before = await git.revParse('HEAD', integration);
    s.slow('pre-merge-commit');
    const settled = git.merge(integration, 'braid/test/side', 'merge side').then(() => 'finished', (e: Error) => e.name);
    await until(() => started(s, 'pre-merge-commit'), 'the hook to start');
    ac.abort();
    assert.equal(await settled, 'AbortError');
    for (const pid of hookPids(s)) await until(() => !alive(pid), `hook process ${pid} to die`);
    assert.equal(await git.revParse('HEAD', integration), before, 'no merge commit');
    assert.ok(await lockFree(integration));
    assert.ok(!(await git.inMerge(integration)));
    // What git had already written into the tree is for the caller to throw away (the orchestrator resets to the verified head).
    await git.resetHard(integration, before);
    assert.equal((await git.run(['status', '--porcelain'], integration)).stdout.trim(), '');
  });

  it('ends a merge of newer integration work into a task branch the same way', async () => {
    const s = await scratch();
    const ac = new AbortController();
    const git = new Git(s.repo, ac.signal);
    const dir = await taskWorktree(s, git);
    assert.equal(await git.commitAll(dir, 'task work'), true);
    await s.git('switch', '-q', '-c', 'newer', 'main');
    writeFileSync(join(s.repo, 'newer.txt'), 'n\n');
    await s.git('add', '-A');
    await s.git('commit', '-q', '-m', 'newer');
    s.slow('pre-merge-commit');
    const settled = git.mergeIn(dir, 'newer', 'sync').then(() => 'finished', (e: Error) => e.name);
    await until(() => started(s, 'pre-merge-commit'), 'the hook to start');
    ac.abort();
    assert.equal(await settled, 'AbortError');
    assert.ok(await lockFree(dir));
    assert.ok(!(await git.inMerge(dir)));
  });

  it('ends the commit that concludes a conflict resolution, and leaves no merge in progress', async () => {
    const s = await scratch();
    const ac = new AbortController();
    const git = new Git(s.repo, ac.signal);
    const dir = await taskWorktree(s, git);
    writeFileSync(join(dir, 'README.md'), 'task\n');
    assert.equal(await git.commitAll(dir, 'task edit'), true);
    await s.git('switch', '-q', '-c', 'newer', 'main');
    writeFileSync(join(s.repo, 'README.md'), 'newer\n');
    await s.git('commit', '-q', '-am', 'newer edit');
    assert.deepEqual((await git.mergeIn(dir, 'newer', 'sync')).conflicts, ['README.md']);
    writeFileSync(join(dir, 'README.md'), 'both\n'); // the resolver agent's work
    s.slow('pre-commit');
    const settled = git.commitAll(dir, 'resolve').then(() => 'finished', (e: Error) => e.name);
    await until(() => started(s, 'pre-commit'), 'the hook to start');
    assert.ok(await git.inMerge(dir), 'the merge is what the commit was about to conclude');
    ac.abort();
    assert.equal(await settled, 'AbortError');
    assert.ok(!(await git.inMerge(dir)), 'no MERGE_HEAD left to wedge the worktree');
    assert.ok(await lockFree(dir));
  });

  it('ends a `worktree add` that is inside a slow post-checkout hook, and leaves nothing of it', async () => {
    const s = await scratch();
    const ac = new AbortController();
    const git = new Git(s.repo, ac.signal);
    const dir = join(tmp('braid-wt-'), 'a');
    s.slow('post-checkout');
    const settled = git.addWorktree(dir, 'braid/test/a', 'HEAD').then(() => 'finished', (e: Error) => e.name);
    await until(() => started(s, 'post-checkout'), 'the hook to start');
    ac.abort();
    assert.equal(await settled, 'AbortError');
    for (const pid of hookPids(s)) await until(() => !alive(pid), `hook process ${pid} to die`);
    assert.ok(!existsSync(dir), 'the half-made worktree is gone');
    assert.ok(!(await s.git('worktree', 'list', '--porcelain')).includes('braid/test/a'), 'and so is its entry in git');
    assert.deepEqual(existsSync(join(s.repo, '.git', 'worktrees')) ? readdirSync(join(s.repo, '.git', 'worktrees')) : [], [], 'and its administrative directory');
    assert.ok(!(await git.branchExists('braid/test/a')), 'and the branch name is free again');
    s.slow('post-checkout', false);
    await new Git(s.repo).addWorktree(dir, 'braid/test/a', 'HEAD'); // the task can be started again
    assert.ok(existsSync(join(dir, 'README.md')));
  });

  it('does not start git at all once the signal has aborted', async () => {
    const s = await scratch();
    const ac = new AbortController();
    const git = new Git(s.repo, ac.signal);
    const dir = await taskWorktree(s, git);
    s.slow('pre-commit');
    ac.abort();
    await assert.rejects(git.commitAll(dir, 'wip'), { name: 'AbortError' });
    await assert.rejects(git.merge(dir, 'main', 'm'), { name: 'AbortError' });
    await assert.rejects(git.addWorktree(join(tmp('braid-wt-'), 'b'), 'braid/test/b', 'HEAD'), { name: 'AbortError' });
    assert.ok(!started(s, 'pre-commit'), 'the hook never ran');
  });

  it('is unchanged without a signal: a slow hook is waited for', async () => {
    const s = await scratch();
    const git = new Git(s.repo);
    const dir = await taskWorktree(s, git);
    assert.equal(await git.commitAll(dir, 'wip'), true);
    assert.ok((await s.git('log', '--format=%s', 'braid/test/task')).includes('wip'));
  });

  it('commits as before when the Stop comes after the command finished', async () => {
    const s = await scratch();
    const ac = new AbortController();
    const git = new Git(s.repo, ac.signal);
    const dir = await taskWorktree(s, git);
    assert.equal(await git.commitAll(dir, 'wip'), true);
    ac.abort();
    assert.ok((await s.git('log', '--format=%s', 'braid/test/task')).includes('wip'));
  });
});

describe('settling a worktree after git was killed in it', { skip }, () => {
  const lockPath = async (dir: string) => resolve(dir, (await exec('git', ['rev-parse', '--git-path', 'index.lock'], { cwd: dir })).stdout.trim());

  it('removes an index.lock the killed command left, and aborts a merge it left in progress', async () => {
    const s = await scratch();
    const git = new Git(s.repo);
    const dir = await taskWorktree(s, git);
    assert.equal(await git.commitAll(dir, 'task work'), true);
    // A merge that conflicts is left in progress, like one whose commit was killed.
    writeFileSync(join(dir, 'README.md'), 'task\n');
    assert.equal(await git.commitAll(dir, 'task edit'), true);
    await s.git('switch', '-q', '-c', 'newer', 'main');
    writeFileSync(join(s.repo, 'README.md'), 'newer\n');
    await s.git('commit', '-q', '-am', 'newer edit');
    const { conflicts } = await git.mergeIn(dir, 'newer', 'sync');
    assert.deepEqual(conflicts, ['README.md']);
    assert.ok(await git.inMerge(dir));
    const lock = await lockPath(dir);
    writeFileSync(lock, '');
    await git.settle(dir, Date.now() - 1000);
    assert.ok(!existsSync(lock), 'the stale lock is gone');
    assert.ok(!(await git.inMerge(dir)), 'the merge is aborted');
    assert.equal((await git.run(['status', '--porcelain'], dir)).stdout.trim(), '');
  });

  it('leaves a lock that was there before the command started', async () => {
    const s = await scratch();
    const git = new Git(s.repo);
    const dir = await taskWorktree(s, git);
    const lock = await lockPath(dir);
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await git.settle(dir, Date.now());
    assert.ok(existsSync(lock), 'something else made it; it may still be held');
  });

  it('leaves the lock alone while a git process is still working in the worktree', async () => {
    const s = await scratch();
    const git = new Git(s.repo);
    const dir = await taskWorktree(s, git);
    const lock = await lockPath(dir);
    // A real git that sits in a hook inside this worktree.
    writeFileSync(join(dir, 'busy.txt'), 'x\n');
    await exec('git', ['add', '-A'], { cwd: dir });
    s.slow('pre-commit');
    const busy = new AbortController();
    const running = exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', dir, 'commit', '-q', '-m', 'busy'], { cwd: dir, allowFail: true, signal: busy.signal });
    await until(() => started(s, 'pre-commit'), 'the other git to be inside its hook');
    writeFileSync(lock, '');
    await git.settle(dir, Date.now() - 1000);
    assert.ok(existsSync(lock), 'a git process names this worktree, so the lock may be its own');
    busy.abort();
    await running;
    for (const pid of hookPids(s)) await until(() => !alive(pid), `hook process ${pid} to die`);
    await git.settle(dir, Date.now() - 10_000);
    assert.ok(!existsSync(lock), 'once nothing holds it, it goes');
  });

  // What a SIGKILL (a second Ctrl-C, a crash) can leave, which no cleanup in braid gets to see: a resume has to cope anyway.
  it('lets a resume rebuild a worktree that a hard kill left with a stale lock and a merge in progress', async () => {
    const s = await scratch();
    const git = new Git(s.repo);
    const dir = await taskWorktree(s, git);
    assert.equal(await git.commitAll(dir, 'task work'), true);
    const verified = await git.revParse('HEAD', dir);
    writeFileSync(join(dir, 'README.md'), 'task\n');
    assert.equal(await git.commitAll(dir, 'unverified'), true);
    await s.git('switch', '-q', '-c', 'newer', 'main');
    writeFileSync(join(s.repo, 'README.md'), 'newer\n');
    await s.git('commit', '-q', '-am', 'newer edit');
    await git.mergeIn(dir, 'newer', 'sync'); // conflicts: MERGE_HEAD
    writeFileSync(await lockPath(dir), '');
    assert.ok(await git.inMerge(dir));

    // What the orchestrator does on resume with the integration worktree: remove it, attach the branch again, reset to the verified head.
    const fresh = new Git(s.repo);
    await fresh.removeWorktree(dir);
    assert.ok(!existsSync(dir));
    await fresh.attachWorktree(dir, 'braid/test/task');
    await fresh.resetHard(dir, verified);
    await fresh.cleanUntracked(dir);
    assert.equal(await fresh.revParse('HEAD', dir), verified);
    assert.ok(await lockFree(dir));
    assert.ok(!(await fresh.inMerge(dir)));
    assert.equal(await fresh.commitAll(dir, 'carry on'), false, 'and git works in it');
  });

  it("never touches the person's own checkout", async () => {
    const s = await scratch();
    const git = new Git(s.repo);
    const lock = await lockPath(s.repo);
    writeFileSync(lock, '');
    await git.settle(s.repo, Date.now() - 1000);
    assert.ok(existsSync(lock));
    rmSync(lock);
  });
});
