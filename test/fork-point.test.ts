import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import type { PlanSpec } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// Fails when pa.txt and pb.txt are in the tree together. In the integration worktree it first takes 800 ms, as a real
// suite does, so the combined check of one merge is still running when other tasks finish and start.
const CHECK_JS = `
const fs = require('fs');
if (require('path').basename(process.cwd()) === '_integration') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
if (fs.existsSync('pa.txt') && fs.existsSync('pb.txt')) { console.error('pa.txt and pb.txt cannot be together'); process.exit(1); }
`;

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-fork-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';

describe('where a task starts from', () => {
  it('forks from the last verified integration state, not from a merge whose check is still running', async () => {
    const repo = await makeRepo();
    const forkedWithPa: boolean[] = [];
    // q merges first and is verified. p merges next and its combined check fails, so it is rolled back. e takes the
    // slot q frees while p's check is running; its own check is narrower, so a tree with p's commit in it would pass.
    const plan: PlanSpec = {
      goal: 'g',
      driver: 'mock',
      concurrency: 2,
      maxAttempts: 1,
      verify: ['node check.js'],
      tasks: [
        { id: 'p', title: 'P', prompt: 'p' },
        { id: 'q', title: 'Q', prompt: 'q' },
        { id: 'e', title: 'E', prompt: 'e', verify: ['node -e 0'] },
      ],
    };
    const mock = new MockDriver((o): MockStep => {
      const t = taskOf(o);
      if (t === 'e') forkedWithPa.push(existsSync(join(o.cwd, 'pa.txt')));
      // p is the slower worker, so its merge is queued behind q's while q's combined check runs.
      return { files: { [`${t === 'p' ? 'pa' : t === 'q' ? 'pb' : t}.txt`]: 'x\n' }, ...(t === 'p' ? { delayMs: 300 } : {}) };
    });
    const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(mock) }).run();

    assert.equal(state.tasks.q!.status, 'done');
    assert.equal(state.tasks.p!.status, 'failed', 'p broke the combined tree and was rolled back');
    assert.equal(state.tasks.e!.status, 'done');
    assert.deepEqual(forkedWithPa, [false], 'e must start from a state that passed the combined check');
    const tree = (await exec('git', ['ls-tree', '--name-only', state.integrationBranch], { cwd: repo })).stdout.split('\n');
    assert.ok(tree.includes('pb.txt') && tree.includes('e.txt'));
    assert.ok(!tree.includes('pa.txt'), "p's rolled-back change must not come back through e");
  });
});
