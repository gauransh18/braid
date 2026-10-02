#!/usr/bin/env node
// Regenerates the README screenshots in docs/images/ from the real dashboard and the desktop app's own pages.
//
//   npm run build && node scripts/screenshots.mjs [--only name,name]
//
// Needs Google Chrome (or BRAID_CHROME=/path/to/chrome) and a built braid (dist/). Nothing is mocked in the
// dashboard: it shows a real `braid demo` run and real runs that the orchestrator wrote with a scripted agent.
// The desktop launcher and Settings pages are loaded from desktop/ui with a stand-in for the Tauri commands, so
// what they list (recent repositories, which agents are installed) is sample data. Chrome runs headless on a
// throwaway profile; the script stops everything it started.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'src', 'cli.js');
const OUT = join(ROOT, 'docs', 'images');
const CHROME = process.env.BRAID_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9333;
const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null;
const wanted = (name) => !only || only.has(name);

// Every commit the runs make is authored as "braid", so no one's name or e-mail ends up in a picture.
for (const who of ['AUTHOR', 'COMMITTER']) {
  process.env[`GIT_${who}_NAME`] = 'braid';
  process.env[`GIT_${who}_EMAIL`] = 'braid@localhost';
}

const cleanups = [];
const scratch = mkdtempSync(join(tmpdir(), 'braid-shots-'));
cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
mkdirSync(OUT, { recursive: true });

// ---------- Chrome over the DevTools protocol (Node's built-in WebSocket) ----------

async function launchChrome() {
  const profile = join(scratch, 'chrome-profile');
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  cleanups.push(() => proc.kill());
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`Chrome did not start (${CHROME}). Set BRAID_CHROME to a Chrome binary.`);
}

async function openPage({ width, height, scale = 1.5, dark = true, stub }) {
  const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) listeners.forEach((l) => l(msg));
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  if (stub) await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
  const page = {
    send,
    async goto(url) {
      const loaded = new Promise((resolve) => listeners.push((m) => m.method === 'Page.loadEventFired' && resolve()));
      await send('Page.navigate', { url });
      await loaded;
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
    async shot(name, clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
      console.log(`  wrote docs/images/${name}.png`);
    },
    async close() {
      ws.close();
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`).catch(() => undefined);
    },
  };
  return page;
}

// ---------- braid processes ----------

function startBraid(args, { cwd = ROOT, env = {} } = {}) {
  const proc = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  cleanups.push(() => proc.kill('SIGKILL'));
  return {
    proc,
    output: () => output,
    async until(re, ms = 30_000) {
      const end = Date.now() + ms;
      for (;;) {
        const m = re.exec(output);
        if (m) return m;
        if (Date.now() > end) throw new Error(`timed out waiting for ${re} in:\n${output}`);
        await sleep(100);
      }
    },
  };
}

const api = async (base, path) => (await fetch(base + path)).json();

async function waitFor(check, what, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(400);
  }
}

// ---------- real runs with a scripted agent, for the pages that need a stopped run ----------

const CHECK_JS = `const fs = require('fs');
for (const f of fs.readdirSync('.')) {
  if (f.endsWith('.txt') && fs.readFileSync(f, 'utf8').includes('bad')) { console.error(f + ': contains a known-bad value'); process.exit(1); }
}
`;

async function stoppedRuns() {
  const { exec } = await import(pathToFileURL(join(ROOT, 'dist/src/proc.js')));
  const { Git } = await import(pathToFileURL(join(ROOT, 'dist/src/git.js')));
  const { Orchestrator } = await import(pathToFileURL(join(ROOT, 'dist/src/orchestrator.js')));
  const { DriverRegistry } = await import(pathToFileURL(join(ROOT, 'dist/src/drivers/driver.js')));
  const { MockDriver } = await import(pathToFileURL(join(ROOT, 'dist/src/drivers/mock.js')));

  const dir = join(scratch, 'api-server');
  mkdirSync(dir);
  const git = (...a) => exec('git', ['-c', 'user.name=braid', '-c', 'user.email=braid@localhost', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  writeFileSync(join(dir, 'README.md'), '# api-server\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  const repo = await Git.toplevel(dir);
  const taskOf = (o) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? '?';
  const run = async (plan, script) => {
    const orch = new Orchestrator({ repo, plan: { driver: 'mock', verify: ['node check.js'], concurrency: 1, ...plan }, drivers: new DriverRegistry().register(new MockDriver(script)) });
    await orch.run();
    return orch.runId;
  };
  const ok = (o) => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' }, tokens: { input: 18_000, cached: 90_000, output: 6_000 } });

  const ids = {};
  ids.tangled = await run(
    {
      goal: 'Add rate limiting to the API and cover it with tests',
      maxAttempts: 2,
      tasks: [
        { id: 'config', title: 'Read limits from config', prompt: 'p' },
        { id: 'limiter', title: 'Token-bucket rate limiter', prompt: 'p' },
        { id: 'middleware', title: 'Wire the middleware into the routes', prompt: 'p', deps: ['limiter', 'config'] },
        { id: 'tests', title: 'Tests for the limiter', prompt: 'p', deps: ['middleware'] },
        { id: 'docs', title: 'Document the 429 response', prompt: 'p' },
      ],
    },
    (o) => (taskOf(o) === 'limiter' ? { files: { 'limiter.txt': 'bad value\n' }, tokens: { input: 21_000, cached: 80_000, output: 9_000 } } : ok(o)),
  );
  ids.tokens = await run(
    {
      goal: 'Move the notes table to the new schema',
      maxAttempts: 3,
      tasks: [
        { id: 'schema', title: 'New notes schema', prompt: 'p' },
        { id: 'migrate', title: 'Backfill the old rows', prompt: 'p', deps: ['schema'] },
        { id: 'verify-data', title: 'Check the migrated data', prompt: 'p', deps: ['migrate'] },
        { id: 'docs', title: 'Update the data docs', prompt: 'p' },
      ],
    },
    // The backfill keeps failing its checks and every attempt is expensive, so it runs into its own allowance.
    (o) => (taskOf(o) === 'migrate' ? { files: { 'migrate.txt': 'bad rows\n' }, tokens: { input: 1_400_000, cached: 6_000_000, output: 200_000 } } : ok(o)),
  );
  ids.usage = await run(
    {
      goal: 'Add pagination to the notes list',
      tasks: [
        { id: 'cursor', title: 'Cursor-based pagination', prompt: 'p' },
        { id: 'api', title: 'Expose ?cursor and ?limit', prompt: 'p', deps: ['cursor'] },
        { id: 'client', title: 'Update the typed client', prompt: 'p', deps: ['api'] },
        { id: 'docs', title: 'Document pagination', prompt: 'p' },
      ],
    },
    (o) => (taskOf(o) === 'api' ? { ok: false, text: "You've hit your session limit · resets 3:20pm" } : ok(o)),
  );
  return { repo, ids };
}

// ---------- the shots ----------

const DASH = { width: 1440, height: 900 };
const exists = (page, sel) => page.eval(`!!document.querySelector(${JSON.stringify(sel)})`);

async function dashboardShots() {
  console.log('dashboard: a live demo run');
  const demo = startBraid(['demo', '--port', '4810']);
  const [, base, runId] = await demo.until(/watch:\s+(http:\/\/127\.0\.0\.1:\d+\/)#run=(\S+)/);
  const page = await openPage(DASH);
  await page.goto(`${base}#run=${runId}`);

  // Mid-run: one strand already merged and several agents at work.
  const snap = async () => {
    const { state } = await api(base, `api/run/${runId}`);
    return state ? Object.values(state.tasks) : [];
  };
  const mid = await waitFor(async () => {
    const t = await snap();
    const working = t.filter((x) => ['running', 'verifying', 'reviewing', 'resolving'].includes(x.status));
    return t.some((x) => x.status === 'done') && working.length >= 2 ? working : null;
  }, 'agents at work');
  await sleep(1200);
  if (wanted('dashboard-running')) await page.shot('dashboard-running');

  if (wanted('dashboard-inspector')) {
    await page.eval(`document.getElementById('desk-${mid[0].id}').click()`);
    await sleep(900);
    await page.shot('dashboard-inspector');
    await page.eval(`document.getElementById('insClose').click()`);
    await sleep(300);
  }

  await waitFor(async () => (await api(base, `api/run/${runId}`)).state?.status === 'done', 'the demo run to finish');
  await sleep(2500);
  if (wanted('dashboard-done')) await page.shot('dashboard-done');
  if (wanted('dashboard-branches')) {
    await page.eval(`document.getElementById('tabGit').click()`);
    await sleep(1200);
    await page.shot('dashboard-branches');
    await page.eval(`document.getElementById('tabBeads').click()`);
  }
  if (wanted('dashboard-history')) {
    await page.eval(`document.getElementById('historyBtn').click()`);
    await sleep(1500);
    await page.shot('dashboard-history');
  }
  await page.close();
  demo.proc.kill('SIGKILL');
}

async function stopReasonShots() {
  if (!['stop-tangled', 'stop-tokens', 'stop-usage'].some(wanted)) return;
  console.log('dashboard: runs that stopped');
  const { repo, ids } = await stoppedRuns();
  const watch = startBraid(['watch', '--port', '4811'], { cwd: repo });
  const [, base] = await watch.until(/braid watch:\s+(http:\/\/127\.0\.0\.1:\d+\/)/);
  const page = await openPage(DASH);
  let loaded = false;
  for (const [name, id] of [['stop-tangled', ids.tangled], ['stop-tokens', ids.tokens], ['stop-usage', ids.usage]]) {
    if (!wanted(name)) continue;
    // Only the fragment differs between runs, so after the first load the page switches runs itself.
    if (!loaded) await page.goto(`${base}#run=${id}`);
    else await page.eval(`location.hash = '#run=${id}'`);
    loaded = true;
    await waitFor(() => page.eval(`document.getElementById('layout')?.dataset.run === ${JSON.stringify(id)} && !!document.getElementById('desk-docs')`), 'the floor');
    await sleep(1500);
    await page.shot(name, { x: 0, y: 0, width: DASH.width, height: 640 });
  }
  await page.close();
  watch.proc.kill('SIGKILL');
}

async function guidedStartShot() {
  if (!wanted('guided-start')) return;
  console.log('dashboard: guided start');
  const { exec } = await import(pathToFileURL(join(ROOT, 'dist/src/proc.js')));
  const dir = join(scratch, 'my-api');
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-api', scripts: { test: 'node --test' } }));
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await exec('git', ['-c', 'user.name=braid', '-c', 'user.email=braid@localhost', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  const watch = startBraid(['watch', '--control', '--port', '4812'], { cwd: dir, env: { BRAID_CONTROL_TOKEN: 'screenshots' } });
  await watch.until(/braid watch:/);
  const page = await openPage({ width: 1100, height: 900 });
  await page.goto('http://127.0.0.1:4812/#token=screenshots');
  await waitFor(() => exists(page, '[data-f="goal"]'), 'the composer');
  await page.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('[data-f="goal"]', 'Add rate limiting to the API and cover it with tests');
    set('[data-f="verify"]', 'npm test');
  })()`);
  await sleep(1500);
  await page.shot('guided-start');
  await page.close();
  watch.proc.kill('SIGKILL');
}

const TAURI_DATA = {
  recent_repos: ['/Users/alex/code/billing-api', '/Users/alex/code/notes-service', '/Users/alex/work/web-frontend'],
  settings_get: { default_agent: 'claude', models: { claude: 'sonnet', nim: 'nvidia/nemotron-3-super-120b-a12b' }, key_set: { nim: true }, disabled: [] },
  settings_agents: [{ name: 'claude', ok: true, version: '2.1.283' }, { name: 'codex', ok: true, version: 'codex-cli 0.147.0' }, { name: 'gemini', ok: false }],
};
// A provider with a saved key shows the provider's own live list; the others show what the installed CLI knows.
const TAURI_STUB = `(() => {
  const data = ${JSON.stringify(TAURI_DATA)};
  const models = (provider) => provider === 'nim'
    ? { source: 'live', models: ['nvidia/nemotron-3-super-120b-a12b', 'nvidia/llama-3.1-nemotron-ultra-253b-v1', 'mistralai/mistral-large-2-instruct'], at: Date.now() }
    : { source: 'cli', models: ['opus', 'sonnet', 'haiku'], at: Date.now() };
  window.__TAURI__ = { core: { invoke: async (cmd, args) => (cmd === 'settings_models' ? models(args.provider) : data[cmd]) } };
})();`;

async function desktopShots() {
  if (!wanted('desktop-launcher') && !wanted('desktop-settings')) return;
  console.log('desktop app pages (sample data)');
  if (wanted('desktop-launcher')) {
    const page = await openPage({ width: 520, height: 620, scale: 2, stub: TAURI_STUB });
    await page.goto(pathToFileURL(join(ROOT, 'desktop', 'ui', 'index.html')).href);
    await waitFor(() => exists(page, '#recent .repo'), 'the recent repositories');
    await sleep(500);
    await page.shot('desktop-launcher');
    await page.close();
  }
  if (wanted('desktop-settings')) {
    const page = await openPage({ width: 680, height: 1560, scale: 1.5, stub: TAURI_STUB });
    await page.goto(pathToFileURL(join(ROOT, 'desktop', 'ui', 'settings.html')).href);
    await waitFor(() => exists(page, '.card'), 'the agent cards');
    await sleep(1500);
    await page.shot('desktop-settings');
    await page.close();
  }
}

try {
  await launchChrome();
  await dashboardShots();
  await stopReasonShots();
  await guidedStartShot();
  await desktopShots();
  console.log('done');
} finally {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
}
process.exit(0);
