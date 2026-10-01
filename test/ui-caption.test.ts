import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';
import { describe, it } from 'node:test';

// The dashboard is one HTML file with no module system, so the desk captions are lifted out of it and run on their own.
const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function captionFor('), html.indexOf('function maxAttempts('));
assert.ok(source.startsWith('function captionFor('), 'captionFor is still in ui/index.html');

type Task = { status: string; attempts?: number; heldBy?: string[]; error?: string };

/** The caption of task `id` in a run whose tasks have these states; every task is named by the upper case of its id. */
function caption(tasks: Record<string, Task>, id: string, deps: Record<string, string[]> = {}): string {
  const plan = { tasks: Object.keys(tasks).map((t) => ({ id: t, title: t.toUpperCase(), deps: deps[t] ?? [] })) };
  const state = { tasks: Object.fromEntries(Object.entries(tasks).map(([t, s]) => [t, { id: t, attempts: 0, ...s }])) };
  const ctx = createContext({ S: { plan, state } });
  runInContext(`${source}\nthis.captionFor = captionFor;`, ctx);
  return (ctx as unknown as { captionFor: (t: unknown, s: unknown) => string }).captionFor(plan.tasks.find((t) => t.id === id), state.tasks[id]);
}

describe('the caption of a task that has not started', () => {
  it('says it waits for a free agent when nothing else holds it back', () => {
    assert.equal(caption({ x: { status: 'running' }, b: { status: 'pending' } }, 'b'), 'Ready: waiting for a free agent');
  });

  it('names the running task it is kept apart from when their touches overlap', () => {
    assert.equal(caption({ x: { status: 'running' }, b: { status: 'pending', heldBy: ['x'] } }, 'b'), 'Waiting for X: it changes the same files');
    assert.equal(caption({ x: { status: 'running' }, y: { status: 'running' }, z: { status: 'running' }, b: { status: 'pending', heldBy: ['x', 'y', 'z'] } }, 'b'), 'Waiting for X and Y and 1 more: they change the same files');
  });

  it('still says what it waits for first when its dependencies are not done', () => {
    assert.equal(caption({ a: { status: 'running' }, b: { status: 'pending', heldBy: ['a'] } }, 'b', { b: ['a'] }), 'Waiting for A');
  });
});
