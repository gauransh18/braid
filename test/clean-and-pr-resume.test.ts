import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DriverRegistry } from '../src/drivers/driver.js';
import { MockDriver } from '../src/drivers/mock.js';
import { Orchestrator } from '../src/orchestrator.js';
import type { PlanSpec, RunState } from '../src/types.js';
import { git, makeRepo, tmp } from './clean-and-pr-fixtures.js';

describe('a resumed run and braid clean', () => {
  it('is saved as running, with its new pid, before its setup starts', async () => {
    const repo = await makeRepo();
    // Setup runs again in every task worktree; only the first look, in the integration worktree, is the one that matters.
    writeFileSync(join(repo, 'snap.js'), "const fs = require('node:fs');\nif (!fs.existsSync(process.argv[3])) fs.copyFileSync(process.argv[2], process.argv[3]);\n");
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'snap');
    const plan: PlanSpec = { goal: 'g', driver: 'mock', maxAttempts: 1, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
    const registry = (ok: boolean) => new DriverRegistry().register(new MockDriver(() => ({ ok, files: { 'a.txt': 'a\n' } })));
    const first = await new Orchestrator({ repo, plan, drivers: registry(false) }).run();
    assert.equal(first.status, 'failed');

    // Setup can run for minutes. What state.json says while it does is what `braid clean` goes by.
    const seen = join(tmp('braid-seen-'), 'state.json');
    const stateFile = join(repo, '.braid', 'runs', first.runId, 'state.json');
    const withSetup: PlanSpec = { ...plan, setup: [`node snap.js "${stateFile}" "${seen}"`] };
    const second = await new Orchestrator({ repo, plan: withSetup, drivers: registry(true), runId: first.runId, resume: true }).run();
    assert.equal(second.status, 'done');
    const during = JSON.parse(readFileSync(seen, 'utf8')) as RunState;
    assert.equal(during.status, 'running', 'it did not still say "failed"');
    assert.equal(during.pid, process.pid);
    assert.equal(during.endedAt, undefined);
  });
});
