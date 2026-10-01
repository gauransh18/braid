import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import { describeTokens } from '../src/tokens.js';
import type { PlanSpec, RunState } from '../src/types.js';

// The dashboard is one inline script in ui/index.html that nothing else compiles or runs, so a typo in it ships as a
// blank page. This parses it, and runs its pure functions (the run outcome and the banner, the escaping, the token
// format) in a vm with a stub page, against run states the real orchestrator produced, so a change to what the
// orchestrator writes and what the page looks for cannot drift apart unnoticed. The copy itself is free to change:
// these assert on the outcome's `kind` and on a few key words.
const PAGE = readFileSync(fileURLToPath(new URL('../../ui/index.html', import.meta.url)), 'utf8');

interface InlineScript {
  code: string;
  /** 1-based line of the <script> tag, so a syntax error points into the HTML file. */
  line: number;
}

function inlineScripts(html: string): InlineScript[] {
  const out: InlineScript[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? '';
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (/\bsrc\s*=/i.test(attrs) || (type && type !== 'text/javascript' && type !== 'application/javascript')) continue;
    out.push({ code: m[2] ?? '', line: html.slice(0, m.index).split('\n').length });
  }
  return out;
}

/**
 * The source of every function the page declares, to be loaded without running the page. The page wraps everything in
 * one IIFE, so the declarations are found inside it: `function f() {}` and `const f = () => ...`. Nothing else is
 * evaluated (no event listeners, no timers, no DOM lookups); a function only runs when a test calls it. Names in `skip`
 * are left out because the test provides its own.
 */
function functionSources(code: string, skip: string[]): string[] {
  const file = ts.createSourceFile('ui.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const out: string[] = [];
  const isFn = (e: ts.Expression | undefined) => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
  const take = (statements: readonly ts.Statement[]) => {
    for (const st of statements) {
      if (ts.isFunctionDeclaration(st) && st.name) {
        if (!skip.includes(st.name.text)) out.push(st.getText(file));
      } else if (ts.isVariableStatement(st)) {
        const decls = st.declarationList.declarations;
        if (decls.every((d) => isFn(d.initializer) && ts.isIdentifier(d.name) && !skip.includes(d.name.text))) out.push(st.getText(file));
      } else if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) {
        let callee: ts.Expression = st.expression.expression;
        while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
        if (isFn(callee) && ts.isBlock((callee as ts.ArrowFunction).body)) take(((callee as ts.ArrowFunction).body as ts.Block).statements);
      }
    }
  };
  take(file.statements);
  return out;
}

const SCRIPTS = inlineScripts(PAGE);
const FUNCTIONS = SCRIPTS.flatMap((s) => functionSources(s.code, ['$'])).join('\n');

/** A stub page: the globals the functions read (`S`, `CTL`, `$`), and a record of the elements they touch. */
function loadPage(S: unknown, CTL: unknown = { on: false, token: null, active: null }) {
  const elements = new Map<string, Record<string, any>>();
  const $ = (id: string) => {
    let el = elements.get(id);
    if (!el) elements.set(id, (el = { id, hidden: true, className: '', innerHTML: '', textContent: '', style: {} }));
    return el;
  };
  const page: Record<string, any> = { S, CTL, $ };
  vm.createContext(page);
  try {
    vm.runInContext(FUNCTIONS, page, { filename: 'ui/index.html (functions)' });
  } catch (err) {
    // Do not bury the cause under a failure in every test: the parse test above points at the line.
    throw new Error(`the functions in ui/index.html could not be loaded (${(err as Error).message}); see the test that parses the script`);
  }
  return { page, element: $ };
}

describe('the script in ui/index.html', () => {
  it('has inline scripts, and every one of them parses', () => {
    assert.ok(SCRIPTS.length > 0, 'found no inline <script> in ui/index.html; has the page moved its code to a file?');
    for (const s of SCRIPTS) {
      try {
        new vm.Script(s.code, { filename: 'ui/index.html', lineOffset: s.line - 1 });
      } catch (err) {
        // The stack of a syntax error starts with file:line, the line itself and a caret.
        assert.fail(`the script at line ${s.line} of ui/index.html does not parse:\n${(err as Error).stack?.split('\n').slice(0, 5).join('\n')}`);
      }
    }
  });

  it('declares the functions these tests load', () => {
    const { page } = loadPage({});
    for (const name of ['runOutcome', 'renderBanner', 'esc', 'depthMap', 'tokLine']) {
      assert.ok(typeof page[name] === 'function' || vm.runInContext(`typeof ${name}`, page) === 'function', `${name} is gone or no longer a plain function declaration`);
    }
  });
});

describe('the page helpers', () => {
  const { page } = loadPage({});
  const call = (expr: string) => vm.runInContext(expr, page);

  it('escapes what it puts into HTML', () => {
    assert.equal(call(`esc('<img src=x onerror="a()"> & \\'q\\'')`), '&lt;img src=x onerror=&quot;a()&quot;&gt; &amp; &#39;q&#39;');
    assert.equal(call('esc(null)'), '');
    assert.equal(call('esc(0)'), '0');
  });

  it('puts each task in a step after the ones it depends on', () => {
    const depth = JSON.parse(call(`JSON.stringify(depthMap([{ id: 'c', deps: ['a', 'b'] }, { id: 'a' }, { id: 'b', deps: ['a'] }, { id: 'd' }]))`));
    assert.deepEqual(depth, { a: 0, b: 1, c: 2, d: 0 });
  });

  it('writes token counts the way the command line does', () => {
    for (const n of [0, 5, 950, 999, 1000, 1234, 9999, 10_000, 12_300, 99_999, 100_000, 999_999, 1_000_000, 4_560_000]) {
      const tokens = { input: n, cached: 0, output: 0 };
      page.sample = tokens;
      assert.equal(call('tokLine(sample)'), describeTokens(tokens, false), `${n} tokens`);
    }
    assert.equal(call('tokLine(undefined)'), '-');
  });
});

// ---------------------------------------------------------------- the banner, on states the orchestrator wrote

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-ui-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  // Fails when any .txt file contains "bad".
  writeFileSync(join(dir, 'check.js'), "const fs = require('fs');\nfor (const f of fs.readdirSync('.')) if (f.endsWith('.txt') && fs.readFileSync(f, 'utf8').includes('bad')) process.exit(1);\n");
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
const work = (o: DriverRunOptions): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' } });
const two = (extra: Partial<PlanSpec> = {}): PlanSpec => ({ goal: 'g', driver: 'mock', concurrency: 1, tasks: [{ id: 'a', title: 'First', prompt: 'p' }, { id: 'b', title: 'Second', prompt: 'p' }], ...extra });

/** Run a plan to its end with scripted agents, and hand back what the dashboard would read from the API. */
async function ended(plan: PlanSpec, script: (o: DriverRunOptions, i: number) => MockStep, extra: Partial<OrchestratorOptions> = {}) {
  const repo = await makeRepo();
  const orch = new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(new MockDriver(script)), retryDelaysMs: [1, 1], ...extra });
  const state = JSON.parse(JSON.stringify(await orch.run())) as RunState;
  return { S: { runs: [], runId: state.runId, plan: JSON.parse(JSON.stringify(plan)), state, events: [], color: {} }, state };
}

const OUT_OF_USAGE = 'Claude AI usage limit reached|1700000000';

describe('what the dashboard says about how a run ended', () => {
  const outcome = (S: unknown) => loadPage(S).page.runOutcome() as Record<string, any>;

  it('says a finished run is done and offers the merge command', async () => {
    const { S, state } = await ended(two(), work);
    assert.equal(state.status, 'done');
    const o = outcome(S);
    assert.equal(o.kind, 'done');
    assert.equal(o.label, 'done');
    assert.equal(o.copy, `git merge ${state.integrationBranch}`);
    assert.match(o.detail, new RegExp(state.integrationBranch.replace(/[/]/g, '\\/')));
  });

  it('says a task that failed for good needs attention, names it, and links to it', async () => {
    const { S, state } = await ended(two({ verify: ['node check.js'], maxAttempts: 1 }), (o) => ({ files: { [`${taskOf(o)}.txt`]: taskOf(o) === 'a' ? 'bad\n' : 'ok\n' } }));
    assert.equal(state.tasks.a!.status, 'failed');
    const o = outcome(S);
    assert.equal(o.kind, 'attention');
    assert.equal(o.open, 'a');
    assert.match(o.detail, /First/, 'names the task that failed');
    assert.match(o.detail, /Verification failed|check\.js/i, 'says why');
  });

  it('says a run stopped at the token limit, and what to change', async () => {
    const heavy = { input: 600, cached: 5_000_000, output: 600 };
    const { S, state } = await ended(two({ budgetTokens: 1000 }), (o) => ({ ...work(o), tokens: heavy }));
    assert.match(state.tasks.b!.error!, /token budget exhausted/);
    const o = outcome(S);
    assert.equal(o.kind, 'limit');
    assert.match(o.title, /token/i);
    assert.match(o.detail, /budgetTokens/);
    assert.match(o.detail, /Resume/);
  });

  it('says a run stopped because the agent is out of usage, with what the agent said', async () => {
    const { S, state } = await ended(two(), () => ({ ok: false, text: OUT_OF_USAGE }));
    assert.match(state.tasks.a!.error!, /usage or credit limit reached/);
    const o = outcome(S);
    assert.equal(o.kind, 'limit');
    assert.match(o.title, /usage|credit/i);
    assert.match(o.detail, /usage limit reached/i);
    assert.doesNotMatch(o.title, /token limit/i, 'not mistaken for the token limit');
  });

  it('says a run you stopped is safe to resume', async () => {
    const ac = new AbortController();
    const repo = await makeRepo();
    const orch = new Orchestrator({ repo, plan: two(), drivers: new DriverRegistry().register(new MockDriver(() => ({ delayMs: 20_000 }))), signal: ac.signal });
    orch.store.onEvent((e) => e.type === 'task_status' && e.status === 'running' && setTimeout(() => ac.abort(), 50));
    const state = JSON.parse(JSON.stringify(await orch.run())) as RunState;
    assert.equal(state.status, 'aborted');
    const o = outcome({ runs: [], runId: state.runId, plan: two(), state, events: [], color: {} });
    assert.equal(o.kind, 'stopped');
    assert.match(o.title, /stopped/i);
    assert.match(o.detail, /Resume/);
  });

  it('says nothing while a run is still going', async () => {
    const { S } = await ended(two(), work);
    S.state.status = 'running';
    assert.equal(outcome(S), null);
    const { page, element } = loadPage(S);
    page.renderBanner();
    assert.equal(element('runBanner').hidden, true);
    assert.equal(loadPage({ ...S, state: null }).page.runOutcome(), null, 'and nothing before the run has loaded');
  });
});

describe('the banner', () => {
  it('shows the outcome, coloured by its kind, with the merge button on a finished run and no Resume', async () => {
    const { S, state } = await ended(two(), work);
    const { page, element } = loadPage(S, { on: true, token: 't', active: null });
    page.renderBanner();
    const el = element('runBanner');
    assert.equal(el.hidden, false);
    assert.equal(el.className, 'banner done');
    assert.match(el.innerHTML, /data-b="copy"/);
    assert.ok(el.innerHTML.includes(`git merge ${state.integrationBranch}`));
    assert.doesNotMatch(el.innerHTML, /data-b="resume"/, 'nothing to resume');
  });

  it('offers Resume on an unfinished run when the dashboard has controls, and the command when it has not', async () => {
    const { S, state } = await ended(two(), () => ({ ok: false, text: OUT_OF_USAGE }));
    const withControls = loadPage(S, { on: true, token: 't', active: null });
    withControls.page.renderBanner();
    assert.equal(withControls.element('runBanner').className, 'banner limit');
    assert.match(withControls.element('runBanner').innerHTML, /data-b="resume"/);

    const running = loadPage(S, { on: true, token: 't', active: { runId: state.runId } });
    running.page.renderBanner();
    assert.doesNotMatch(running.element('runBanner').innerHTML, /data-b="resume"/, 'not while something is already running');

    const readOnly = loadPage(S);
    readOnly.page.renderBanner();
    assert.doesNotMatch(readOnly.element('runBanner').innerHTML, /data-b="resume"/);
    assert.ok(readOnly.element('runBanner').innerHTML.includes(`braid resume ${state.runId}`));
  });

  it('puts the failed task on a button that opens it, and escapes what the agent wrote', async () => {
    const { S } = await ended(two({ verify: ['node check.js'], maxAttempts: 1 }), (o) => ({ files: { [`${taskOf(o)}.txt`]: taskOf(o) === 'a' ? 'bad\n' : 'ok\n' } }));
    S.plan.tasks[0]!.title = '<b onmouseover="x()">First</b>';
    const { page, element } = loadPage(S);
    page.renderBanner();
    const html = element('runBanner').innerHTML as string;
    assert.equal(element('runBanner').className, 'banner attention');
    assert.match(html, /data-b="open" data-task="a"/);
    assert.ok(!html.includes('<b onmouseover'), 'the task title is escaped');
  });
});
