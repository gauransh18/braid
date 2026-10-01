import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { Git } from '../src/git.js';
import { exec } from '../src/proc.js';

// The desktop app runs `braid watch` as a sidecar and cannot signal it politely, so it talks over stdin when
// BRAID_EXIT_ON_STDIN_CLOSE=1. These start the real command line (dist/src/cli.js), start a run whose check never
// finishes through the control API, and then say "quit" or close stdin. Pipes work everywhere, but the check
// processes are asserted gone with POSIX tools.
const skip = process.platform === 'win32' && 'POSIX process checks';
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const TOKEN = 'sidecar-test-token';

const temps: string[] = [];
const spawned: ChildProcess[] = [];
after(() => {
  for (const c of spawned) if (c.exitCode === null) c.kill('SIGKILL');
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
};

async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function post(url: string, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * `braid watch --control` in a repo, told to listen on stdin, with a run in flight: its check (`hang.js`, which
 * ignores SIGTERM when `stubborn`) has started.
 */
async function sidecarWithRun(o: { stubborn?: boolean; stdinMode?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'braid-sidecar-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'hang.js'), `require('node:fs').appendFileSync(process.env.HANGPID, process.pid + '\\n');${o.stubborn ? " process.on('SIGTERM', () => {});" : ''} setTimeout(() => {}, 60000);\n`);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  const repo = await Git.toplevel(dir);
  const pidFile = join(dir, 'hang.pid');
  const env: NodeJS.ProcessEnv = { ...process.env, HANGPID: pidFile, BRAID_CONTROL_TOKEN: TOKEN };
  delete env.BRAID_EXIT_ON_STDIN_CLOSE;
  if (o.stdinMode !== false) env.BRAID_EXIT_ON_STDIN_CLOSE = '1';
  const child = spawn(process.execPath, [CLI, 'watch', '--control', '--port', '0'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
  spawned.push(child);
  let output = '';
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  child.stdin!.on('error', () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  await until(() => /braid watch: http:\/\/127\.0\.0\.1:\d+/.test(output), 'the server to listen');
  const url = /braid watch: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)![1]!;
  const plan = { goal: 'g', driver: 'mock', verify: ['node hang.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
  assert.equal(await post(url, '/api/runs', { plan }), 202);
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0, 'the check to start');
  const checkPid = Number(readFileSync(pidFile, 'utf8').trim().split('\n')[0]);
  const runState = () => {
    const runs = join(repo, '.braid', 'runs');
    const id = readdirSync(runs)[0]!;
    return JSON.parse(readFileSync(join(runs, id, 'state.json'), 'utf8')) as { status: string };
  };
  return { child, exited, checkPid, output: () => output, runState };
}

type Sidecar = Awaited<ReturnType<typeof sidecarWithRun>>;

/** The run ended aborted (state saved, so it can be resumed), its check is gone, and the process left on its own. */
async function stoppedGracefully(s: Sidecar, started: number): Promise<void> {
  const { code } = await s.exited;
  assert.equal(code, 0, `exit code of a graceful stop; output:\n${s.output()}`);
  assert.ok(Date.now() - started < 12_000, 'did not wait for the 60 s check');
  assert.equal(s.runState().status, 'aborted');
  await until(() => !alive(s.checkPid), 'the check process to be gone', 5000);
}

describe('braid watch as a desktop sidecar', { skip }, () => {
  it('stops the run in flight and exits when told "quit" on stdin', async () => {
    const s = await sidecarWithRun();
    const started = Date.now();
    s.child.stdin!.write('quit\n');
    await stoppedGracefully(s, started);
  });

  it('does the same when stdin is closed, which is what a dead or killed app looks like', async () => {
    const s = await sidecarWithRun();
    const started = Date.now();
    s.child.stdin!.end();
    await stoppedGracefully(s, started);
  });

  it('ignores other lines, and stops on "quit" after them', async () => {
    const s = await sidecarWithRun();
    s.child.stdin!.write('hello\n\nQUIT\n');
    await sleep(400);
    assert.equal(s.child.exitCode, null, 'only a line that says quit stops it');
    assert.equal(s.runState().status, 'running');
    const started = Date.now();
    s.child.stdin!.write('  quit  \r\n');
    await stoppedGracefully(s, started);
  });

  it('does not turn the closing of stdin after "quit" into a force quit', async () => {
    // The check ignores SIGTERM, so the stop takes until it is killed (about 5 s). A second request after that first
    // second would be taken for a second Ctrl-C, which kills everything at once and leaves the run unsaved.
    const s = await sidecarWithRun({ stubborn: true });
    const started = Date.now();
    s.child.stdin!.write('quit\n');
    await sleep(1500);
    assert.ok(alive(s.checkPid), 'the graceful stop is still waiting for the check');
    s.child.stdin!.end();
    const { code } = await s.exited;
    assert.equal(code, 0, `a graceful stop, not a force quit (130); output:\n${s.output()}`);
    assert.ok(Date.now() - started > 3000, 'it did wait for the check to be stopped');
    assert.equal(s.runState().status, 'aborted');
    await until(() => !alive(s.checkPid), 'the check process to be gone', 5000);
  });

  it('leaves stdin alone unless the app asked for it', async () => {
    const s = await sidecarWithRun({ stdinMode: false });
    s.child.stdin!.write('quit\n');
    s.child.stdin!.end();
    await sleep(1000);
    assert.equal(s.child.exitCode, null, 'a terminal user typing "quit" or pressing Ctrl-D does not end the server');
    assert.ok(alive(s.checkPid));
    const started = Date.now();
    s.child.kill('SIGINT');
    const { code } = await s.exited;
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 12_000);
    await until(() => !alive(s.checkPid), 'the check process to be gone', 5000);
  });
});
