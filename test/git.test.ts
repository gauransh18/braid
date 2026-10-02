import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Git } from '../src/git.js';
import { exec } from '../src/proc.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

async function makeRepo(): Promise<string> {
  const dir = tmp('braid-git-');
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

describe('worktree recovery', () => {
  it('removes a worktree that a killed `git worktree add` left locked', async () => {
    const repo = await makeRepo();
    const git = new Git(repo);
    const dir = join(tmp('braid-wt-'), 'task');
    await git.addWorktree(dir, 'braid/test/task', 'HEAD');
    // What a SIGKILL during `worktree add` leaves behind.
    await exec('git', ['worktree', 'lock', '--reason', 'initializing', dir], { cwd: repo });
    await git.removeWorktree(dir);
    await git.deleteBranch('braid/test/task');
    assert.ok(!existsSync(dir));
    assert.ok(!(await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repo })).stdout.includes('braid/test/task'));
    assert.ok(!(await git.branchExists('braid/test/task')), 'the branch name is free again');
    await git.addWorktree(dir, 'braid/test/task', 'HEAD'); // and the task can be started again
  });
});

// A sandboxed task's worktree is mounted into a container that can rewrite its `.git` pointer file. Host-side git
// follows that pointer to find the repository's config, which can name a program to run.
describe('a worktree whose .git pointer was rewritten', { skip: process.platform === 'win32' && 'shell-script stand-in' }, () => {
  async function tampered() {
    const repo = await makeRepo();
    const git = new Git(repo);
    const dir = join(tmp('braid-wt-'), 'task');
    await git.addWorktree(dir, 'braid/test/task', 'HEAD');

    const evilDir = tmp('braid-evil-');
    const marker = join(evilDir, 'ran');
    const hooks = join(evilDir, 'hooks');
    mkdirSync(hooks);
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);
    const evil = join(evilDir, 'gitdir');
    await exec('git', ['init', '-q', '--bare', evil], { cwd: evilDir });
    await exec('git', ['config', '--file', join(evil, 'config'), 'core.hooksPath', hooks], { cwd: evilDir });
    await exec('git', ['config', '--file', join(evil, 'config'), 'core.bare', 'false'], { cwd: evilDir });
    writeFileSync(join(dir, '.git'), `gitdir: ${evil}\n`);
    writeFileSync(join(dir, 'x.txt'), 'x\n');
    return { git, repo, dir, marker };
  }

  it('would run the program its config names, if git were left to find the repository itself (its config names a commit hook)', async () => {
    const { dir, marker } = await tampered();
    await exec('git', ['add', '-A'], { cwd: dir, allowFail: true });
    await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], { cwd: dir, allowFail: true });
    assert.ok(existsSync(marker), 'the control: plain git does follow the rewritten pointer into the program');
  });

  it('is not followed: host git is told where the repository is', async () => {
    const { git, repo, dir, marker } = await tampered();
    assert.equal(await git.commitAll(dir, 'braid(a): attempt 1'), true);
    assert.ok(!existsSync(marker), 'the program named by the rewritten config never ran');
    const log = (await exec('git', ['log', '--format=%s', 'braid/test/task', '-1'], { cwd: repo })).stdout.trim();
    assert.equal(log, 'braid(a): attempt 1', 'the commit went to the real repository');
  });
});

describe('worktree bookkeeping', () => {
  it('takes turns: tasks that start and finish together never run two worktree or branch commands side by side', async () => {
    const repo = await makeRepo();
    const git = new Git(repo);
    const real = git.run.bind(git);
    let inFlight = 0;
    let most = 0;
    git.run = async (args, cwd, allowFail, signal) => {
      const admin = args[0] === 'worktree' || args[0] === 'branch';
      if (admin) most = Math.max(most, ++inFlight);
      try {
        return await real(args, cwd, allowFail, signal);
      } finally {
        if (admin) inFlight--;
      }
    };
    const root = tmp('braid-wts-');
    await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        const dir = join(root, `t${n}`);
        await git.removeWorktree(dir);
        await git.deleteBranch(`braid/test/task-${n}`);
        await git.addWorktree(dir, `braid/test/task-${n}`, 'HEAD');
        await git.removeWorktree(dir);
      }),
    );
    assert.equal(most, 1);
  });
});
