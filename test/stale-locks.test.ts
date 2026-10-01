import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import type { PlanSpec } from '../src/types.js';

// `ps` is how braid tells that no git process is holding a lock, which Windows cannot say: there the locks are left alone.
const skip = process.platform === 'win32' && 'no way to see git processes';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

const CHECK_JS = `
const fs = require('fs');
for (const f of fs.readdirSync('.')) {
  if (f.endsWith('.txt') && fs.readFileSync(f, 'utf8').includes('bad')) { console.error(f + ' is bad'); process.exit(1); }
}
`;

async function makeRepo(): Promise<string> {
  const dir = tmp('braid-locks-');
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

/** The lock file git takes while it moves a ref: refs/heads/<branch>.lock in the repository's own folder. */
const refLock = (repo: string, branch: string) => join(repo, '.git', 'refs', 'heads', ...`${branch}.lock`.split('/'));
const plant = (path: string, ageMs = 0) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  if (ageMs) utimesSync(path, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
};

describe('a lock left on a branch by a git that was killed', { skip }, () => {
  it('is removed by settle() when the killed command made it, but not one that was there before', async () => {
    const repo = await makeRepo();
    const git = new Git(repo);
    const dir = join(tmp('braid-wt-'), 'integration');
    await git.addWorktree(dir, 'braid/test/integration', 'HEAD');
    const lock = refLock(repo, 'braid/test/integration');

    plant(lock);
    await git.settle(dir, Date.now() - 1000);
    assert.ok(!existsSync(lock), 'the lock on the branch the killed merge was moving is gone, so the next reset of it can work');

    plant(lock, 60_000);
    await git.settle(dir, Date.now());
    assert.ok(existsSync(lock), 'one that was there before the command may belong to someone else');
  });

  it('is removed at the start of a resume, under the run\'s own branches only', async () => {
    const repo = await makeRepo();
    const git = new Git(repo);
    for (const b of ['braid/run1/integration', 'braid/run1/task-a', 'braid/run2/task-a']) await git.run(['branch', b, 'main']);
    for (const b of ['braid/run1/integration', 'braid/run1/task-a', 'braid/run2/task-a']) plant(refLock(repo, b), 3600_000);
    plant(join(repo, '.git', 'refs', 'heads', 'braid', 'run1', 'notes.txt'));

    assert.deepEqual((await git.clearRunLocks('run1')).sort(), ['integration.lock', 'task-a.lock']);
    assert.ok(!existsSync(refLock(repo, 'braid/run1/task-a')));
    assert.ok(existsSync(refLock(repo, 'braid/run2/task-a')), 'another run\'s lock is not ours to remove');
    assert.ok(existsSync(join(repo, '.git', 'refs', 'heads', 'braid', 'run1', 'notes.txt')), 'and only lock files go');
    assert.deepEqual(await git.clearRunLocks('..'), [], 'a run id is never a path');
    assert.deepEqual(await git.clearRunLocks('nothing-here'), []);
  });

  it('no longer fails every resume on the task branch or the integration branch', async () => {
    const repo = await makeRepo();
    const plan: PlanSpec = { goal: 'g', driver: 'mock', maxAttempts: 1, verify: ['node check.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }, { id: 'b', title: 'B', prompt: 'p', deps: ['a'] }] };
    const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
    const drivers = (content: string) => new DriverRegistry().register(new MockDriver((o) => ({ files: { [`${taskOf(o)}.txt`]: taskOf(o) === 'a' ? content : 'ok\n' } })));
    const first = await new Orchestrator({ repo, plan, drivers: drivers('bad\n') }).run();
    assert.equal(first.tasks.a!.status, 'failed');

    // What a git killed outright (a second Ctrl-C, a crash) leaves: the locks on the task branch and on the integration branch.
    plant(refLock(repo, `braid/${first.runId}/task-a`), 3600_000);
    plant(refLock(repo, `braid/${first.runId}/integration`), 3600_000);

    const orch = new Orchestrator({ repo, plan, drivers: drivers('ok\n'), runId: first.runId, resume: true });
    const events: string[] = [];
    orch.store.onEvent((e) => events.push(e.type));
    const resumed = await orch.run();
    assert.equal(resumed.status, 'done', JSON.stringify(Object.values(resumed.tasks).map((t) => t.error)));
    assert.ok(events.includes('stale_locks_removed'));
    assert.ok(!existsSync(refLock(repo, `braid/${first.runId}/task-a`)));
    assert.match(readFileSync(join(orch.store.dir, 'events.jsonl'), 'utf8'), /stale_locks_removed.*task-a\.lock/);
  });
});
