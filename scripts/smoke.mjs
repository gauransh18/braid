// End-to-end check of a compiled braid executable on the machine it was built for.
//   node scripts/smoke.mjs [path-to-braid]      (no argument: the binary built for this platform in dist/bin)
// It needs only git and node. A stand-in "claude" is installed the way npm installs real agent CLIs on each
// platform (claude.cmd on Windows), so the launch path that real users depend on is the one exercised.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const win = platform() === 'win32';
const os = win ? 'windows' : platform();
const bin = resolve(process.argv[2] ?? join('dist', 'bin', `braid-${os}-${arch() === 'arm64' ? 'arm64' : 'x64'}${win ? '.exe' : ''}`));
if (!existsSync(bin)) throw new Error(`no such executable: ${bin}`);

const tmp = mkdtempSync(join(tmpdir(), 'braid-smoke-'));
const shims = join(tmp, 'shims');
const repo = join(tmp, 'repo');
mkdirSync(shims);
mkdirSync(repo);
let failures = 0;
const log = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `\n       ${String(detail).split('\n').join('\n       ')}` : ''}`);
};
const check = (cond, what, detail) => log(!!cond, what, cond ? '' : detail);

// --- a stand-in agent: answers --version, otherwise does one task and reports what it was started with
writeFileSync(
  join(shims, 'fake-claude.js'),
  `const fs = require('fs');
if (process.argv.includes('--version')) { console.log('9.9.9 (Fake Claude)'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  fs.writeFileSync('smoke.txt', 'written by the stand-in agent\\n');
  fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done ' + input.length, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } }));
});
`,
);
if (win) writeFileSync(join(shims, 'claude.cmd'), '@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n');
else {
  writeFileSync(join(shims, 'claude'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.js" "$@"\n');
  chmodSync(join(shims, 'claude'), 0o755);
}
const env = { ...process.env, PATH: shims + delimiter + process.env.PATH, BRAID_SMOKE: '1' };

const run = (args, opts = {}) => spawnSync(bin, args, { cwd: repo, env, encoding: 'utf8', timeout: 120_000, ...opts });
const git = (...a) => spawnSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@localhost', ...a], { cwd: repo, encoding: 'utf8' });

git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), 'hello\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');

// 1. it starts
let r = run(['--help']);
check(r.status === 0 && /braid/.test(r.stdout), 'starts and prints help', r.stderr || r.error);

// 2. it finds an agent that is installed as a .cmd shim (Windows) or a script (elsewhere)
r = run(['doctor', '--json']);
let rows = [];
try {
  rows = JSON.parse(r.stdout);
} catch {
  /* reported below */
}
const claude = rows.find((t) => t.name === 'claude');
check(rows.find((t) => t.name === 'git')?.ok, 'doctor finds git', r.stdout + r.stderr);
check(claude?.ok && /9\.9\.9/.test(claude.version ?? ''), 'doctor finds the agent installed as a shim and reads its version', JSON.stringify(claude) + r.stderr);

// 3. it can run a plan with that agent: worktree, agent, verify, merge
const plan = {
  goal: 'smoke test',
  driver: 'claude',
  allowedTools: ['Read', 'Edit', 'Bash(npm test)'],
  verify: ['node -e "process.exit(require(\'fs\').existsSync(\'smoke.txt\') ? 0 : 1)"'],
  maxAttempts: 1,
  tasks: [{ id: 'a', title: 'Write a file', prompt: 'write smoke.txt' }],
};
writeFileSync(join(repo, 'plan.json'), JSON.stringify(plan));
r = run(['run', 'plan.json']);
check(r.status === 0 && /run done/.test(r.stdout), 'runs a plan end to end with the shimmed agent', `exit ${r.status}\n${r.stdout.slice(-600)}\n${r.stderr.slice(-600)}`);

const branches = git('branch', '--list', 'braid/*/integration').stdout.trim().replace(/^[*+ ]+/, '');
check(branches, 'leaves the work on a braid/<run>/integration branch', git('branch', '-a').stdout);
if (branches) {
  const file = git('show', `${branches}:smoke.txt`);
  check(file.status === 0 && /stand-in agent/.test(file.stdout), 'the agent\'s file was verified and merged', file.stderr);
  const argv = git('show', `${branches}:argv.json`);
  let args = [];
  try {
    args = JSON.parse(argv.stdout);
  } catch {
    /* reported below */
  }
  check(args.includes('Read,Edit,Bash(npm test)'), 'passes a tool list with spaces and parentheses to the agent as one argument', JSON.stringify(args));
}

// 4. its other commands do not choke
r = run(['status']);
check(r.status === 0 && /done/.test(r.stdout), 'status reads the run back', r.stdout + r.stderr);
r = run(['models', 'claude', '--json']);
let models;
try {
  models = JSON.parse(r.stdout);
} catch {
  /* reported below */
}
check(models && ['cli', 'none', 'live'].includes(models.source), 'models command answers', r.stdout + r.stderr);

// 5. the dashboard: embedded page, API, and a demo run
const port = 4841 + Math.floor(Math.random() * 100);
const demo = spawn(bin, ['demo', '--port', String(port)], { env, cwd: tmp, stdio: 'ignore' });
let page = '';
let runs = '';
for (let i = 0; i < 60 && !page; i++) {
  await new Promise((s) => setTimeout(s, 500));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    if (res.ok) {
      page = await res.text();
      runs = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).text();
    }
  } catch {
    /* not up yet */
  }
}
check(/<title>/.test(page) && page.length > 20_000, 'the dashboard page is served from inside the executable', `${page.length} bytes`);
check(/runId/.test(runs), 'the demo run shows up in the API', runs.slice(0, 200));
// Windows will not delete a folder a process still has open, so wait for the demo to exit, then clean up best-effort.
await new Promise((done) => {
  demo.once('exit', done);
  demo.kill();
  setTimeout(done, 5000);
});
try {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch {
  /* a leftover temp folder is not a test failure */
}
console.log(failures ? `\n${failures} check(s) failed on ${os}` : `\nall checks passed on ${os}`);
process.exit(failures ? 1 : 0);
