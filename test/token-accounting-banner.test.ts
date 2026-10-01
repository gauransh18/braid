import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';
import { describe, it } from 'node:test';

// The dashboard is one HTML file with no module system, so the banner logic is lifted out of it and run on its own.
const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function runOutcome()'), html.indexOf('function renderBanner()'));
assert.ok(source.startsWith('function runOutcome()'), 'runOutcome is still in ui/index.html');

interface Outcome {
  kind: string;
  label: string;
  title: string;
  detail: string;
  bubble: string;
  open?: string;
}

const esc = (x: unknown) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function outcome(tasks: Record<string, { status: string; error?: string }>, status = 'failed'): Outcome {
  const full = Object.fromEntries(Object.entries(tasks).map(([id, t]) => [id, { id, ...t }]));
  const S = { state: { status, integrationBranch: 'braid/x/integration', tasks: full }, plan: { tasks: Object.keys(tasks).map((id) => ({ id, title: id.toUpperCase() })) } };
  const ctx = createContext({ S, esc });
  runInContext(`${source}\nthis.runOutcome = runOutcome;`, ctx);
  return (ctx as unknown as { runOutcome: () => Outcome }).runOutcome();
}

const TASK_LIMIT = 'token budget exhausted for this task (3.1M fresh and output tokens used by its agent calls; the limit is 3M). Raise taskBudgetTokens in the plan or budgetTokens on this task, or set it to 0 for no limit';
const RUN_LIMIT = 'token budget exhausted (1.2k fresh and output tokens used; the limit is 1k). Raise budgetTokens in the plan, or set it to 0 for no limit';

describe('dashboard banner for token limits', () => {
  it('reads a per-task stop as one failed task in an otherwise fine run', () => {
    const o = outcome({ a: { status: 'done' }, b: { status: 'failed', error: TASK_LIMIT }, c: { status: 'blocked', error: 'dependency "b" did not complete' }, d: { status: 'done' } });
    assert.equal(o.kind, 'limit');
    assert.equal(o.label, 'task hit its limit');
    assert.equal(o.title, 'One task used up its token allowance');
    assert.match(o.detail, /<b[^>]*>B<\/b> reached it \(3\.1M fresh and output tokens used by its agent calls; the limit is 3M\) and was stopped; the other tasks carried on\./);
    assert.match(o.detail, /1 task that waited on it could not start\./);
    assert.match(o.detail, /2 of 4 strands are in the braid\./);
    assert.match(o.detail, /<code>taskBudgetTokens<\/code> in the plan, or <code>budgetTokens<\/code> on one task/);
    assert.equal(o.open, 'b', 'the banner offers to open the task that ran out');
    assert.ok(!/whole run/.test(o.detail), 'it is not the run-wide limit');
  });

  it('counts several tasks that ran out, and the ones that failed for another reason', () => {
    const o = outcome({ a: { status: 'done' }, b: { status: 'failed', error: TASK_LIMIT }, c: { status: 'failed', error: TASK_LIMIT }, d: { status: 'failed', error: 'Verification failed' } });
    assert.equal(o.title, '2 tasks used up their token allowance');
    assert.match(o.detail, /<b[^>]*>B<\/b> and <b[^>]*>C<\/b> reached it and were stopped/);
    assert.match(o.detail, /1 other task failed on its own; open it to see why\./);
  });

  it('still reads the run-wide cap as the whole run stopping, and no longer talks of a default pool', () => {
    const o = outcome({ a: { status: 'done' }, b: { status: 'skipped', error: RUN_LIMIT }, c: { status: 'failed', error: RUN_LIMIT } });
    assert.equal(o.label, 'stopped at limit');
    assert.equal(o.title, 'Stopped: the token limit was reached');
    assert.match(o.detail, /caps the tokens the whole run may use \(<code>budgetTokens<\/code>\)/);
    assert.match(o.detail, /\(1\.2k fresh and output tokens used; the limit is 1k\)/);
    assert.ok(!/3 million/.test(o.detail), 'there is no default pool any more');
  });

  it('puts the run-wide stop first when both happened, and counts the task that ran out as failed on its own', () => {
    const o = outcome({ a: { status: 'failed', error: TASK_LIMIT }, b: { status: 'skipped', error: RUN_LIMIT } });
    assert.equal(o.label, 'stopped at limit');
    assert.match(o.detail, /also failed on/);
  });
});
