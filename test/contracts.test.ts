import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { cleanContracts, contractsFor, inheritContracts, resolveTask, validatePlan } from '../src/plan.js';
import { plannerPrompt, reviewerPrompt, workerPrompt } from '../src/prompts.js';
import { exec } from '../src/proc.js';
import type { PlanSpec } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-contracts-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const task = (id: string, extra: object = {}) => ({ id, title: id.toUpperCase(), prompt: 'p', ...extra });
const plan = (extra: Partial<PlanSpec> = {}): PlanSpec => ({
  goal: 'g',
  tasks: [task('billing'), task('invoice'), task('docs')],
  contracts: [{ name: 'amount', meaning: 'integer cents, never dollars', tasks: ['billing', 'invoice'] }],
  ...extra,
});

describe('contracts in a plan', () => {
  it('accepts a well-formed contract', () => {
    validatePlan(plan());
  });

  it('names every problem: not an array, missing fields, duplicates, unknown task ids', () => {
    assert.throws(() => validatePlan(plan({ contracts: {} as never })), /plan\.contracts must be an array/);
    assert.throws(() => validatePlan(plan({ contracts: [{ name: '', meaning: 'x' }] })), /contracts\[0\]\.name must be a non-empty string/);
    assert.throws(() => validatePlan(plan({ contracts: [{ name: 'a', meaning: ' ' }] })), /contracts\[0\]\.meaning must be a non-empty string/);
    assert.throws(
      () => validatePlan(plan({ contracts: [{ name: 'a', meaning: 'x' }, { name: 'a', meaning: 'y' }] })),
      /duplicate contract "a"/,
    );
    assert.throws(() => validatePlan(plan({ contracts: [{ name: 'a', meaning: 'x', tasks: ['nope'] }] })), /unknown task "nope"/);
  });

  it('tells a task the contracts that name it, and those that name no task', () => {
    const p = plan({ contracts: [{ name: 'amount', meaning: 'cents', tasks: ['billing'] }, { name: 'createdAt', meaning: 'UTC ISO 8601' }] });
    assert.deepEqual(contractsFor(p, 'billing').map((c) => c.name), ['amount', 'createdAt']);
    assert.deepEqual(contractsFor(p, 'docs').map((c) => c.name), ['createdAt']);
    assert.deepEqual(contractsFor({ goal: 'g', tasks: [] }, 'x'), []);
  });

  it('holds the tasks that replace a failed one to the same contracts', () => {
    const p = plan();
    inheritContracts(p, 'billing', ['billing-a', 'billing-b']);
    assert.deepEqual(p.contracts![0]!.tasks, ['billing', 'invoice', 'billing-a', 'billing-b']);
    inheritContracts(p, 'docs', ['docs-a']);
    assert.deepEqual(p.contracts![0]!.tasks, ['billing', 'invoice', 'billing-a', 'billing-b']);
  });
});

describe('contracts a planner proposes', () => {
  const ids = new Set(['billing', 'invoice']);

  it('keeps usable ones and drops unknown task ids without losing the contract', () => {
    const got = cleanContracts([{ name: 'amount', meaning: ' integer cents ', tasks: ['billing', 'ghost'] }], ids);
    assert.deepEqual(got, [{ name: 'amount', meaning: 'integer cents', tasks: ['billing'] }]);
  });

  it('drops one that names only tasks that do not exist, and malformed or repeated ones', () => {
    const got = cleanContracts(
      [
        { name: 'a', meaning: 'x', tasks: ['ghost'] },
        { name: '', meaning: 'x' },
        { name: 'b' },
        'junk',
        null,
        { name: 'c', meaning: 'y' },
        { name: 'c', meaning: 'again' },
      ],
      ids,
    );
    assert.deepEqual(got, [{ name: 'c', meaning: 'y' }]);
    assert.deepEqual(cleanContracts(undefined, ids), []);
    assert.deepEqual(cleanContracts('nope', ids), []);
  });
});

describe('contracts in prompts', () => {
  const resolve = (p: PlanSpec, id: string) => resolveTask(p, p.tasks.find((t) => t.id === id)!);

  it('the worker is told the meaning and who else uses it', () => {
    const p = plan();
    const text = workerPrompt(p, resolve(p, 'billing'), []);
    assert.match(text, /Shared contracts/);
    assert.match(text, /- amount: integer cents, never dollars \(also used by: invoice\)/);
  });

  it('a task no contract names is not told any, and keeps the prompt it had', () => {
    const p = plan();
    assert.doesNotMatch(workerPrompt(p, resolve(p, 'docs'), []), /Shared contracts/);
    const bare = { goal: 'g', tasks: [task('a')] };
    assert.doesNotMatch(workerPrompt(bare, resolve(bare, 'a'), []), /contract/i);
    assert.doesNotMatch(reviewerPrompt(bare, resolve(bare, 'a'), 'diff'), /contract/i);
  });

  it('the reviewer sees the contract and is told to reject a diff that reads it differently', () => {
    const p = plan();
    const text = reviewerPrompt(p, resolve(p, 'invoice'), '+ total = amount / 100');
    assert.match(text, /- amount: integer cents, never dollars \(also used by: billing\)/);
    assert.match(text, /reject a diff that reads, writes, converts or documents the data they name with a different meaning/);
  });

  it('the planner is asked to pin shared data', () => {
    assert.match(plannerPrompt('g', []), /"contracts"/);
  });
});

describe('a run with contracts', () => {
  it('hands the contract to the worker and to the reviewer of a task that is named by it', async () => {
    const repo = await makeRepo();
    const seen: DriverRunOptions[] = [];
    const driver = new MockDriver((o): MockStep => {
      seen.push(o);
      if (/strict code reviewer/.test(o.prompt)) return { text: '{"approve": true, "issues": []}' };
      return { files: { 'billing.txt': 'ok\n' } };
    });
    const orch = new Orchestrator({
      repo,
      drivers: new DriverRegistry().register(driver),
      plan: {
        goal: 'g',
        driver: 'mock',
        review: true,
        contracts: [{ name: 'amount', meaning: 'integer cents', tasks: ['billing'] }],
        tasks: [task('billing')],
      },
    });
    const state = await orch.run();
    assert.equal(state.status, 'done');
    const worker = seen.find((o) => /Your task \(billing\)/.test(o.prompt) && !/strict code reviewer/.test(o.prompt));
    const reviewer = seen.find((o) => /strict code reviewer/.test(o.prompt));
    assert.match(worker!.prompt, /- amount: integer cents/);
    assert.match(reviewer!.prompt, /- amount: integer cents/);
  });
});
