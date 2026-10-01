import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type Driver, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { applyReplan, validatePlan } from '../src/plan.js';
import { planGoal } from '../src/planner.js';
import { plannerPrompt } from '../src/prompts.js';
import { exec } from '../src/proc.js';
import type { HarnessEvent } from '../src/store.js';
import { touchesOverlap } from '../src/touches.js';
import type { AgentResult, PlanSpec } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** Setup that, in the worktree of task `a`, does not finish until the test creates `gate`: a task held in setup. */
const setupJs = (gate: string) => `
const fs = require('node:fs');
if (require('node:path').basename(process.cwd()) === 'a') {
  const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) clearInterval(t); }, 20);
}
`;

async function makeRepo(): Promise<{ repo: string; gate: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-touches-'));
  temps.push(dir);
  const gate = join(dir, 'gate');
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'setup.js'), setupJs(gate));
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return { repo: await Git.toplevel(dir), gate };
}

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
const work = (o: DriverRunOptions): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' } });

describe('touchesOverlap', () => {
  const yes = (a: string[], b: string[]) => {
    assert.equal(touchesOverlap(a, b), true, `${a} should overlap ${b}`);
    assert.equal(touchesOverlap(b, a), true, `${b} should overlap ${a}`);
  };
  const no = (a: string[], b: string[]) => {
    assert.equal(touchesOverlap(a, b), false, `${a} should not overlap ${b}`);
    assert.equal(touchesOverlap(b, a), false, `${b} should not overlap ${a}`);
  };

  it('treats a list with nothing in it as unrestricted: it overlaps nothing', () => {
    no([], []);
    no([], ['src/**']);
    no(['**'], []);
  });

  it('tells files apart and finds the same file', () => {
    yes(['src/a.ts'], ['src/a.ts']);
    no(['src/a.ts'], ['src/b.ts']);
    no(['src/a.ts'], ['lib/a.ts']);
    no(['package.json'], ['package-lock.json']);
  });

  it('lets a directory glob cover what is under it, and nothing beside it', () => {
    yes(['src/**'], ['src/a/b/c.ts']);
    yes(['src/**'], ['src/a.ts']);
    yes(['src/**'], ['src/**']);
    yes(['src/**'], ['src/orchestrator/**']);
    no(['src/**'], ['test/a.ts']);
    no(['src/**'], ['srcs/a.ts']);
    no(['src/auth/**'], ['src/api/**']);
  });

  it('takes a trailing slash, or a name that looks like a directory, to cover what is under it', () => {
    yes(['src/'], ['src/a.ts']);
    yes(['src'], ['src/a/b.ts']);
    yes(['.github'], ['.github/workflows/ci.yml']);
    yes(['src/*'], ['src/a/b.ts']);
    no(['src/'], ['test/a.ts']);
  });

  it('keeps a file name with an extension to that file', () => {
    no(['docs/readme.md'], ['**/*.ts']);
    no(['src/README.md'], ['src/**/*.ts']);
    yes(['src/README.md'], ['src/**/*.md']);
  });

  it('handles * and ? inside one name', () => {
    yes(['src/*.ts'], ['src/a.ts']);
    no(['src/*.ts'], ['src/a.md']);
    no(['src/*.ts'], ['src/drivers/claude.ts']);
    no(['src/*.ts'], ['src/*.md']);
    yes(['src/*.ts'], ['src/*.t*']);
    yes(['src/a*'], ['src/*b']);
    yes(['src/a?.ts'], ['src/ab.ts']);
    no(['src/a?.ts'], ['src/abc.ts']);
    yes(['*.md'], ['README.md']);
    no(['*.md'], ['docs/x.md']);
    no(['*.md'], ['docs/**']);
  });

  it('handles ** between directories, matching zero or more of them', () => {
    yes(['a/**/b.ts'], ['a/b.ts']);
    yes(['a/**/b.ts'], ['a/x/y/b.ts']);
    no(['a/**/b.ts'], ['a/x/c.ts']);
    yes(['a/**/b'], ['a/x/c']); // b and c could be directories: a/x/c/b/...
    yes(['**/*.ts'], ['src/a.ts']);
    yes(['**/*.ts'], ['a.ts']);
    no(['**/*.ts'], ['src/a.md']);
    yes(['**/test/**'], ['src/test/a.ts']);
    yes(['a/**/**/b'], ['a/b']);
    yes(['**'], ['anything/at/all.txt']);
    yes(['**'], ['**']);
  });

  it('expands {a,b} groups, and treats a pattern that explodes as everything', () => {
    yes(['src/*.{ts,tsx}'], ['src/a.tsx']);
    no(['src/*.{ts,tsx}'], ['src/a.md']);
    yes(['{src,lib}/**'], ['lib/x.ts']);
    no(['{src,lib}/**'], ['docs/x.md']);
    yes(['src/{a,b/{c,d}}.ts'], ['src/b/d.ts']);
    no(['src/{a,b/{c,d}}.ts'], ['src/b/e.ts']);
    const many = '{a,b}/'.repeat(7) + 'x';
    yes([many], ['zzz/q']);
  });

  it('reads character classes as one character, and what it cannot read as a wildcard', () => {
    yes(['src/[ab].ts'], ['src/a.ts']);
    no(['src/[ab].ts'], ['src/abc.ts']);
    yes(['src/@(a|b).ts'], ['src/c.ts']);
    yes(['src/{unbalanced.ts'], ['src/x.ts']);
  });

  it('normalizes separators, ./, doubled and leading slashes, and case', () => {
    yes(['./src//a.ts'], ['src/a.ts']);
    yes(['src\\a.ts'], ['src/a.ts']);
    yes(['/src/a.ts'], ['src/a.ts']);
    yes(['SRC/A.ts'], ['src/a.ts']);
    yes(['.\\src\\**'], ['src/a/b.ts']);
    no(['./src/a.ts'], ['./src/b.ts']);
  });

  it('takes ., an empty path and .. to mean the whole tree', () => {
    yes(['.'], ['src/a.ts']);
    yes(['./'], ['src/a.ts']);
    yes(['../x'], ['src/a.ts']);
    yes(['src/../lib/x.ts'], ['docs/y.md']);
  });

  it('overlaps when any pattern of one list meets any pattern of the other', () => {
    yes(['docs/**', 'src/a.ts'], ['lib/**', 'src/**']);
    no(['docs/**', 'src/a.ts'], ['lib/**', 'test/**']);
  });
});

describe('touches in a plan', () => {
  const plan = (task: object, extra: object = {}) => ({ goal: 'g', tasks: [{ id: 'a', title: 'A', prompt: 'p', ...task }], ...extra }) as PlanSpec;

  it('accepts an array of non-empty strings, or none', () => {
    validatePlan(plan({ touches: ['src/**', 'package.json'] }));
    validatePlan(plan({ touches: [] }));
    validatePlan(plan({}));
  });

  it('refuses anything else, naming the task', () => {
    for (const bad of ['src/**', [''], ['  '], [1], [null], { 0: 'src' }, null]) {
      assert.throws(() => validatePlan(plan({ touches: bad })), /task "a" touches must be an array of non-empty strings/, JSON.stringify(bad));
    }
  });

  it('lets the replacements of a failed task inherit its touches', () => {
    const p = plan({ touches: ['src/auth/**'] });
    const { added } = applyReplan(p, 'a', { action: 'replace', tasks: [{ id: 'a1', prompt: 'x' }, { id: 'a2', prompt: 'y' }] }, new Set());
    assert.deepEqual(added.map((t) => t.touches), [['src/auth/**'], ['src/auth/**']]);
  });

  it('asks the planner for touches, and keeps what it answers', async () => {
    const prompt = plannerPrompt('add login', ['npm test']);
    assert.match(prompt, /"touches"/);
    assert.match(prompt, /never run at the same time/);
    const reply = JSON.stringify({ goal: 'g', tasks: [{ id: 'one', title: 'One', prompt: 'p', deps: [], touches: ['src/auth/**'] }, { id: 'two', title: 'Two', prompt: 'p', touches: ['docs/**'] }] });
    const planner = new MockDriver(() => ({ text: `\`\`\`json\n${reply}\n\`\`\`` }));
    const { plan: drafted } = await planGoal(planner, { repo: tmpdir(), goal: 'add login' });
    assert.deepEqual(drafted.tasks.map((t) => t.touches), [['src/auth/**'], ['docs/**']]);
    assert.match(planner.calls[0]!.prompt, /"touches"/);

    const bad = new MockDriver(() => ({ text: JSON.stringify({ goal: 'g', tasks: [{ id: 'one', title: 'One', prompt: 'p', touches: 'src' }] }) }));
    await assert.rejects(planGoal(bad, { repo: tmpdir(), goal: 'x' }), /touches must be an array/);
  });
});

/** An agent that holds the named tasks until the test lets them go, and records who it was called for. */
class GateDriver implements Driver {
  readonly name = 'mock';
  readonly called: string[] = [];
  private readonly gates: (() => void)[] = [];
  private opened = false;
  constructor(private readonly held: string[]) {}

  /** Lets every held task, and any that arrives later, go on. Tests do it in `finally` so a failed assertion cannot hang the run. */
  open(): void {
    this.opened = true;
    for (const go of this.gates) go();
  }

  async run(opts: DriverRunOptions): Promise<AgentResult> {
    const id = taskOf(opts);
    if (id !== 'reviewer') this.called.push(id);
    if (this.held.includes(id) && !this.opened) await new Promise<void>((resolve) => this.gates.push(resolve));
    if (opts.canEdit) {
      const path = join(opts.cwd, `${id}.txt`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'ok\n');
    }
    return { ok: true, text: 'done', costUsd: 0 };
  }
}

async function waitFor(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function watch(orch: Orchestrator): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  orch.store.onEvent((e) => events.push(e));
  return events;
}

const at = (events: HarnessEvent[], task: string, status: string) => events.findIndex((e) => e.type === 'task_status' && e.task === task && e.status === status);

describe('the scheduler and touches', () => {
  it('holds a task back while a running one touches the same paths, and starts it as soon as that one is done', async () => {
    const { repo } = await makeRepo();
    const agent = new GateDriver(['a']);
    const orch = new Orchestrator({
      repo,
      drivers: new DriverRegistry().register(agent),
      plan: {
        goal: 'g',
        driver: 'mock',
        concurrency: 4,
        tasks: [
          { id: 'a', title: 'A', prompt: 'p', touches: ['src/**'] },
          { id: 'b', title: 'B', prompt: 'p', touches: ['src/x.ts'] },
          { id: 'c', title: 'C', prompt: 'p', touches: ['docs/**'] },
          { id: 'd', title: 'D', prompt: 'p' },
        ],
      },
    });
    const events = watch(orch);
    const run = orch.run();
    try {
      await waitFor('c and d to finish while a is held', () => at(events, 'c', 'done') >= 0 && at(events, 'd', 'done') >= 0 && agent.called.includes('a'));
      assert.deepEqual([...agent.called].sort(), ['a', 'c', 'd'], 'b has not started: it touches what a touches');
      assert.equal(at(events, 'b', 'running'), -1);
      assert.ok(at(events, 'a', 'running') >= 0);
    } finally {
      agent.open();
    }
    const state = await run;
    assert.equal(state.status, 'done');
    assert.ok(at(events, 'b', 'running') > at(events, 'a', 'done'), 'b started only after a was merged');
  });

  it('counts a task that is still in setup as running, though its status says pending', async () => {
    const { repo, gate } = await makeRepo();
    // a is held in setup (status "pending") until the gate opens; x finishes meanwhile and wakes the scheduler.
    const mock = new MockDriver(work);
    const orch = new Orchestrator({
      repo,
      drivers: new DriverRegistry().register(mock),
      plan: {
        goal: 'g',
        driver: 'mock',
        concurrency: 3,
        setup: ['node setup.js'],
        tasks: [
          { id: 'x', title: 'X', prompt: 'p' },
          { id: 'a', title: 'A', prompt: 'p', touches: ['src/**'] },
          { id: 'b', title: 'B', prompt: 'p', touches: ['src/**'] },
        ],
      },
    });
    const events = watch(orch);
    const run = orch.run();
    try {
      await waitFor('x to finish', () => at(events, 'x', 'done') >= 0);
      await new Promise((r) => setTimeout(r, 500)); // long enough for b to have started if the scheduler let it
      assert.equal(at(events, 'a', 'running'), -1, 'a is still in setup');
      assert.equal(at(events, 'b', 'running'), -1, 'b waits for a although a is not "running" yet');
    } finally {
      writeFileSync(gate, 'open');
    }
    const state = await run;
    assert.equal(state.status, 'done');
    assert.ok(at(events, 'b', 'running') > at(events, 'a', 'done'), 'b waited for a');
    assert.equal(state.tasks.b!.attempts, 1);
  });

  it('never stalls on an overlap: tasks that all touch everything run one after another', async () => {
    const { repo } = await makeRepo();
    const orch = new Orchestrator({
      repo,
      drivers: new DriverRegistry().register(new MockDriver(work)),
      plan: {
        goal: 'g',
        driver: 'mock',
        concurrency: 3,
        tasks: ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id, prompt: 'p', touches: ['**'] })),
      },
    });
    const events = watch(orch);
    const state = await orch.run();
    assert.equal(state.status, 'done');
    for (const [prev, next] of [['a', 'b'], ['b', 'c'], ['c', 'd']] as const) assert.ok(at(events, next, 'running') > at(events, prev, 'done'), `${next} after ${prev}`);
  });

  it('starts an overlapping task once the one it waited for has failed, too', async () => {
    const { repo } = await makeRepo();
    const orch = new Orchestrator({
      repo,
      drivers: new DriverRegistry().register(new MockDriver((o) => (taskOf(o) === 'a' ? { ok: false, text: 'cannot do it' } : work(o)))),
      plan: {
        goal: 'g',
        driver: 'mock',
        maxAttempts: 1,
        tasks: [
          { id: 'a', title: 'A', prompt: 'p', touches: ['src/**'] },
          { id: 'b', title: 'B', prompt: 'p', touches: ['src/**'] },
        ],
      },
    });
    const state = await orch.run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.equal(state.tasks.b!.status, 'done');
  });

  it('does not hold back tasks that name no touches, and does not let them hold others back', async () => {
    const { repo } = await makeRepo();
    const agent = new GateDriver(['a']);
    const orch = new Orchestrator({
      repo,
      drivers: new DriverRegistry().register(agent),
      plan: {
        goal: 'g',
        driver: 'mock',
        concurrency: 3,
        tasks: [
          { id: 'a', title: 'A', prompt: 'p' },
          { id: 'b', title: 'B', prompt: 'p', touches: ['**'] },
          { id: 'c', title: 'C', prompt: 'p', touches: [] },
        ],
      },
    });
    const events = watch(orch);
    const run = orch.run();
    try {
      await waitFor('b and c to finish while a is held', () => at(events, 'b', 'done') >= 0 && at(events, 'c', 'done') >= 0);
      assert.equal(at(events, 'a', 'done'), -1);
    } finally {
      agent.open();
    }
    assert.equal((await run).status, 'done');
  });
});
