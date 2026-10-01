import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const README = 'Roadmap\n=======\n\n- item\n';

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-markers-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), README);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const isResolver = (o: DriverRunOptions) => /left conflict markers/.test(o.prompt);
const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
const MERGED = 'Roadmap\n=======\n\n- item x\n- item y\n';

/** x and y both rewrite the one list item, so whichever merges second conflicts in a file with a heading underline. */
async function run(repo: string, resolve: (current: string, call: number) => string) {
  let calls = 0;
  const plan: PlanSpec = {
    goal: 'g',
    driver: 'mock',
    concurrency: 2,
    maxAttempts: 3,
    tasks: [
      { id: 'x', title: 'X', prompt: 'p' },
      { id: 'y', title: 'Y', prompt: 'p' },
    ],
  };
  const mock = new MockDriver((o): MockStep => {
    const current = readFileSync(join(o.cwd, 'README.md'), 'utf8');
    if (isResolver(o)) return { files: { 'README.md': resolve(current, ++calls) } };
    return { files: { 'README.md': current.replace('- item', `- item ${taskOf(o)}`) } };
  });
  const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(mock) }).run();
  return { state, mock, resolverCalls: () => mock.calls.filter(isResolver) };
}

const show = async (repo: string, ref: string, file: string) => (await exec('git', ['show', `${ref}:${file}`], { cwd: repo })).stdout;

describe('leftover conflict markers', () => {
  it('does not take the underline of a heading for a marker', async () => {
    const repo = await makeRepo();
    const { state, resolverCalls } = await run(repo, () => MERGED);
    assert.equal(state.status, 'done');
    assert.equal(resolverCalls().length, 1, 'a correct resolution is accepted the first time');
    assert.equal(await show(repo, state.integrationBranch, 'README.md'), MERGED);
  });

  it('still catches a separator left behind once the other markers are gone', async () => {
    const repo = await makeRepo();
    const { state, resolverCalls } = await run(repo, (current, call) =>
      // First try: the two outer marker lines are removed, the `=======` between the sides is forgotten.
      call === 1 ? current.split('\n').filter((l) => !/^(<{7}|>{7})/.test(l)).join('\n') : MERGED,
    );
    assert.equal(state.status, 'done');
    assert.equal(resolverCalls().length, 2);
    assert.match(resolverCalls()[1]!.prompt, /left markers in: README\.md/);
    assert.equal(await show(repo, state.integrationBranch, 'README.md'), MERGED);
  });
});
