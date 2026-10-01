import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { judgeRun } from '../src/clean.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import type { PlanSpec, RunState } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const CHECK_JS = `
const fs = require('fs');
for (const f of fs.readdirSync('.')) {
  if (f.endsWith('.txt') && fs.readFileSync(f, 'utf8').includes('bad')) { console.error(f + ' is bad'); process.exit(1); }
}
`;

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-claim-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
const plan: PlanSpec = { goal: 'g', driver: 'mock', maxAttempts: 1, verify: ['node check.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
const drivers = (content: string) => new DriverRegistry().register(new MockDriver((o) => ({ files: { [`${taskOf(o)}.txt`]: content } })));

describe('resuming a run', () => {
  it('is marked as running, by this process, before the worktrees are set up again', async () => {
    const repo = await makeRepo();
    const first = await new Orchestrator({ repo, plan, drivers: drivers('bad\n') }).run();
    assert.equal(first.status, 'failed');
    assert.ok(first.endedAt);

    // What state.json says while git is busy in the first worktree of the resume (a post-checkout hook, which is
    // where a repository that installs dependencies spends minutes).
    const out = join(mkdtempSync(join(tmpdir(), 'braid-claim-out-')), 'seen.json');
    temps.push(join(out, '..'));
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\n[ -e "${out}" ] || cat "${join(repo, '.braid', 'runs', first.runId, 'state.json')}" > "${out}"\n`);
    chmodSync(hook, 0o755);

    const resumed = await new Orchestrator({ repo, plan, drivers: drivers('ok\n'), runId: first.runId, resume: true }).run();
    assert.equal(resumed.status, 'done');

    const seen = JSON.parse(readFileSync(out, 'utf8')) as RunState;
    assert.equal(seen.status, 'running');
    assert.equal(seen.pid, process.pid);
    assert.equal(seen.endedAt, undefined);
    // So `braid clean` leaves it alone, which it would not for the failed run it was a moment before.
    assert.equal(judgeRun(first.runId, seen, Date.now(), Date.now()).clean, false);
    assert.equal(judgeRun(first.runId, first, Date.now(), Date.now()).clean, true);
  });

  it('puts state.json back as it was when the resume fails before it starts', async () => {
    const repo = await makeRepo();
    const first = await new Orchestrator({ repo, plan, drivers: drivers('bad\n') }).run();
    const file = join(repo, '.braid', 'runs', first.runId, 'state.json');
    const before = readFileSync(file, 'utf8');

    // A plan that now wants a container runtime nobody has: the resume stops at that, before any worktree is touched.
    const runtime = process.env.BRAID_CONTAINER_RUNTIME;
    process.env.BRAID_CONTAINER_RUNTIME = join(repo, 'no-such-runtime');
    try {
      const withSandbox: PlanSpec = { ...plan, sandbox: { image: 'node:22' } };
      await assert.rejects(new Orchestrator({ repo, plan: withSandbox, drivers: drivers('ok\n'), runId: first.runId, resume: true }).run(), /container runtime/);
    } finally {
      if (runtime === undefined) delete process.env.BRAID_CONTAINER_RUNTIME;
      else process.env.BRAID_CONTAINER_RUNTIME = runtime;
    }
    assert.equal(readFileSync(file, 'utf8'), before, 'a run that did not resume is not left looking like one that is running');
  });
});
