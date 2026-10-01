import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { ClaudeDriver } from '../src/drivers/claude.js';
import { DriverRegistry, type Driver, type DriverRunOptions } from '../src/drivers/driver.js';
import { Git } from '../src/git.js';
import { exec } from '../src/proc.js';
import type { AgentResult } from '../src/types.js';
import { startWatch, type WatchServer } from '../src/watch.js';

const TOKEN = 'test-token-draft';
const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-draft-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A killed process stays a zombie until its parent reaps it, and inside a container nothing may.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
};

/** POST /api/plan-draft, handing back the request so the test can hang up on it. */
function postDraft(server: WatchServer, body: unknown, driver?: string): { req: ClientRequest; response: Promise<{ status: number; json: any }> } {
  const data = JSON.stringify({ goal: 'add a thing', ...(driver ? { driver } : {}), ...(body as object) });
  let req!: ClientRequest;
  const response = new Promise<{ status: number; json: any }>((resolve, reject) => {
    req = request(
      server.url.replace(/\/$/, '') + '/api/plan-draft',
      { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text || 'null') }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
  response.catch(() => undefined); // a request the test hangs up on rejects; that is not an unhandled rejection
  return { req, response };
}

const PLAN_JSON = JSON.stringify({ tasks: [{ id: 'a', title: 'A', prompt: 'do a' }] });

describe('POST /api/plan-draft when the page goes away', () => {
  let repo: string;
  let server: WatchServer;
  /** What the stand-in planner saw. */
  const seen = { started: 0, aborted: 0, finished: 0 };
  let holdMs = 15_000;

  // A planner that waits (as a real agent does) and notices when it is told to stop.
  const planner: Driver = {
    name: 'mock',
    async run(o: DriverRunOptions): Promise<AgentResult> {
      seen.started++;
      const stopped = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), holdMs);
        o.signal?.addEventListener('abort', () => (clearTimeout(timer), resolve(true)), { once: true });
      });
      if (stopped) {
        seen.aborted++;
        return { ok: false, text: 'aborted', costUsd: 0 };
      }
      seen.finished++;
      return { ok: true, text: PLAN_JSON, costUsd: 0 };
    },
  };

  before(async () => {
    repo = await makeRepo();
    server = await startWatch(repo, 0, { token: TOKEN, drivers: () => new DriverRegistry().register(planner) });
  });
  after(() => server.close());

  const reset = (ms: number) => {
    seen.started = seen.aborted = seen.finished = 0;
    holdMs = ms;
  };

  it('stops the planner when the client disconnects before the answer', async () => {
    reset(15_000);
    const { req } = postDraft(server, {});
    await until(() => seen.started === 1, 'the planner to start');
    assert.equal(seen.aborted, 0, 'still running while someone waits');
    req.destroy();
    await until(() => seen.aborted === 1, 'the planner to be told to stop', 5000);
    assert.equal(seen.finished, 0);
    // The server is none the worse for it.
    const next = postDraft(server, {});
    await until(() => seen.started === 2, 'the next draft to start');
    next.req.destroy();
    await until(() => seen.aborted === 2, 'and to stop');
  });

  it('lets the planner finish when the client stays', async () => {
    reset(400);
    const { response } = postDraft(server, {});
    const res = await response;
    assert.equal(res.status, 200);
    assert.equal(res.json.plan.tasks[0].id, 'a');
    await sleep(200);
    assert.deepEqual(seen, { started: 1, aborted: 0, finished: 1 });
  });

  it('answers a draft that was refused before the planner started as before', async () => {
    reset(400);
    const res = await postDraft(server, { goal: '   ' }).response;
    assert.equal(res.status, 400);
    assert.equal(seen.started, 0);
  });
});

describe('POST /api/plan-draft with a real agent process', { skip: process.platform === 'win32' && 'stand-in agent is a shebang script' }, () => {
  it('kills the agent when the client disconnects', async () => {
    const repo = await makeRepo();
    const dir = mkdtempSync(join(tmpdir(), 'braid-draft-bin-'));
    temps.push(dir);
    const pidFile = join(dir, 'pid');
    const bin = join(dir, 'claude');
    writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.resume();\nsetTimeout(() => {}, 60000);\n`);
    chmodSync(bin, 0o755);
    const server = await startWatch(repo, 0, { token: TOKEN, drivers: () => new DriverRegistry().register(new ClaudeDriver(bin)) });
    try {
      const { req } = postDraft(server, {}, 'claude');
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 'the agent to start');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(alive(pid));
      req.destroy();
      await until(() => !alive(pid), 'the agent to be stopped', 8000);
    } finally {
      await server.close();
    }
  });
});
