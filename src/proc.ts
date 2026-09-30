import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CommandSpec, Wrap } from './sandbox.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command without a shell. Throws on non-zero exit unless allowFail. */
export async function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; allowFail?: boolean; input?: string } ,
): Promise<ExecResult> {
  const res = await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
  if (res.code !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res;
}

/** Run a user-supplied shell command line (verify steps). Output is capped. */
export async function shell(command: string, cwd: string, timeoutMs = 10 * 60_000, sandboxed?: CommandSpec): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = sandboxed
      ? spawn(sandboxed.cmd, sandboxed.args, { cwd, windowsHide: true })
      : spawn(command, { cwd, shell: true, windowsHide: true });
    let out = '';
    const append = (d: Buffer) => {
      out += d;
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: out, stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out, stderr: '' });
    });
  });
}

/** Spawn a process, feed stdin, and yield stdout line by line. */
export async function streamLines(
  cmd: string,
  args: string[],
  opts: { cwd: string; input: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; wrap?: Wrap },
  onLine: (line: string) => void,
): Promise<{ code: number; stderr: string }> {
  const run = opts.wrap ? opts.wrap({ cmd, args }) : { cmd, args };
  const child = spawn(run.cmd, run.args, {
    cwd: opts.cwd,
    windowsHide: true,
    env: opts.env ?? process.env,
    signal: opts.signal,
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 50_000) stderr = stderr.slice(-20_000);
  });
  const done = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  child.stdin.end(opts.input);
  const rl = createInterface({ input: child.stdout });
  for await (const line of rl) if (line.trim()) onLine(line);
  return { code: await done, stderr };
}
