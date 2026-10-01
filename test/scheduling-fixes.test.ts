import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import { DriverRegistry } from '../src/drivers/driver.js';
import { MockDriver } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import { touchesOverlap } from '../src/touches.js';
import type { PlanSpec, RunState, TaskStatus } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-sched-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

/** The scheduler with its tasks and its snapshot writes stood in for, so the order things end in is under the test's control. */
interface Inside {
  state: RunState;
  save(): Promise<void>;
  runTask(task: { id: string }): Promise<void>;
  schedule(): Promise<void>;
}

async function scheduler(plan: PlanSpec, status: Record<string, TaskStatus> = {}): Promise<Inside> {
  const repo = await makeRepo();
  const orch = new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(new MockDriver()) }) as unknown as Inside;
  orch.state = {
    runId: 'r',
    repo,
    base: 'main',
    integrationBranch: 'braid/r/integration',
    status: 'running',
    costUsd: 0,
    createdAt: new Date().toISOString(),
    tasks: Object.fromEntries(plan.tasks.map((t) => [t.id, { id: t.id, status: status[t.id] ?? 'pending', attempts: 0, costUsd: 0 }])),
  };
  return orch;
}

describe('the scheduler', () => {
  const overlapping: PlanSpec = {
    goal: 'g',
    driver: 'mock',
    concurrency: 3,
    tasks: [
      { id: 'x', title: 'X', prompt: 'p', touches: ['src/**'] },
      { id: 'b', title: 'B', prompt: 'p', touches: ['src/**'] },
    ],
  };

  it('does not call the run stalled when the task that held another back ends while the snapshot is written', async () => {
    const orch = await scheduler(overlapping);
    const started: string[] = [];
    orch.runTask = async (task) => {
      started.push(task.id);
      await sleep(5);
      orch.state.tasks[task.id]!.status = 'done';
    };
    // The write of the first pass, which leaves b waiting for x, lasts until x has ended.
    let writes = 0;
    orch.save = async () => {
      if (++writes === 1) await sleep(60);
    };
    await orch.schedule();
    assert.deepEqual(started, ['x', 'b']);
    assert.equal(orch.state.tasks.b!.status, 'done');
  });

  it('still fails loudly when nothing is running and a task can never start', async () => {
    // x is neither done nor running anywhere, so b, which waits for it, can never be started.
    const orch = await scheduler({ ...overlapping, tasks: [{ id: 'x', title: 'X', prompt: 'p' }, { id: 'b', title: 'B', prompt: 'p', deps: ['x'] }] }, { x: 'merging' });
    orch.runTask = async () => assert.fail('nothing can start');
    orch.save = async () => undefined;
    await assert.rejects(orch.schedule(), /scheduler stalled/);
  });
});

describe('touches that name a bracketed directory', () => {
  const yes = (a: string[], b: string[]) => {
    assert.equal(touchesOverlap(a, b), true, `${a} should overlap ${b}`);
    assert.equal(touchesOverlap(b, a), true, `${b} should overlap ${a}`);
  };
  const no = (a: string[], b: string[]) => {
    assert.equal(touchesOverlap(a, b), false, `${a} should not overlap ${b}`);
    assert.equal(touchesOverlap(b, a), false, `${b} should not overlap ${a}`);
  };

  it('covers what is under a dynamic route folder named without a trailing slash', () => {
    yes(['app/[id]'], ['app/[id]/edit/page.tsx']);
    yes(['app/posts/[...slug]'], ['app/posts/[...slug]/page.tsx']);
    yes(['app/[[...path]]'], ['app/[[...path]]/layout.tsx']);
    yes(['app/(auth)'], ['app/(auth)/login/page.tsx']);
    no(['app/[id]'], ['lib/x.ts']);
  });

  it('still takes a bracket pattern with an extension for a file', () => {
    no(['src/[ab].ts'], ['src/**/*.md']);
    no(['app/[id].tsx'], ['app/**/*.ts']);
    yes(['src/[ab].ts'], ['src/a.ts']);
  });
});
