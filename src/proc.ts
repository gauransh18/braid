import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CommandSpec, Wrap } from './sandbox.js';
import { spawnable } from './spawn.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What `shell` adds when it had to stop the command itself. */
export interface ShellResult extends ExecResult {
  /** Killed because it ran past its time limit. */
  timedOut?: boolean;
  /** Killed because the run was aborted. */
  aborted?: boolean;
}

export const SHELL_TIMEOUT_MS = 10 * 60_000;

const WINDOWS = process.platform === 'win32';

/**
 * Commands and agents run in their own process group (POSIX), so one signal reaches everything they started that
 * stayed in it: `npm test` and its workers. It does not reach what an agent CLI puts in a group of its own (Codex
 * starts every tool command as a session leader), so stopping an agent also snapshots its descendants. Windows has no
 * groups; `taskkill /T` walks the tree. Spawning this way also means a terminal Ctrl-C no longer reaches them by
 * themselves, so the program that spawns them has to stop them (`stopTree`, `killAllChildren`).
 */
const GROUP = { detached: !WINDOWS };

interface Tracked {
  spec?: CommandSpec;
}

/** Children that are still running, so they can be stopped when braid itself is told to quit. */
const live = new Map<ChildProcess, Tracked>();

/** A descendant of a child that was being stopped, as `ps` saw it before any signal was sent. */
interface Descendant {
  pid: number;
  pgid: number;
}

/** Children that were told to stop and may still be dying: the exit hook finishes them off with SIGKILL. */
const dying = new Map<ChildProcess, { spec?: CommandSpec; tree: Descendant[] }>();

/** How long a stopping agent gets after SIGINT before SIGTERM, and in total before SIGKILL. Tests shorten these. */
export const STOP_TIMING = { termAfterMs: 2000, killAfterMs: 5000 };

const noop = () => undefined;

/** `pid`'s descendants right now (POSIX only), so they can still be killed after their parent has gone. */
function snapshotDescendants(pid: number | undefined): Descendant[] {
  if (WINDOWS || pid === undefined) return [];
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  if (ps.status !== 0 || !ps.stdout) return [];
  const rows = ps.stdout.split('\n').flatMap((line) => {
    const [p, pp, pg] = line.trim().split(/\s+/).map(Number);
    return p && pp !== undefined && pg !== undefined && Number.isFinite(p + pp + pg) ? [{ pid: p, ppid: pp, pgid: pg }] : [];
  });
  const found: Descendant[] = [];
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const row of rows) {
      if (row.ppid === parent && row.pid !== process.pid && !found.some((d) => d.pid === row.pid)) {
        found.push({ pid: row.pid, pgid: row.pgid });
        queue.push(row.pid);
      }
    }
  }
  return found;
}

const ownGroup = (): number | undefined => {
  if (WINDOWS) return undefined;
  const ps = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 3000 });
  const n = Number(ps.stdout?.trim());
  return Number.isFinite(n) && n > 1 ? n : undefined;
};

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/** Kill what `snapshotDescendants` found, each one and its own group (an agent's tool command leads a group of its own). */
function killDescendants(tree: Descendant[], signal: NodeJS.Signals): void {
  const mine = ownGroup();
  for (const d of tree) {
    signalPid(d.pid, signal);
    if (d.pgid > 1 && d.pgid !== mine) signalPid(-d.pgid, signal);
  }
}

function groupAlive(child: ChildProcess): boolean {
  if (WINDOWS || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

const treeAlive = (child: ChildProcess, tree: Descendant[]): boolean =>
  groupAlive(child) ||
  tree.some((d) => {
    try {
      process.kill(d.pid, 0);
      return true;
    } catch {
      return false;
    }
  });

function signalTree(child: ChildProcess, signal: NodeJS.Signals, sync = false): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (WINDOWS) {
    // /T includes the children, /F because there is nobody to ask nicely.
    const args = ['/pid', String(pid), '/T', '/F'];
    if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', noop);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone, or this child was not started in one.
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * Killing the docker client does not stop the container it started, so remove the container by name. Never waits:
 * a wedged daemon must not hold up a force-quit.
 */
function removeContainer(spec: CommandSpec | undefined): void {
  if (!spec?.container) return;
  const run = spawnable(spec.container.runtime, ['rm', '-f', spec.container.name]);
  const child = spawn(run.cmd, run.args, { windowsHide: true, stdio: 'ignore', detached: !WINDOWS, windowsVerbatimArguments: run.windowsVerbatimArguments });
  child.on('error', noop);
  child.unref();
}

/**
 * Stop a child and everything it started, escalating until it is gone. A plain command gets SIGTERM and, after
 * `killAfterMs`, SIGKILL. An agent (`interrupt`) gets SIGINT first, because Claude and Codex clean up their own tool
 * commands on SIGINT, and Codex's commands live in a session of their own that no group signal reaches. Descendants
 * are snapshotted before any signal, so the escalation can still reach them once their parent has gone. A sandbox
 * container is removed by name, twice, since the first removal can land before the daemon has registered it.
 */
export function stopTree(child: ChildProcess, spec?: CommandSpec, opts: { interrupt?: boolean } = {}): void {
  const tree = snapshotDescendants(child.pid);
  dying.set(child, { spec, tree });
  signalTree(child, opts.interrupt && !WINDOWS ? 'SIGINT' : 'SIGTERM');
  removeContainer(spec);
  if (WINDOWS) {
    dying.delete(child);
    return;
  }
  const settled = () => {
    if (treeAlive(child, tree)) return false;
    dying.delete(child);
    return true;
  };
  const later = (ms: number, fn: () => void) => setTimeout(() => !settled() && fn(), ms).unref();
  if (opts.interrupt) {
    later(STOP_TIMING.termAfterMs, () => {
      signalTree(child, 'SIGTERM');
      killDescendants(tree, 'SIGTERM');
    });
  }
  later(STOP_TIMING.killAfterMs, () => {
    signalTree(child, 'SIGKILL');
    killDescendants(tree, 'SIGKILL');
    dying.delete(child);
  });
  setTimeout(() => removeContainer(spec), 2000).unref();
}

/** Kill everything braid started that is still running or still dying. Runs when braid exits, and on a second Ctrl-C. */
export function killAllChildren(): void {
  const all = new Map<ChildProcess, Descendant[]>();
  for (const [child, d] of dying) all.set(child, d.tree);
  for (const child of live.keys()) if (!all.has(child)) all.set(child, snapshotDescendants(child.pid));
  const specs = [...[...live.values()].map((t) => t.spec), ...[...dying.values()].map((d) => d.spec)];
  for (const [child, tree] of all) {
    signalTree(child, 'SIGKILL', true);
    killDescendants(tree, 'SIGKILL');
  }
  for (const spec of specs) removeContainer(spec);
  live.clear();
  dying.clear();
}

process.on('exit', killAllChildren);

/** Whether a process with this id exists (one that belongs to someone else counts: we just may not signal it). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What a spawn that was cut short by an abort signal throws. */
export function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/**
 * Run a command without a shell. Throws on non-zero exit unless allowFail. Like every other child it runs in its own
 * process group, so a terminal Ctrl-C does not kill a `git` that braid is relying on to wind down; it is stopped
 * with its children on `timeoutMs`, when `signal` aborts, and when braid force-quits.
 */
export async function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; allowFail?: boolean; input?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
): Promise<ExecResult> {
  const res = await new Promise<ExecResult>((resolve, reject) => {
    const run = spawnable(cmd, args);
    const child = spawn(run.cmd, run.args, { cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: run.windowsVerbatimArguments, env: opts.env ? { ...process.env, ...opts.env } : undefined, ...GROUP });
    live.set(child, {});
    const stop = () => stopTree(child);
    const timer = opts.timeoutMs ? setTimeout(stop, opts.timeoutMs) : undefined;
    if (opts.signal?.aborted) stop();
    else opts.signal?.addEventListener('abort', stop, { once: true });
    const finished = () => {
      clearTimeout(timer);
      live.delete(child);
      opts.signal?.removeEventListener('abort', stop);
    };
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { finished(); reject(e); });
    child.on('close', (code) => { finished(); resolve({ code: code ?? 1, stdout, stderr }); });
    // A child that exits (or never starts) before reading stdin makes the write fail with EPIPE. That is not an
    // error of ours: the exit code or the spawn error already says what happened, so swallow it here.
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
  });
  if (res.code !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res;
}

/**
 * Run a user-supplied shell command line (verify steps). Output is capped. A command that runs past `timeoutMs`, or
 * whose `signal` aborts, is stopped together with everything it started, and the result says which happened.
 */
export async function shell(command: string, cwd: string, timeoutMs = SHELL_TIMEOUT_MS, sandboxed?: CommandSpec, signal?: AbortSignal): Promise<ShellResult> {
  if (signal?.aborted) return { code: 1, stdout: '', stderr: 'aborted', aborted: true };
  return new Promise((resolve) => {
    const child = sandboxed
      ? spawn(sandboxed.cmd, sandboxed.args, { cwd, windowsHide: true, ...GROUP })
      : spawn(command, { cwd, shell: true, windowsHide: true, ...GROUP });
    live.set(child, { spec: sandboxed });
    // Decode as a stream: a character split across two reads must not turn into U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let out = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let linger: NodeJS.Timeout | undefined;
    const append = (d: string) => {
      out += d;
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    const finish = (code: number, stderr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(linger);
      signal?.removeEventListener('abort', onAbort);
      live.delete(child);
      // A command that was stopped can still exit 0 (it trapped SIGTERM and shut down tidily). That is not a pass.
      const stopped = timedOut || aborted;
      resolve({ code: stopped && code === 0 ? 1 : code, stdout: out, stderr, ...(timedOut ? { timedOut } : {}), ...(aborted ? { aborted } : {}) });
    };
    const onAbort = () => {
      aborted = true;
      stopTree(child, sandboxed);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree(child, sandboxed);
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => finish(1, String(err)));
    // 'close' waits until every holder of the output pipes lets go. A background process that outlives the command
    // (and escaped the group) would hold them open forever, so give up on the pipes shortly after the command exits.
    child.on('exit', (code) => {
      linger = setTimeout(() => {
        // Whatever still holds the pipes is abandoned by this result, so it must not be left running.
        stopTree(child, sandboxed);
        finish(code ?? 1);
      }, 2000);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

/**
 * Spawn a process, feed stdin, and yield stdout line by line. When `signal` aborts the process is stopped with
 * everything it started (and its container, if wrapped) and this throws an AbortError.
 */
export async function streamLines(
  cmd: string,
  args: string[],
  opts: { cwd: string; input: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; wrap?: Wrap },
  onLine: (line: string) => void,
): Promise<{ code: number; stderr: string }> {
  if (opts.signal?.aborted) throw abortError();
  const wrapped = opts.wrap ? opts.wrap({ cmd, args }) : { cmd, args };
  const run = spawnable(wrapped.cmd, wrapped.args);
  const child = spawn(run.cmd, run.args, {
    windowsVerbatimArguments: run.windowsVerbatimArguments,
    cwd: opts.cwd,
    windowsHide: true,
    env: opts.env ?? process.env,
    ...GROUP,
  });
  live.set(child, { spec: wrapped });
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    stopTree(child, wrapped, { interrupt: true });
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 50_000) stderr = stderr.slice(-20_000);
  });
  const done = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  // A spawn failure (binary not installed) rejects before we start awaiting `done`; mark it handled so Node does
  // not treat that as a crash. The `await done` below still throws it, and the task fails with a clear message.
  done.catch(() => undefined);
  child.stdin.on('error', () => undefined); // see exec(): an agent that dies before reading its prompt is reported by its exit
  child.stdin.end(opts.input);
  try {
    const rl = createInterface({ input: child.stdout });
    for await (const line of rl) if (line.trim()) onLine(line);
    const code = await done;
    if (aborted) throw abortError();
    return { code, stderr };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    live.delete(child);
  }
}
