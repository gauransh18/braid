import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import type { DriverRunOptions } from '../src/drivers/driver.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import type { PlanSpec } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// Verification script: fails if any .txt file in the tree contains the word "bad".
const CHECK_JS = `
const fs = require('fs');
for (const f of fs.readdirSync('.')) {
  if (f.endsWith('.txt') && fs.readFileSync(f, 'utf8').includes('bad')) { console.error(f + ' is bad'); process.exit(1); }
}
`;

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-test-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  writeFileSync(join(dir, 'shared.txt'), 'base\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

function isResolver(o: DriverRunOptions): boolean {
  return /left conflict markers/.test(o.prompt);
}

function stripMarkers(text: string): string {
  return text.split('\n').filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join('\n');
}

function taskOf(o: DriverRunOptions): string {
  return /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
}

async function show(repo: string, ref: string, file: string): Promise<string> {
  return (await exec('git', ['show', `${ref}:${file}`], { cwd: repo })).stdout;
}

async function runPlan(repo: string, plan: PlanSpec, script: (o: DriverRunOptions, i: number) => MockStep) {
  const mock = new MockDriver(script);
  const orch = new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(mock) });
  const state = await orch.run();
  return { state, mock };
}

describe('orchestrator', () => {
  it('runs a DAG, gives dependents the merged work of their deps, and never touches base', async () => {
    const repo = await makeRepo();
    const baseHead = (await exec('git', ['rev-parse', 'main'], { cwd: repo })).stdout.trim();
    const sawDeps: boolean[] = [];
    const { state } = await runPlan(
      repo,
      {
        goal: 'g',
        driver: 'mock',
        verify: ['node check.js'],
        tasks: [
          { id: 'a', title: 'A', prompt: 'do a' },
          { id: 'b', title: 'B', prompt: 'do b' },
          { id: 'c', title: 'C', prompt: 'do c', deps: ['a', 'b'] },
        ],
      },
      (o) => {
        const t = taskOf(o);
        if (t === 'c') sawDeps.push(existsSync(join(o.cwd, 'a.txt')) && existsSync(join(o.cwd, 'b.txt')));
        return { files: { [`${t}.txt`]: `${t}\n` } };
      },
    );
    assert.equal(state.status, 'done');
    assert.deepEqual(sawDeps, [true]);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) assert.ok(await show(repo, state.integrationBranch, f));
    assert.equal((await exec('git', ['rev-parse', 'main'], { cwd: repo })).stdout.trim(), baseHead);
    const st = (await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout;
    assert.equal(st.trim(), '', 'state dir must be excluded from git status');
  });

  it('retries with verification feedback until the check passes', async () => {
    const repo = await makeRepo();
    const { state, mock } = await runPlan(
      repo,
      { goal: 'g', driver: 'mock', verify: ['node check.js'], maxAttempts: 3, tasks: [{ id: 'fix', title: 'F', prompt: 'p' }] },
      (_o, i) => ({ files: { 'out.txt': i === 0 ? 'bad\n' : 'good\n' } }),
    );
    assert.equal(state.status, 'done');
    assert.equal(state.tasks.fix!.attempts, 2);
    assert.match(mock.calls[1]!.prompt, /Verification failed/);
    assert.equal(await show(repo, state.integrationBranch, 'out.txt'), 'good\n');
  });

  it('blocks review-rejected work until the reviewer approves', async () => {
    const repo = await makeRepo();
    let reviews = 0;
    const { state, mock } = await runPlan(
      repo,
      { goal: 'g', driver: 'mock', review: true, tasks: [{ id: 'r', title: 'R', prompt: 'p' }] },
      (o) => {
        if (o.canEdit) return { files: { 'r.txt': 'r\n' } };
        reviews++;
        return { text: reviews === 1 ? '{"approve": false, "issues": ["missing tests"]}' : '```json\n{"approve": true, "issues": []}\n```' };
      },
    );
    assert.equal(state.status, 'done');
    assert.equal(reviews, 2);
    assert.ok(mock.calls.filter((c) => !c.canEdit).every((c) => !c.allowedTools.includes('Edit')));
    assert.match(mock.calls.find((c, i) => c.canEdit && i > 0)!.prompt, /missing tests/);
  });

  it('marks dependents blocked when a task fails', async () => {
    const repo = await makeRepo();
    const { state } = await runPlan(
      repo,
      {
        goal: 'g',
        driver: 'mock',
        verify: ['node check.js'],
        maxAttempts: 1,
        tasks: [
          { id: 'a', title: 'A', prompt: 'p' },
          { id: 'b', title: 'B', prompt: 'p', deps: ['a'] },
        ],
      },
      () => ({ files: { 'a.txt': 'bad\n' } }),
    );
    assert.equal(state.status, 'failed');
    assert.equal(state.tasks.a!.status, 'failed');
    assert.equal(state.tasks.b!.status, 'blocked');
  });

  it('resolves a merge conflict in place instead of redoing the task', async () => {
    const repo = await makeRepo();
    const { state, mock } = await runPlan(
      repo,
      {
        goal: 'g',
        driver: 'mock',
        concurrency: 2,
        tasks: [
          { id: 'x', title: 'X', prompt: 'p' },
          { id: 'y', title: 'Y', prompt: 'p' },
        ],
      },
      (o) => {
        const current = readFileSync(join(o.cwd, 'shared.txt'), 'utf8');
        if (isResolver(o)) return { files: { 'shared.txt': stripMarkers(current) } };
        return { files: { 'shared.txt': `${current}${taskOf(o)}\n` } };
      },
    );
    assert.equal(state.status, 'done');
    const merged = await show(repo, state.integrationBranch, 'shared.txt');
    assert.match(merged, /x\n/);
    assert.match(merged, /y\n/);
    assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>|=======/);
    // One worker run per task plus a single narrow resolver run; no full redo.
    assert.equal(mock.calls.filter((c) => !isResolver(c)).length, 2);
    const resolvers = mock.calls.filter(isResolver);
    assert.equal(resolvers.length, 1);
    assert.match(resolvers[0]!.prompt, /- shared\.txt/);
    assert.equal(state.tasks.x!.attempts + state.tasks.y!.attempts, 3);
  });

  it('never commits leftover markers and retries the resolution', async () => {
    const repo = await makeRepo();
    let resolverCalls = 0;
    const { state, mock } = await runPlan(
      repo,
      {
        goal: 'g',
        driver: 'mock',
        concurrency: 2,
        maxAttempts: 3,
        tasks: [
          { id: 'x', title: 'X', prompt: 'p' },
          { id: 'y', title: 'Y', prompt: 'p' },
        ],
      },
      (o) => {
        const current = readFileSync(join(o.cwd, 'shared.txt'), 'utf8');
        if (isResolver(o)) {
          resolverCalls++;
          return resolverCalls === 1 ? { files: { 'shared.txt': current } } : { files: { 'shared.txt': stripMarkers(current) } };
        }
        return { files: { 'shared.txt': `${current}${taskOf(o)}\n` } };
      },
    );
    assert.equal(state.status, 'done');
    assert.equal(resolverCalls, 2);
    assert.match(mock.calls.filter(isResolver)[1]!.prompt, /left markers in: shared\.txt/);
    const log = (await exec('git', ['log', '-p', state.integrationBranch], { cwd: repo })).stdout;
    assert.doesNotMatch(log, /^\+<<<<<<</m);
  });

  it('reverts a merge that breaks the combined tree', async () => {
    const repo = await makeRepo();
    // Each task alone is fine; together they spell "bad" across two files the check concatenates.
    writeFileSync(join(repo, 'check.js'), `const fs=require('fs');const r=f=>fs.existsSync(f)?fs.readFileSync(f,'utf8').trim():'';if(r('p.txt')+r('q.txt')==='bad')process.exit(1);`);
    await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'check'], { cwd: repo });
    const { state } = await runPlan(
      repo,
      {
        goal: 'g',
        driver: 'mock',
        concurrency: 2,
        maxAttempts: 2,
        verify: ['node check.js'],
        tasks: [
          { id: 'p', title: 'P', prompt: 'p' },
          { id: 'q', title: 'Q', prompt: 'q' },
        ],
      },
      (o) => {
        // Whichever merges second breaks the combined tree; on redo it sees the other file and writes something safe.
        const t = taskOf(o);
        const other = t === 'p' ? 'q.txt' : 'p.txt';
        const redo = existsSync(join(o.cwd, other));
        return { files: { [`${t}.txt`]: redo ? 'ok' : t === 'p' ? 'b' : 'ad' } };
      },
    );
    assert.equal(state.status, 'done');
    const combined = (await show(repo, state.integrationBranch, 'p.txt')) + (await show(repo, state.integrationBranch, 'q.txt'));
    assert.notEqual(combined, 'bad');
    assert.equal(state.tasks.p!.attempts + state.tasks.q!.attempts, 3);
  });

  it('stops scheduling once the budget is spent', async () => {
    const repo = await makeRepo();
    const { state } = await runPlan(
      repo,
      {
        goal: 'g',
        driver: 'mock',
        budgetUsd: 1,
        concurrency: 1,
        tasks: [
          { id: 'a', title: 'A', prompt: 'p' },
          { id: 'b', title: 'B', prompt: 'p' },
        ],
      },
      () => ({ files: { 'z.txt': 'z' }, costUsd: 1 }),
    );
    assert.equal(state.tasks.a!.status, 'done');
    assert.equal(state.tasks.b!.status, 'skipped');
    assert.equal(state.costUsd, 1);
  });
});
