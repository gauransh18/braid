import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DriverRegistry } from './drivers/driver.js';
import { checkTools } from './doctor.js';
import { detectVerify, HttpError, RunManager } from './runs.js';
import { RunStore, stateRoot } from './store.js';

const UI_PATH = fileURLToPath(new URL('../../ui/index.html', import.meta.url));
const RUN_ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{2,8}$/;
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOG_FILE_RE = /^(worker|resolver|reviewer|replanner)-(\d+)\.jsonl$/;
const POLL_MS = 400;

export interface WatchServer {
  url: string;
  close(): Promise<void>;
}

/** Turns on the write endpoints: start, stop and resume runs, draft plans. Off unless a token is given. */
export interface ControlOptions {
  /** Secret the page must present. Generate it fresh per session and hand it over out of band (URL fragment). */
  token: string;
  drivers: () => DriverRegistry;
}

/**
 * Local dashboard. Read-only unless `control` is given. Everything it shows comes from files under .braid/,
 * so it can watch a run happening in another process. Binds to loopback only and
 * rejects foreign Host headers (DNS rebinding).
 *
 * The write endpoints can start agents that edit files and run commands, so they are guarded three ways:
 * a per-session bearer token, an Origin check (a page on another site cannot send the header without CORS,
 * which this server never grants), and a JSON content type.
 */
export async function startWatch(repo: string, port = 4777, control?: ControlOptions): Promise<WatchServer> {
  const runs = control ? new RunManager(repo, control.drivers) : undefined;
  const server = createServer((req, res) => {
    handle(repo, req, res, control && runs ? { token: control.token, runs } : undefined).catch((err) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (!res.headersSent) send(res, 500, { error: String(err) });
      else res.end();
    });
  });
  const actual = await listen(server, port);
  return {
    url: `http://127.0.0.1:${actual}/`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number, left: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1);
        else reject(err);
      });
      server.listen(p, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : p);
      });
    };
    tryPort(port, 20);
  });
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function hostAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

interface Control {
  token: string;
  runs: RunManager;
}

function tokenOk(req: IncomingMessage, token: string): boolean {
  const given = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(given), digest(token));
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

const MAX_BODY = 1_000_000;

async function readBody(req: IncomingMessage): Promise<any> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'send application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const PLAN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/;

/** Endpoints that change things or read repo files. Everything here needs the session token. */
async function handleControl(repo: string, req: IncomingMessage, res: ServerResponse, parts: string[], control: Control): Promise<void> {
  if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin request refused' });
  if (!tokenOk(req, control.token)) return send(res, 401, { error: 'missing or wrong token' });
  const { runs } = control;

  if (parts[1] === 'status' && req.method === 'GET') {
    return send(res, 200, { active: runs.activeRunId, repoName: basename(repo), suggestedVerify: await detectVerify(repo), defaults: runs.agentDefaults });
  }
  if (parts[1] === 'doctor' && req.method === 'GET') {
    // The CLIs braid can find, plus NVIDIA NIM, which is a hosted API: "installed" there means a key is set.
    const rows = [
      ...(await checkTools()),
      { name: 'nim', ok: !!process.env.NVIDIA_API_KEY, version: 'API key set', required: false, why: 'NVIDIA NIM hosted models', install: 'Add an NVIDIA API key in Braid > Settings' },
    ];
    return send(res, 200, rows.map((r) => ({ ...r, disabled: runs.isDisabled(r.name) })));
  }

  if (parts[1] === 'plans' && req.method === 'GET') {
    const dir = join(repo, 'plans');
    if (parts.length === 2) {
      const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => PLAN_NAME_RE.test(n)).sort();
      return send(res, 200, names);
    }
    const name = parts[2] ?? '';
    if (!PLAN_NAME_RE.test(name)) return send(res, 404, { error: 'not found' });
    const text = await readFile(join(dir, name), 'utf8').catch(() => null);
    return text === null ? send(res, 404, { error: 'not found' }) : send(res, 200, JSON.parse(text));
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  if (parts[1] === 'settings' && parts.length === 2) {
    const body = await readBody(req);
    runs.applySettings({ env: body.env && typeof body.env === 'object' ? body.env : undefined, defaults: body.defaults && typeof body.defaults === 'object' ? body.defaults : undefined });
    return send(res, 200, { ok: true });
  }
  if (parts[1] === 'plan-draft' && parts.length === 2) {
    const body = await readBody(req);
    const verify = Array.isArray(body.verify) ? body.verify.map(String) : [];
    return send(res, 200, await runs.draft(String(body.goal ?? ''), verify, typeof body.driver === 'string' ? body.driver : undefined));
  }
  if (parts[1] === 'agents' && parts.length === 3) {
    const body = await readBody(req);
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'body needs enabled: true or false');
    return send(res, 200, runs.setAgentEnabled(parts[2] ?? '', body.enabled));
  }
  if (parts[1] === 'runs' && parts.length === 2) {
    const body = await readBody(req);
    if (!body.plan || typeof body.plan !== 'object') throw new HttpError(400, 'body needs a plan object');
    return send(res, 202, await runs.start(body.plan));
  }
  if (parts[1] === 'run' && RUN_ID_RE.test(parts[2] ?? '') && parts.length === 4) {
    const id = parts[2]!;
    if (parts[3] === 'stop') {
      runs.stop(id);
      return send(res, 202, { stopping: id });
    }
    if (parts[3] === 'resume') {
      const body = await readBody(req);
      const budget = body.budgetUsd === undefined ? undefined : Number(body.budgetUsd);
      return send(res, 202, await runs.resume(id, budget));
    }
  }
  send(res, 404, { error: 'not found' });
}

async function handle(repo: string, req: IncomingMessage, res: ServerResponse, control?: Control): Promise<void> {
  if (!hostAllowed(req)) return send(res, 403, { error: 'forbidden host' });
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'api' && parts[1] === 'config' && req.method === 'GET') return send(res, 200, { control: !!control });
  const writes = ['status', 'plans', 'plan-draft', 'doctor', 'settings', 'agents'].includes(parts[1] ?? '') || (parts[1] === 'runs' && req.method !== 'GET') || (parts[1] === 'run' && req.method !== 'GET');
  if (parts[0] === 'api' && writes) {
    if (!control) return send(res, 405, { error: 'read-only' });
    return handleControl(repo, req, res, parts, control);
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'read-only' });

  if (parts.length === 0) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    // A single-file build embeds the page in the binary; otherwise read it from the package.
    const embedded = (globalThis as { __BRAID_UI?: string }).__BRAID_UI;
    if (embedded !== undefined) res.end(embedded);
    else createReadStream(UI_PATH).pipe(res);
    return;
  }
  if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });

  if (parts[1] === 'runs' && parts.length === 2) {
    const ids = (await RunStore.listRuns(repo)).filter((id) => RUN_ID_RE.test(id));
    const runs = await Promise.all(
      ids.map(async (id) => {
        const s = await RunStore.loadState(repo, id).catch(() => null);
        return { runId: id, status: s?.status ?? 'starting', costUsd: s?.costUsd ?? 0, costEstimated: s?.costEstimated, createdAt: s?.createdAt };
      }),
    );
    return send(res, 200, runs.reverse());
  }

  const runId = parts[2] ?? '';
  if (parts[1] !== 'run' || !RUN_ID_RE.test(runId)) return send(res, 404, { error: 'not found' });
  const runDir = join(stateRoot(repo), 'runs', runId);
  if (!existsSync(runDir)) return send(res, 404, { error: 'no such run' });

  if (parts.length === 3) {
    const [plan, state] = await Promise.all([readJson(join(runDir, 'plan.json')), readJson(join(runDir, 'state.json'))]);
    return send(res, 200, { plan, state });
  }
  if (parts[3] === 'events' && parts.length === 4) return streamRun(runDir, req, res);
  if (parts[3] === 'task' && parts[5] === 'log' && parts.length === 6) {
    const taskId = parts[4] ?? '';
    if (!TASK_ID_RE.test(taskId)) return send(res, 404, { error: 'bad task id' });
    return send(res, 200, await taskLogs(join(runDir, 'tasks', taskId)));
  }
  send(res, 404, { error: 'not found' });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8').catch(() => 'null'));
}

/** Transcript files for a task, oldest attempt first. Each file keeps its last 400 events. */
async function taskLogs(dir: string) {
  const files = (await readdir(dir).catch(() => [] as string[]))
    .map((f) => ({ f, m: LOG_FILE_RE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => !!x.m)
    .sort((a, b) => Number(a.m[2]) - Number(b.m[2]) || (a.m[1] === 'reviewer' ? 1 : -1));
  return Promise.all(
    files.map(async ({ f, m }) => {
      const lines = (await readFile(join(dir, f), 'utf8')).split('\n').filter(Boolean);
      const events = lines.slice(-400).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
      return { role: m[1], attempt: Number(m[2]), truncated: lines.length > 400, events };
    }),
  );
}

/**
 * SSE stream: replays events.jsonl, then tails it and pushes fresh state snapshots.
 * Polling instead of fs.watch because fs.watch is unreliable on Windows and network drives.
 */
async function streamRun(runDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const eventsPath = join(runDir, 'events.jsonl');
  const statePath = join(runDir, 'state.json');
  let offset = 0;
  let partial = '';
  let stateMtime = 0;
  let closed = false;
  req.on('close', () => (closed = true));

  const write = (type: string, data: string) => res.write(`event: ${type}\ndata: ${data}\n\n`);

  const tick = async () => {
    const es = await stat(eventsPath).catch(() => null);
    if (es && es.size > offset) {
      const fh = await open(eventsPath, 'r');
      try {
        const buf = Buffer.alloc(es.size - offset);
        await fh.read(buf, 0, buf.length, offset);
        offset = es.size;
        const chunk = partial + buf.toString('utf8');
        const lines = chunk.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) write('harness', line);
      } finally {
        await fh.close();
      }
    }
    const ss = await stat(statePath).catch(() => null);
    if (ss && ss.mtimeMs !== stateMtime) {
      stateMtime = ss.mtimeMs;
      const text = await readFile(statePath, 'utf8').catch(() => '');
      if (text) write('state', text.replace(/\n\s*/g, ''));
    }
  };

  write('hello', '{}');
  for (let n = 0; !closed; n++) {
    await tick().catch(() => undefined);
    if (n % 40 === 0) res.write(': ping\n\n');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
