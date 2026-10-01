import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { Git } from '../src/git.js';
import { exec } from '../src/proc.js';

// These start the real command line (dist/src/cli.js) on a mock-driver plan whose check never finishes, and send it
// the signals a terminal sends. Windows has no such signals.
const skip = process.platform === 'win32' && 'POSIX signals';
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const temps: string[] = [];
after(() => {
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

async function setup(stubborn = false) {
  const dir = mkdtempSync(join(tmpdir(), 'braid-cli-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'hang.js'), `require('node:fs').appendFileSync(process.env.HANGPID, process.pid + '\\n');${stubborn ? " process.on('SIGTERM', () => {});" : ''} setTimeout(() => {}, 60000);\n`);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ goal: 'g', driver: 'mock', verify: ['node hang.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }));
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  const repo = await Git.toplevel(dir);
  const pidFile = join(dir, 'hang.pid');
  const child = spawn(process.execPath, [CLI, 'run', 'plan.json'], { cwd: repo, env: { ...process.env, HANGPID: pidFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0, 'the check to start');
  const checkPid = Number(readFileSync(pidFile, 'utf8').trim().split('\n')[0]);
  const runState = () => {
    const runs = join(repo, '.braid', 'runs');
    const id = readdirSync(runs)[0]!;
    return JSON.parse(readFileSync(join(runs, id, 'state.json'), 'utf8')) as { status: string };
  };
  return { child, exited, checkPid, output: () => output, runState };
}

const stoppedGracefully = async (r: Awaited<ReturnType<typeof setup>>, started: number) => {
  const { code } = await r.exited;
  assert.equal(code, 2, `exit code of an aborted run; output:\n${r.output()}`);
  assert.ok(Date.now() - started < 12_000, 'did not wait for the 60 s check');
  assert.equal(r.runState().status, 'aborted');
  await until(() => !alive(r.checkPid), 'the check process to be gone', 5000);
};

describe('braid run and the signals a terminal sends', { skip }, () => {
  it('stops gracefully on one Ctrl-C: agents and checks gone, state saved as aborted', async () => {
    const r = await setup();
    const started = Date.now();
    r.child.kill('SIGINT');
    await stoppedGracefully(r, started);
  });

  it('treats the same Ctrl-C delivered twice at once (npm does that) as one', async () => {
    const r = await setup();
    const started = Date.now();
    r.child.kill('SIGINT');
    await sleep(20);
    r.child.kill('SIGINT');
    await stoppedGracefully(r, started);
  });

  it('force-quits on a second Ctrl-C, even when the check ignores SIGTERM', async () => {
    const r = await setup(true);
    r.child.kill('SIGINT');
    await sleep(1500);
    assert.ok(alive(r.checkPid), 'the check ignores SIGTERM, so the graceful stop is still waiting for it');
    const second = Date.now();
    r.child.kill('SIGINT');
    const { code } = await r.exited;
    assert.equal(code, 130);
    assert.ok(Date.now() - second < 3000, 'quit at once');
    await until(() => !alive(r.checkPid), 'the check process to be killed', 5000);
  });

  it('stops everything when the terminal goes away (SIGHUP)', async () => {
    const r = await setup();
    r.child.kill('SIGHUP');
    const { code } = await r.exited;
    assert.ok(code === 2 || code === 129, `exit code ${code}`);
    await until(() => !alive(r.checkPid), 'the check process to be gone', 5000);
  });

  it('still stops cleanly when nobody is reading its output any more (braid run | head)', async () => {
    const r = await setup();
    r.child.stdout!.destroy();
    r.child.stderr!.destroy();
    await sleep(200);
    const started = Date.now();
    r.child.kill('SIGINT');
    const { code } = await r.exited;
    assert.equal(code, 2, 'an aborted run, not a crash on EPIPE');
    assert.ok(Date.now() - started < 12_000);
    assert.equal(r.runState().status, 'aborted');
    await until(() => !alive(r.checkPid), 'the check process to be gone', 5000);
  });
});
