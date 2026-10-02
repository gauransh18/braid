import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type Driver } from '../src/drivers/driver.js';
import { MockDriver } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import type { PlanSpec, RunState } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-agents-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

/** Stands in for an agent that reports the model it is actually using when it starts, as Claude, Gemini and NIM do. */
function reporting(name: string, model: string | undefined): Driver {
  const inner = new MockDriver(() => ({ files: { [`${name}.txt`]: 'ok\n' } }), name);
  return {
    name,
    run: (o) => {
      const forward = o.onEvent;
      return inner.run({ ...o, onEvent: (e) => forward?.(e.kind === 'start' && model ? { ...e, model } : e) });
    },
  };
}

describe('the record of which agent worked on a task', () => {
  async function run(plan: PlanSpec, drivers: Driver[]): Promise<RunState> {
    const registry = new DriverRegistry();
    for (const d of drivers) registry.register(d);
    return new Orchestrator({ repo: await makeRepo(), plan, drivers: registry }).run();
  }

  it('has the model the agent reported when the plan named none', async () => {
    const state = await run({ goal: 'g', driver: 'nim', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, [reporting('nim', 'nvidia/nemotron-3-super-120b-a12b')]);
    assert.equal(state.tasks.a!.status, 'done');
    assert.deepEqual(state.tasks.a!.agents, { worker: { driver: 'nim', model: 'nvidia/nemotron-3-super-120b-a12b' } });
  });

  it('has the model of the plan, and then the one the agent reports in its place', async () => {
    const named = await run({ goal: 'g', driver: 'nim', model: 'meta/some-model', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, [new MockDriver(() => ({ files: { 'a.txt': 'x\n' } }), 'nim')]);
    assert.deepEqual(named.tasks.a!.agents, { worker: { driver: 'nim', model: 'meta/some-model' } }, 'a driver that reports nothing leaves what was asked for');
    const switched = await run({ goal: 'g', driver: 'nim', model: 'meta/retired', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, [reporting('nim', 'nvidia/live')]);
    assert.deepEqual(switched.tasks.a!.agents, { worker: { driver: 'nim', model: 'nvidia/live' } });
  });

  it('has no model when neither the plan nor the agent names one', async () => {
    const state = await run({ goal: 'g', driver: 'mock', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }, [new MockDriver(() => ({ files: { 'a.txt': 'x\n' } }))]);
    assert.deepEqual(state.tasks.a!.agents, { worker: { driver: 'mock' } });
  });

  it('keeps the worker and the reviewer apart when they are different agents', async () => {
    const state = await run(
      { goal: 'g', driver: 'nim', review: true, reviewer: { driver: 'rev', model: 'rev-model' }, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] },
      [reporting('nim', 'nvidia/live'), new MockDriver(() => ({}), 'rev')],
    );
    assert.equal(state.tasks.a!.status, 'done');
    assert.deepEqual(state.tasks.a!.agents, { worker: { driver: 'nim', model: 'nvidia/live' }, reviewer: { driver: 'rev', model: 'rev-model' } });
  });
});
