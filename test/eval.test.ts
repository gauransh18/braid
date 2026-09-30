import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry } from '../src/drivers/driver.js';
import { MockDriver } from '../src/drivers/mock.js';
import { applyVariant, formatSummary, loadSuite, parseVariants, runEval, summarize, type EvalSuite } from '../src/eval.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function makeSuite(): { dir: string; suite: EvalSuite } {
  const dir = mkdtempSync(join(tmpdir(), 'braid-evalsuite-'));
  temps.push(dir);
  mkdirSync(join(dir, 'fx'));
  mkdirSync(join(dir, 'hidden'));
  writeFileSync(join(dir, 'fx', 'answer.js'), 'module.exports = 0;\n');
  // Hidden acceptance test: not in the fixture, so the agent cannot see or edit it.
  writeFileSync(join(dir, 'hidden', 'accept.js'), "if (require('./answer.js') !== 42) { console.error('want 42'); process.exit(1); }\n");
  return {
    dir,
    suite: {
      name: 't',
      cases: [
        {
          id: 'answer',
          fixture: 'fx',
          acceptDir: 'hidden',
          accept: ['node accept.js'],
          plan: { goal: 'g', tasks: [{ id: 'fix', title: 'Fix', prompt: 'make answer.js export 42', driver: 'claude', model: 'stale' }] },
        },
      ],
    },
  };
}

describe('eval', () => {
  it('passes when hidden acceptance passes and fails when it does not, per variant', async () => {
    const { dir, suite } = makeSuite();
    const good = new MockDriver(() => ({ files: { 'answer.js': 'module.exports = 42;\n' }, costUsd: 0.5 }));
    const bad = new MockDriver(() => ({ files: { 'answer.js': 'module.exports = 41;\n' }, costUsd: 0.25 }));
    const drivers = new DriverRegistry().register(good);
    // Register the bad one under another name.
    const badNamed = Object.assign(bad, { name: 'sloppy' });
    drivers.register(badNamed);

    const seen: string[] = [];
    const results = await runEval({
      suite,
      suiteDir: dir,
      variants: parseVariants('mock,sloppy'),
      drivers,
      onResult: (r) => seen.push(`${r.variant}:${r.pass}`),
    });
    assert.deepEqual(seen, ['mock:true', 'sloppy:false']);
    const [ok, no] = results;
    assert.equal(ok!.runStatus, 'done');
    assert.equal(ok!.accepted, true);
    assert.equal(no!.runStatus, 'done', 'run itself succeeds; only hidden acceptance fails');
    assert.equal(no!.accepted, false);
    assert.match(no!.error ?? '', /want 42/);

    const rows = summarize(results);
    assert.equal(rows[0]!.passRate, 1);
    assert.equal(rows[0]!.costPerPass, 0.5);
    assert.equal(rows[1]!.passRate, 0);
    assert.equal(rows[1]!.costPerPass, null);
    assert.match(formatSummary(rows), /mock\s+1\/1\s+100%/);
  });

  it('forces the variant onto every task, dropping per-task overrides', () => {
    const { suite } = makeSuite();
    const plan = applyVariant(suite.cases[0]!.plan, { driver: 'codex', model: 'm' });
    assert.equal(plan.driver, 'codex');
    assert.equal(plan.model, 'm');
    assert.equal(plan.tasks[0]!.driver, undefined);
    assert.equal(plan.tasks[0]!.model, undefined);
  });

  it('parses variants and validates suites', async () => {
    assert.deepEqual(parseVariants('claude:sonnet, codex'), [{ driver: 'claude', model: 'sonnet' }, { driver: 'codex', model: undefined }]);
    const dir = mkdtempSync(join(tmpdir(), 'braid-evalsuite-'));
    temps.push(dir);
    writeFileSync(join(dir, 's.json'), JSON.stringify({ name: 'x', cases: [{ id: 'a', plan: { goal: 'g', tasks: [] }, accept: [] }] }));
    await assert.rejects(loadSuite(join(dir, 's.json')), /needs a fixture or repo[\s\S]*at least one accept/);
  });

  it('loads the bundled starter suite', async () => {
    const suite = await loadSuite(join(process.cwd(), 'evals', 'suite.json'));
    assert.ok(suite.cases.length >= 2);
  });
});
