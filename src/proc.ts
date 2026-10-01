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
 * Commands and agents run in their own process group (POSIX), so one signal reaches everything they started:
 * `npm test` and its workers, an agent's tool subprocesses. Windows has no groups; `taskkill /T` walks the tree.
 * Spawning this way also means a terminal Ctrl-C no longer reaches them by itself, so the program that spawns
 * them has to stop them (`stopTree`, `killAllChildren`).
 */
const GROUP = { detached: !WINDOWS };

/** Children that are still running, so they can be stopped when braid itself is told to quit. */
const live = new Map<ChildProcess, CommandSpec | undefined>();

function signalTree(child: ChildProcess, signal: NodeJS.Signals, sync = false): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (WINDOWS) {
    // /T includes the children, /F because there is nobody to ask nicely.
    const args = ['/pid', String(pid), '/T', '/F'];
    if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
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

/** Killing the docker client does not stop the container it started, so remove the container by name. */
function removeContainer(spec: CommandSpec | undefined, sync = false): void {
  if (!spec?.container) return;
  const run = spawnable(spec.container.runtime, ['rm', '-f', spec.container.name]);
  const opts = { windowsHide: true, stdio: 'ignore' as const, windowsVerbatimArguments: run.windowsVerbatimArguments };
  if (sync) spawnSync(run.cmd, run.args, { ...opts, timeout: 10_000 });
  else spawn(run.cmd, run.args, opts).on('error', () => undefined);
}

/**
 * Stop a child and everything it started: SIGTERM to the group, then SIGKILL after a grace period for whatever
 * ignores it. A sandbox container is removed too.
 */
export function stopTree(child: ChildProcess, spec?: CommandSpec, graceMs = 5000): void {
  signalTree(child, 'SIGTERM');
  if (!WINDOWS) setTimeout(() => signalTree(child, 'SIGKILL'), graceMs).unref();
  removeContainer(spec);
}

/** Kill everything braid started that is still running. Runs when braid exits, and when it is told to quit twice. */
export function killAllChildren(): void {
  for (const [child, spec] of live) {
    signalTree(child, 'SIGKILL', true);
    removeContainer(spec, true);
  }
  live.clear();
}

process.on('exit', killAllChildren);

/** What a spawn that was cut short by an abort signal throws. */
export function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/** Run a command without a shell. Throws on non-zero exit unless allowFail. */
export async function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; allowFail?: boolean; input?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<ExecResult> {
  const res = await new Promise<ExecResult>((resolve, reject) => {
    const run = spawnable(cmd, args);
    const child = spawn(run.cmd, run.args, { cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: run.windowsVerbatimArguments, env: opts.env ? { ...process.env, ...opts.env } : undefined });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : undefined;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
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
    live.set(child, sandboxed);
    let out = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let linger: NodeJS.Timeout | undefined;
    const append = (d: Buffer) => {
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
      resolve({ code, stdout: out, stderr, ...(timedOut ? { timedOut } : {}), ...(aborted ? { aborted } : {}) });
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
      linger = setTimeout(() => finish(code ?? 1), 2000);
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
  live.set(child, wrapped);
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    stopTree(child, wrapped);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let stderr = '';
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
