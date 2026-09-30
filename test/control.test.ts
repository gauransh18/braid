import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DriverRegistry } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { exec } from '../src/proc.js';
import type { PlanSpec } from '../src/types.js';
import { startWatch, type WatchServer } from '../src/watch.js';

const TOKEN = 'test-token-123';
const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-ctl-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

interface Res {
  status: number;
  json: any;
}
function call(server: WatchServer, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      server.url.replace(/\/$/, '') + path,
      { method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
const authed = (server: WatchServer, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  call(server, method, path, body, { authorization: `Bearer ${TOKEN}`, ...extra });

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const plan = (extra: Partial<PlanSpec> = {}): PlanSpec => ({
  goal: 'g',
  driver: 'mock',
  budgetUsd: 5,
  tasks: [{ id: 'a', title: 'A', prompt: 'p' }],
  ...extra,
});

describe('control endpoints', () => {
  let repo: string;
  let script: (o: { canEdit: boolean; prompt: string }) => MockStep;
  let server: WatchServer;
  let readOnly: WatchServer;

  before(async () => {
    repo = await makeRepo();
    script = () => ({ files: { 'a.txt': 'a\n' } });
    // "claude" is registered too (as another mock) so plans can name it without spending anything.
    const registry = () =>
      new DriverRegistry()
        .register(new MockDriver((o) => script(o)))
        .register(Object.assign(new MockDriver((o) => script(o)), { name: 'claude' }));
    server = await startWatch(repo, 0, { token: TOKEN, drivers: registry });
    readOnly = await startWatch(repo, 0);
  });
  after(async () => {
    await server.close();
    await readOnly.close();
  });

  const finished = (id: string) => until(async () => {
    const r = await call(server, 'GET', `/api/run/${id}`);
    const status = r.json?.state?.status;
    return status && status !== 'running' ? r.json.state : undefined;
  });

  it('suggests a check command and reports which agent CLIs exist', async () => {
    const status = (await authed(server, 'GET', '/api/status')).json;
    assert.equal(status.active, null);
    assert.equal(typeof status.repoName, 'string');
    assert.equal(status.suggestedVerify, null, 'a bare repo has nothing to suggest');
    const tools = (await authed(server, 'GET', '/api/doctor')).json as { name: string; ok: boolean }[];
    assert.ok(tools.some((t) => t.name === 'git' && t.ok));
    assert.deepEqual(['claude', 'codex', 'gemini'].filter((n) => !tools.some((t) => t.name === n)), []);
    assert.equal((await call(server, 'GET', '/api/doctor')).status, 401);
  });

  it('reports whether controls exist, without needing a token', async () => {
    assert.deepEqual((await call(server, 'GET', '/api/config')).json, { control: true });
    assert.deepEqual((await call(readOnly, 'GET', '/api/config')).json, { control: false });
  });

  it('stays read-only when no token was configured', async () => {
    assert.equal((await call(readOnly, 'POST', '/api/runs', { plan: plan() }, { authorization: `Bearer ${TOKEN}` })).status, 405);
    assert.equal((await call(readOnly, 'GET', '/api/plans', undefined, { authorization: `Bearer ${TOKEN}` })).status, 405);
  });

  it('refuses requests without the token, from another origin, or without JSON', async () => {
    assert.equal((await call(server, 'POST', '/api/runs', { plan: plan() })).status, 401);
    assert.equal((await call(server, 'POST', '/api/runs', { plan: plan() }, { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await call(server, 'GET', '/api/plans')).status, 401);
    assert.equal((await authed(server, 'POST', '/api/runs', { plan: plan() }, { origin: 'http://evil.example' })).status, 403);
    // same-origin header is fine
    const host = new URL(server.url).host;
    assert.equal((await authed(server, 'GET', '/api/status', undefined, { origin: `http://${host}` })).status, 200);
    // wrong content type
    const bad = await new Promise<number>((resolve) => {
      const req = request(server.url + 'api/runs', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' } }, (r) => resolve(r.statusCode ?? 0));
      req.end('{}');
    });
    assert.equal(bad, 415);
  });

  it('demands a valid plan with a spend cap', async () => {
    assert.equal((await authed(server, 'POST', '/api/runs', { plan: plan({ budgetUsd: undefined }) })).status, 400);
    assert.match((await authed(server, 'POST', '/api/runs', { plan: plan({ budgetUsd: undefined }) })).json.error, /budgetUsd/);
    assert.equal((await authed(server, 'POST', '/api/runs', { plan: { goal: 'g', budgetUsd: 1, tasks: [] } })).status, 400);
    assert.equal((await authed(server, 'POST', '/api/runs', {})).status, 400);
  });

  it('starts a run that finishes, and lists it', async () => {
    const res = await authed(server, 'POST', '/api/runs', { plan: plan() });
    assert.equal(res.status, 202);
    const state = await finished(res.json.runId);
    assert.equal(state.status, 'done');
    assert.equal((await authed(server, 'GET', '/api/status')).json.active, null);
    const runs = (await call(server, 'GET', '/api/runs')).json as { runId: string }[];
    assert.ok(runs.some((r) => r.runId === res.json.runId));
  });

  it('allows one active run and can stop it', async () => {
    script = () => ({ files: { 'a.txt': 'a\n' }, delayMs: 3000 });
    const first = await authed(server, 'POST', '/api/runs', { plan: plan() });
    assert.equal(first.status, 202);
    assert.equal((await authed(server, 'GET', '/api/status')).json.active, first.json.runId);
    assert.equal((await authed(server, 'POST', '/api/runs', { plan: plan() })).status, 409);
    assert.equal((await authed(server, 'POST', `/api/run/${first.json.runId}/stop`, {})).status, 202);
    const state = await finished(first.json.runId);
    assert.equal(state.status, 'aborted');
    assert.equal((await authed(server, 'POST', `/api/run/${first.json.runId}/stop`, {})).status, 409, 'nothing left to stop');
  });

  it('resumes a failed run with a new budget', async () => {
    script = () => ({ files: { 'a.txt': 'bad\n' } });
    writeFileSync(join(repo, 'check.js'), "const fs=require('fs');process.exit(fs.existsSync('a.txt')&&fs.readFileSync('a.txt','utf8').includes('bad')?1:0);\n");
    await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: repo });
    await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'check'], { cwd: repo });
    const failing = plan({ verify: ['node check.js'], maxAttempts: 1 });
    const res = await authed(server, 'POST', '/api/runs', { plan: failing });
    assert.equal((await finished(res.json.runId)).status, 'failed');

    script = () => ({ files: { 'a.txt': 'good\n' } });
    const resumed = await authed(server, 'POST', `/api/run/${res.json.runId}/resume`, { budgetUsd: 3 });
    assert.equal(resumed.status, 202);
    assert.equal(resumed.json.runId, res.json.runId);
    const after = await finished(res.json.runId);
    assert.equal(after.status, 'done', JSON.stringify(after.tasks));
    assert.equal((await authed(server, 'POST', '/api/run/20200101-000000-zzzz/resume', {})).status, 404);
  });

  it('drafts a plan from a goal', async () => {
    script = () => ({ text: JSON.stringify({ goal: 'do it', tasks: [{ id: 'one', title: 'One', prompt: 'p' }] }) });
    const res = await authed(server, 'POST', '/api/plan-draft', { goal: 'do it', verify: ['npm test'], driver: 'mock' });
    assert.equal(res.status, 200);
    assert.equal(res.json.plan.tasks[0].id, 'one');
    assert.deepEqual(res.json.plan.verify, ['npm test']);
    assert.equal((await authed(server, 'POST', '/api/plan-draft', { goal: '  ' })).status, 400);
  });

  it('lists and reads plans in the repo plans/ folder, and nothing else', async () => {
    mkdirSync(join(repo, 'plans'), { recursive: true });
    writeFileSync(join(repo, 'plans', 'rate-limit.json'), JSON.stringify(plan()));
    writeFileSync(join(repo, 'plans', 'notes.txt'), 'x');
    assert.deepEqual((await authed(server, 'GET', '/api/plans')).json, ['rate-limit.json']);
    assert.equal((await authed(server, 'GET', '/api/plans/rate-limit.json')).json.goal, 'g');
    assert.equal((await authed(server, 'GET', '/api/plans/notes.txt')).status, 404);
    assert.equal((await authed(server, 'GET', '/api/plans/..%2Fpackage.json')).status, 404);
  });

  describe('settings from the desktop app', () => {
    const settings = (body: unknown) => authed(server, 'POST', '/api/settings', body);
    const storedPlan = (runId: string) => JSON.parse(readFileSync(join(repo, '.braid', 'runs', runId, 'plan.json'), 'utf8')) as PlanSpec;

    it('requires the token and refuses keys it does not manage', async () => {
      assert.equal((await call(server, 'POST', '/api/settings', { env: {} })).status, 401);
      const bad = await settings({ env: { PATH: '/tmp/evil' } });
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /not a provider key/);
      assert.equal((await settings({ defaults: { driver: 'no-such-agent' } })).status, 400);
    });

    it('puts provider keys in the environment and restores what was there before', async () => {
      const before = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'from-the-shell';
      try {
        assert.equal((await settings({ env: { OPENAI_API_KEY: 'dummy-key-for-test' } })).status, 200);
        assert.equal(process.env.OPENAI_API_KEY, 'dummy-key-for-test');
        assert.equal((await settings({ env: { OPENAI_API_KEY: null } })).status, 200);
        assert.equal(process.env.OPENAI_API_KEY, 'from-the-shell', 'removing the setting brings back the shell value');
        // With nothing underneath, removal deletes.
        delete process.env.OPENAI_API_KEY;
        await settings({ env: { OPENAI_API_KEY: 'dummy-key-for-test' } });
        await settings({ env: { OPENAI_API_KEY: null } });
        assert.equal(process.env.OPENAI_API_KEY, undefined);
      } finally {
        if (before === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = before;
      }
    });

    it('refuses a plan that names an agent braid does not have, before starting anything', async () => {
      const res = await authed(server, 'POST', '/api/runs', { plan: { goal: 'g', budgetUsd: 1, tasks: [{ id: 'a', title: 'A', prompt: 'p', driver: 'nonexistent-agent' }] } });
      assert.equal(res.status, 400);
      assert.match(res.json.error, /unknown driver "nonexistent-agent"/);
      assert.equal((await authed(server, 'GET', '/api/status')).json.active, null, 'nothing was left running');
      const before = (await call(server, 'GET', '/api/runs')).json.length;
      await authed(server, 'POST', '/api/runs', { plan: { goal: 'g', budgetUsd: 1, tasks: [{ id: 'a', title: 'A', prompt: 'p', driver: 'nonexistent-agent' }] } });
      assert.equal((await call(server, 'GET', '/api/runs')).json.length, before, 'no empty run folder is left behind');
    });

    it('applies the default agent and model to plans that do not choose, and reports them', async () => {
      script = () => ({ files: { 'a.txt': 'a\n' } });
      assert.equal((await settings({ defaults: { driver: 'mock', models: { mock: 'mock-model-1', claude: 'sonnet', codex: '' } } })).status, 200);
      assert.deepEqual((await authed(server, 'GET', '/api/status')).json.defaults, { driver: 'mock', models: { mock: 'mock-model-1', claude: 'sonnet' } });

      const open: PlanSpec = { goal: 'g', budgetUsd: 2, tasks: [{ id: 'a', title: 'A', prompt: 'p' }, { id: 'b', title: 'B', prompt: 'p', driver: 'claude' }] };
      const res = await authed(server, 'POST', '/api/runs', { plan: open });
      assert.equal(res.status, 202);
      const plan = storedPlan(res.json.runId);
      assert.equal(plan.driver, 'mock');
      assert.equal(plan.model, 'mock-model-1');
      assert.equal(plan.tasks[1]!.model, 'sonnet', 'a task on another agent gets that agent\'s model, not the plan\'s');
      await finished(res.json.runId);

      // A plan that chooses for itself is left alone.
      const own = await authed(server, 'POST', '/api/runs', { plan: { ...open, driver: 'mock', model: 'mine', tasks: [open.tasks[0]] } });
      assert.equal(storedPlan(own.json.runId).model, 'mine');
      await finished(own.json.runId);
      await settings({ defaults: {} });
    });
  });
});
