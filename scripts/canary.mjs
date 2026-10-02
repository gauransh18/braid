// Canary against the real agents: does braid still understand what each agent CLI prints?
//   node scripts/canary.mjs [--drivers claude,codex] [--require-keys] [--strict] [--bin path] [--dir path] [--keep] [--timeout MIN]
//   node scripts/canary.mjs --fake                    stand-in agents, no network, nothing signed in (checks this script)
// For every usable driver it builds a tiny repository, runs a two-task plan through the compiled braid (dist/src/cli.js, else
// the binary in dist/bin) and asserts that the run is done, both tasks merged, both files are on the integration branch, and
// tokens and a summary were reported. Those last two are what silently stop working when an agent CLI renames a field in its
// output. Usable: claude, codex and gemini when the CLI is on PATH; nim when NVIDIA_API_KEY is set. --require-keys also wants a
// CLI's API key in the environment (CI installs every CLI but only some secrets exist). An unusable driver is skipped with a
// message, or fails with --strict; with --require-keys, so does a run in which no driver could be run at all. Exit status:
// 1 if any driver failed, else 0.
//
// Real runs cost a few cents each. CANARY_MODEL_<DRIVER> (e.g. CANARY_MODEL_CLAUDE=haiku) picks a cheaper model.
// --fake only: CANARY_FAKE_DRIFT=claude:usage,gemini:result makes that stand-in change its output the way a CLI update
// could (usage: no token counts; result: no final answer), so the canary can be seen to fail.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { arch, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = fileURLToPath(import.meta.url);
const root = resolve(here, '..', '..');
const win = platform() === 'win32';

// What the agent is asked to do, in a form a stand-in can read too.
const TASKS = [
  { id: 'alpha', file: 'alpha.txt', word: 'alpha' },
  { id: 'beta', file: 'beta.txt', word: 'beta' },
];
const askFor = (t) => `Create a file named ${t.file} in the repository root. Its entire content must be the single word: ${t.word}. Do nothing else.`;
const WANTED = /Create a file named (\S+) in the repository root\. Its entire content must be the single word: (\S+?)\./;

const CHECK_JS = `const fs = require('fs');
const [file, word] = process.argv.slice(2);
if (!fs.existsSync(file)) { console.error(file + ' does not exist'); process.exit(1); }
if (!fs.readFileSync(file, 'utf8').toLowerCase().includes(word)) { console.error(file + ' does not contain "' + word + '"'); process.exit(1); }
`;

const DRIVERS = [
  { name: 'claude', cli: true, keys: ['ANTHROPIC_API_KEY'], install: 'npm install -g @anthropic-ai/claude-code' },
  { name: 'codex', cli: true, keys: ['OPENAI_API_KEY', 'CODEX_API_KEY'], install: 'npm install -g @openai/codex' },
  { name: 'gemini', cli: true, keys: ['GEMINI_API_KEY'], install: 'npm install -g @google/gemini-cli' },
  { name: 'nim', keys: ['NVIDIA_API_KEY'] },
];

// ---------------------------------------------------------------- the canary

async function main() {
  const { values } = parseArgs({
    options: { fake: { type: 'boolean' }, drivers: { type: 'string' }, strict: { type: 'boolean' }, 'require-keys': { type: 'boolean' }, bin: { type: 'string' }, dir: { type: 'string' }, keep: { type: 'boolean' }, timeout: { type: 'string' } },
  });
  const wanted = values.drivers ? values.drivers.split(',').map((s) => s.trim()).filter(Boolean) : DRIVERS.map((d) => d.name);
  const unknown = wanted.filter((n) => !DRIVERS.some((d) => d.name === n));
  if (unknown.length) throw new Error(`unknown driver ${unknown.join(', ')} (have: ${DRIVERS.map((d) => d.name).join(', ')})`);

  const braid = braidCommand(values.bin);
  const work = values.dir ? resolve(values.dir) : mkdtempSync(join(tmpdir(), 'braid-canary-'));
  mkdirSync(work, { recursive: true });
  let env = { ...process.env };
  let nim;
  if (values.fake) {
    const shims = join(work, 'shims');
    mkdirSync(shims, { recursive: true });
    nim = await fakeNimServer();
    env = { ...env, BRAID_CLAUDE_BIN: shim(shims, 'claude'), BRAID_CODEX_BIN: shim(shims, 'codex'), BRAID_GEMINI_BIN: shim(shims, 'gemini'), BRAID_NIM_BASE_URL: nim.url, NVIDIA_API_KEY: 'fake-key' };
  }
  const timeoutMs = Number(values.timeout ?? (values.fake ? 2 : 10)) * 60_000;

  const found = detectClis(braid, env, work);
  const results = [];
  for (const name of wanted) {
    const d = DRIVERS.find((x) => x.name === name);
    const needsKey = !d.cli || values['require-keys'];
    const skip = d.cli && !found.get(name) ? `the ${name} CLI is not on PATH (${d.install})` : needsKey && !d.keys.some((k) => env[k]) ? `${d.keys.join(' or ')} is not set` : '';
    if (skip) {
      results.push({ name, skipped: skip });
      console.log(`skip ${`${name}:`.padEnd(7)} ${skip}`);
      // Under GitHub Actions a skip shows up as an annotation, so a canary that tested nothing is not mistaken for a pass.
      if (process.env.GITHUB_ACTIONS) console.log(`::warning title=canary skipped ${name}::${skip}`);
      continue;
    }
    const model = process.env[`CANARY_MODEL_${name.toUpperCase()}`];
    const r = await canary(braid, d.name, model, { env, dir: join(work, name), timeoutMs });
    results.push(r);
    console.log(r.problems.length ? `FAIL ${name}` : `ok   ${name.padEnd(7)} ${r.summary}`);
    for (const p of r.problems) console.log(`       - ${p}`);
    if (r.problems.length && r.tail) console.log(`       braid output (end):\n${r.tail.split('\n').map((l) => `         ${l}`).join('\n')}`);
  }
  nim?.close();

  const failed = results.filter((r) => r.problems?.length);
  const skipped = results.filter((r) => r.skipped);
  const passed = results.length - failed.length - skipped.length;
  console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
  if (!passed && !failed.length) console.log('Nothing ran: no usable agent. Install an agent CLI and sign in, or set NVIDIA_API_KEY.');
  // With --require-keys the run is the scheduled check, whose whole point is to talk to real agents: all of them being
  // skipped (a secret lost or mistyped) is a canary that tested nothing, which must not look like a pass.
  const bad = failed.length > 0 || (values.strict && skipped.length > 0) || (values['require-keys'] && !passed);
  if (failed.length || values.keep || values.dir) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  return bad ? 1 : 0;
}

/** How to start braid: the compiled JavaScript, else the single-file executable built for this platform. */
function braidCommand(override) {
  if (override) return /\.[cm]?js$/.test(override) ? [process.execPath, resolve(override)] : [resolve(override)];
  const js = join(root, 'dist', 'src', 'cli.js');
  if (existsSync(js)) return [process.execPath, js];
  const exe = join(root, 'dist', 'bin', `braid-${win ? 'windows' : platform()}-${arch() === 'arm64' ? 'arm64' : 'x64'}${win ? '.exe' : ''}`);
  if (existsSync(exe)) return [exe];
  throw new Error('braid is not built: run `npm run build` (or `npm run build:binary`) first');
}

/** Which agent CLIs braid itself can find, by asking braid: the same lookup (npm .cmd shims, BRAID_*_BIN) as a real run. */
function detectClis(braid, env, cwd) {
  const r = spawnSync(braid[0], [...braid.slice(1), 'doctor', '--json'], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  let rows = [];
  try {
    rows = JSON.parse(r.stdout);
  } catch {
    throw new Error(`braid doctor did not answer with JSON: ${r.stdout}${r.stderr}${r.error ?? ''}`);
  }
  return new Map(rows.map((row) => [row.name, row.ok]));
}

/** One driver: a fresh repository, a two-task plan, a run, and the assertions. Never throws; problems are returned. */
async function canary(braid, driver, model, { env, dir, timeoutMs }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...a) => spawnSync('git', ['-c', 'user.name=canary', '-c', 'user.email=canary@localhost', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  writeFileSync(join(dir, 'README.md'), 'A fixture for the braid canary.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const plan = {
    goal: 'canary: create two small files',
    driver,
    ...(model ? { model } : {}),
    maxAttempts: 2,
    maxTurns: 20,
    timeoutMin: 5,
    tasks: TASKS.map((t) => ({ id: t.id, title: `Create ${t.file}`, prompt: askFor(t), verify: [`node check.js ${t.file} ${t.word}`] })),
  };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));

  const started = Date.now();
  const ran = await runBraid(braid, ['run', 'plan.json'], { cwd: dir, env, timeoutMs });
  const problems = [];
  if (ran.timedOut) problems.push(`still running after ${Math.round(timeoutMs / 60_000)} minutes; stopped`);
  else if (ran.error) problems.push(`could not start braid: ${ran.error}`);

  const runs = existsSync(join(dir, '.braid', 'runs')) ? readdirSync(join(dir, '.braid', 'runs')) : [];
  let state;
  try {
    state = JSON.parse(readFileSync(join(dir, '.braid', 'runs', runs.at(-1), 'state.json'), 'utf8'));
  } catch {
    problems.push('braid did not record a run');
  }
  if (state) {
    if (state.status !== 'done') problems.push(`the run ended "${state.status}", not "done" (exit code ${ran.code})`);
    for (const t of TASKS) {
      const s = state.tasks?.[t.id];
      if (s?.status !== 'done') {
        problems.push(`task ${t.id} ended "${s?.status}", not merged${s?.error ? `: ${s.error.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`);
        continue;
      }
      if (!total(s.tokens)) problems.push(`task ${t.id} reported no tokens (the agent's usage output was not understood)`);
      if (!s.summary?.trim()) problems.push(`task ${t.id} has no summary (the agent's final answer was not understood)`);
      const shown = git('show', `${state.integrationBranch}:${t.file}`);
      if (shown.status !== 0) problems.push(`${t.file} is not on ${state.integrationBranch}`);
      else if (!shown.stdout.toLowerCase().includes(t.word)) problems.push(`${t.file} on ${state.integrationBranch} does not contain "${t.word}"`);
    }
    if (!total(state.tokens)) problems.push('the run reported no tokens');
  }
  const tokens = total(state?.tokens);
  return {
    name: driver,
    problems,
    // What braid printed matters when the run itself went wrong; for a finished run the problems above say it all.
    tail: state?.status === 'done' ? '' : ran.out.trim().slice(-1500),
    summary: `${TASKS.length} tasks merged, ${tokens} tokens, ${Math.round((Date.now() - started) / 1000)}s`,
  };
}

const total = (t) => (t ? t.input + t.cached + t.output : 0);

function runBraid(braid, args, { cwd, env, timeoutMs }) {
  return new Promise((done) => {
    const child = spawn(braid[0], [...braid.slice(1), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // braid winds down on SIGTERM (agents stopped, state saved); a run that ignores it is killed.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
    }, timeoutMs);
    child.once('error', (e) => (clearTimeout(timer), done({ code: null, out, timedOut, error: e.message })));
    child.once('close', (code) => (clearTimeout(timer), done({ code, out, timedOut })));
  });
}

// ---------------------------------------------------------------- stand-in agents (--fake)

/** An executable named like the agent CLI that runs this file in stand-in mode. */
function shim(dir, kind) {
  const file = join(dir, win ? `${kind}.cmd` : kind);
  if (win) writeFileSync(file, `@echo off\r\n"${process.execPath}" "${here}" __fake-agent ${kind} %*\r\n`);
  else {
    const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    writeFileSync(file, `#!/bin/sh\nexec ${sq(process.execPath)} ${sq(here)} __fake-agent ${kind} "$@"\n`);
    chmodSync(file, 0o755);
  }
  return file;
}

const drifts = (kind, what) => (process.env.CANARY_FAKE_DRIFT ?? '').split(',').includes(`${kind}:${what}`);

/** Does what the prompt asks (in the current directory) and prints what the real CLI prints, in the schema braid reads. */
async function fakeAgent(kind, argv) {
  if (argv.includes('--version')) {
    console.log(`${kind} 0.0.0 (canary stand-in)`);
    return;
  }
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const m = WANTED.exec(prompt);
  if (!m) {
    console.error('stand-in agent: the prompt does not ask for a file');
    process.exitCode = 3;
    return;
  }
  const [, file, word] = m;
  writeFileSync(file, `${word}\n`);
  const say = (o) => console.log(JSON.stringify(o));
  const answer = `Created ${file}.`;
  if (kind === 'claude') {
    const usage = { input_tokens: 12, cache_creation_input_tokens: 400, cache_read_input_tokens: 900, output_tokens: 30 };
    say({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model' });
    say({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'Write', input: { file_path: file, content: `${word}\n` } }], usage } });
    say({ type: 'user', message: { content: [{ type: 'tool_result', content: `File created successfully at: ${file}` }] } });
    say({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: answer }], usage } });
    say({ type: drifts(kind, 'result') ? 'final' : 'result', subtype: 'success', is_error: false, result: answer, total_cost_usd: 0.0012, num_turns: 2, session_id: 'fake-session', [drifts(kind, 'usage') ? 'token_usage' : 'usage']: usage });
  } else if (kind === 'codex') {
    say({ type: 'thread.started', thread_id: 'fake-thread' });
    say({ type: 'turn.started' });
    say({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: `echo ${word} > ${file}`, status: 'in_progress' } });
    say({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: `echo ${word} > ${file}`, exit_code: 0, status: 'completed' } });
    say({ type: 'item.completed', item: { id: 'item_2', type: drifts(kind, 'result') ? 'message' : 'agent_message', text: answer } });
    say({ type: 'turn.completed', [drifts(kind, 'usage') ? 'token_usage' : 'usage']: { input_tokens: 1300, cached_input_tokens: 900, output_tokens: 40 } });
  } else if (kind === 'gemini') {
    say({ type: 'init', session_id: 'fake-session', model: 'fake-model' });
    say({ type: 'tool_use', tool_name: 'write_file', tool_id: 't1', parameters: { file_path: file, content: `${word}\n` } });
    say({ type: 'tool_result', tool_id: 't1', status: 'success', output: '' });
    say({ type: 'message', role: 'assistant', content: answer, delta: true });
    const stats = { total_tokens: 1340, input_tokens: 1300, output_tokens: 40, cached: 900, models: { 'fake-model': { total_tokens: 1340, input_tokens: 1300, output_tokens: 40, cached: 900 } } };
    say({ type: drifts(kind, 'result') ? 'final' : 'result', status: 'success', [drifts(kind, 'usage') ? 'statistics' : 'stats']: stats });
  } else {
    console.error(`stand-in agent: unknown kind ${kind}`);
    process.exitCode = 3;
  }
}

/** A stand-in for the hosted OpenAI-compatible API behind the nim driver: one write_file call, then an answer. */
function fakeNimServer() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const messages = JSON.parse(body).messages ?? [];
      const m = WANTED.exec(messages.find((x) => x.role === 'user')?.content ?? '');
      const usage = drifts('nim', 'usage') ? undefined : { prompt_tokens: 500, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0 } };
      const message = messages.some((x) => x.role === 'tool')
        ? { role: 'assistant', content: m ? `Created ${m[1]}.` : 'done' }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: m?.[1], content: `${m?.[2]}\n` }) } }] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(drifts('nim', 'result') ? { id: 'x', object: 'chat.completion', usage } : { id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }], usage }));
    });
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready({ url: `http://127.0.0.1:${server.address().port}/v1`, close: () => (server.close(), server.closeAllConnections()) })));
}

// ---------------------------------------------------------------- entry (last, so every const above is initialised)

if (process.argv[2] === '__fake-agent') await fakeAgent(process.argv[3], process.argv.slice(4));
else {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(`canary: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
