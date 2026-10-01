import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readBranches } from '../src/branches.js';
import type { RunState } from '../src/types.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

/** Everything that makes up the repo's history and working state, to prove a read changes none of it. */
function fingerprint(cwd: string): string {
  return [git(cwd, 'for-each-ref'), git(cwd, 'reflog', '--all'), git(cwd, 'status', '--porcelain=v2', '--branch'), git(cwd, 'worktree', 'list')].join('\n--\n');
}

describe('branch view', () => {
  it('reports merged, left-out and deleted branches without changing the repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'braid-branches-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'base');
      const R = 'braid/run1';
      git(dir, 'branch', `${R}/integration`);
      for (const t of ['one', 'two']) {
        git(dir, 'checkout', '-q', '-b', `${R}/task-${t}`, 'main');
        writeFileSync(join(dir, `${t}.txt`), `${t}\n${t}\n`);
        git(dir, 'add', '-A');
        git(dir, 'commit', '-qm', `work on ${t}`);
      }
      git(dir, 'checkout', '-q', 'main');
      // task one gets merged into integration, task two stays out
      git(dir, 'checkout', '-q', `${R}/integration`);
      git(dir, 'merge', '-q', '--no-ff', '-m', 'merge one', `${R}/task-one`);
      git(dir, 'checkout', '-q', 'main');
      const state = {
        runId: 'run1', repo: dir, base: 'main', integrationBranch: `${R}/integration`, status: 'failed', costUsd: 0, createdAt: '',
        tasks: {
          one: { id: 'one', status: 'done', attempts: 1, costUsd: 0, branch: `${R}/task-one` },
          two: { id: 'two', status: 'failed', attempts: 2, costUsd: 0, branch: `${R}/task-two` },
          three: { id: 'three', status: 'failed', attempts: 1, costUsd: 0, branch: `${R}/task-three` },
          four: { id: 'four', status: 'pending', attempts: 0, costUsd: 0 },
        },
      } as RunState;

      const before = fingerprint(dir);
      const report = await readBranches(dir, state);
      assert.equal(fingerprint(dir), before, 'reading branches must not change refs, reflogs, status or worktrees');

      assert.equal(report.integration.exists, true);
      assert.equal(report.integration.commitsAhead, 2); // task commit + merge commit
      assert.equal(report.branches.length, 3); // `four` never had a branch
      const by = Object.fromEntries(report.branches.map((b) => [b.task, b]));
      assert.equal(by.one!.merged, true);
      assert.equal(by.one!.files, 1);
      assert.equal(by.one!.insertions, 2);
      assert.equal(by.one!.commits[0]!.subject, 'work on one');
      assert.equal(by.two!.exists, true);
      assert.equal(by.two!.merged, false);
      assert.equal(by.three!.exists, false); // deleted by a retry, only the event log remembers it
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
