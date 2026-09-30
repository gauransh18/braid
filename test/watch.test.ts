import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startWatch, type WatchServer } from '../src/watch.js';

const RUN = '20260101-120000-abcd';

function get(url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: host ? { host } : {} }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Read an SSE stream until `until` matches the accumulated text, then disconnect. */
function sse(url: string, until: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
        if (until.test(text)) {
          req.destroy();
          resolve(text);
        }
      });
    });
    req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
    req.end();
  });
}

describe('watch server', () => {
  let repo: string;
  let w: WatchServer;

  before(async () => {
    repo = mkdtempSync(join(tmpdir(), 'braid-watch-'));
    const run = join(repo, '.braid', 'runs', RUN);
    mkdirSync(join(run, 'tasks', 'a'), { recursive: true });
    writeFileSync(join(run, 'plan.json'), JSON.stringify({ goal: 'g', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] }));
    writeFileSync(join(run, 'state.json'), JSON.stringify({ runId: RUN, status: 'running', costUsd: 0.5, tasks: {} }, null, 2));
    writeFileSync(join(run, 'events.jsonl'), '{"type":"run_start"}\n{"type":"task_status","task":"a","status":"running"}\n');
    writeFileSync(join(run, 'tasks', 'a', 'worker-1.jsonl'), '{"kind":"text","text":"hi"}\n');
    writeFileSync(join(run, 'tasks', 'a', 'reviewer-1.jsonl'), '{"kind":"text","text":"lgtm"}\n');
    w = await startWatch(repo, 0);
  });
  after(async () => {
    await w.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('serves the UI and lists runs', async () => {
    assert.match((await get(w.url)).body, /braid watch/);
    const runs = JSON.parse((await get(w.url + 'api/runs')).body);
    assert.deepEqual(runs.map((r: { runId: string; status: string }) => [r.runId, r.status]), [[RUN, 'running']]);
  });

  it('returns plan, state and ordered task logs', async () => {
    const run = JSON.parse((await get(`${w.url}api/run/${RUN}`)).body);
    assert.equal(run.plan.goal, 'g');
    assert.equal(run.state.costUsd, 0.5);
    const logs = JSON.parse((await get(`${w.url}api/run/${RUN}/task/a/log`)).body);
    assert.deepEqual(logs.map((l: { role: string }) => l.role), ['worker', 'reviewer']);
    assert.equal(logs[0].events[0].text, 'hi');
  });

  it('streams events and state over SSE', async () => {
    const text = await sse(`${w.url}api/run/${RUN}/events`, /event: state/);
    assert.match(text, /event: harness\ndata: \{"type":"run_start"\}/);
    assert.match(text, /event: state\ndata: \{"runId"/);
  });

  it('rejects foreign hosts and path tricks', async () => {
    assert.equal((await get(w.url + 'api/runs', 'evil.example.com')).status, 403);
    assert.equal((await get(`${w.url}api/run/..%2F..%2Fetc`)).status, 404);
    assert.equal((await get(`${w.url}api/run/${RUN}/task/..%2Fplan/log`)).status, 404);
  });
});

describe('embedded ui (single-file build)', () => {
  it('serves the embedded page instead of reading ui/index.html', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'braid-watch-'));
    const g = globalThis as { __BRAID_UI?: string };
    g.__BRAID_UI = '<!doctype html><title>embedded</title>';
    const w = await startWatch(repo, 0);
    try {
      const res = await get(w.url);
      assert.equal(res.status, 200);
      assert.equal(res.body, '<!doctype html><title>embedded</title>');
    } finally {
      delete g.__BRAID_UI;
      await w.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

