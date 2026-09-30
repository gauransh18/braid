import { createReadStream, existsSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Read-only local dashboard. Everything it shows comes from files under .braid/,
 * so it can watch a run happening in another process. Binds to loopback only and
 * rejects foreign Host headers (DNS rebinding).
 */
export async function startWatch(repo: string, port = 4777): Promise<WatchServer> {
  const server = createServer((req, res) => {
    handle(repo, req, res).catch((err) => {
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

async function handle(repo: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostAllowed(req)) return send(res, 403, { error: 'forbidden host' });
  if (req.method !== 'GET') return send(res, 405, { error: 'read-only' });
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts.length === 0) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    createReadStream(UI_PATH).pipe(res);
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
