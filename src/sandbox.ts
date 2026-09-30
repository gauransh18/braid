import { spawn } from 'node:child_process';
import { spawnable } from './spawn.js';
import type { SandboxSpec } from './types.js';

/** A command line about to be spawned; a sandbox rewrites it to run inside a container. */
export interface CommandSpec {
  cmd: string;
  args: string[];
}
export type Wrap = (spec: CommandSpec) => CommandSpec;

/** Where the task worktree appears inside the container. A fixed path keeps host path quirks (Windows drives) out of it. */
export const WORK_DIR = '/work';
const HOME_DIR = '/tmp/braid-home';

/**
 * Runs a task's commands, and optionally its agent, in a throwaway container.
 *
 * Only the task worktree is mounted, so nothing inside can reach your other branches, your `.git`,
 * your home directory or other tasks' worktrees. Containers drop all capabilities, cannot gain
 * privileges, run as your uid, and are removed on exit. Secrets are passed to the agent by variable
 * name (`-e NAME`), so the values never appear in a process listing or in braid's files.
 *
 * Setup gets network (it installs dependencies); verify does not unless `network` is set. The agent
 * always has network, because it has to reach its model API.
 */
export class Sandbox {
  private constructor(
    readonly spec: SandboxSpec,
    readonly runtime: string,
  ) {}

  /** Find a working runtime and fail early, with a fix, if there is none. */
  static async create(spec: SandboxSpec): Promise<Sandbox> {
    const candidates = process.env.BRAID_CONTAINER_RUNTIME ? [process.env.BRAID_CONTAINER_RUNTIME] : ['docker', 'podman'];
    const problems: string[] = [];
    for (const bin of candidates) {
      const res = await probe(bin, ['info']);
      if (res.code === 0) return new Sandbox(spec, bin);
      problems.push(res.missing ? `${bin}: not installed` : `${bin}: not running (${res.stderr.trim().split('\n')[0] || `exit ${res.code}`})`);
    }
    throw new Error(`sandbox needs a container runtime, but none works:\n  - ${problems.join('\n  - ')}\nInstall and start Docker or Podman, or remove "sandbox" from the plan.`);
  }

  /** Test seam: skip detection. */
  static withRuntime(spec: SandboxSpec, runtime: string): Sandbox {
    return new Sandbox(spec, runtime);
  }

  private runArgs(cwd: string, o: { network: boolean; interactive: boolean; env: string[]; entrypoint: string }): string[] {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    return [
      'run',
      '--rm',
      '--init',
      ...(o.interactive ? ['-i'] : []),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '1024',
      ...(this.spec.memory ? ['--memory', this.spec.memory] : []),
      ...(this.spec.cpus ? ['--cpus', this.spec.cpus] : []),
      ...(uid !== undefined && gid !== undefined ? ['--user', `${uid}:${gid}`] : []),
      ...(o.network ? [] : ['--network', 'none']),
      '-v',
      `${cwd}:${WORK_DIR}`,
      '-w',
      WORK_DIR,
      '-e',
      `HOME=${HOME_DIR}`,
      '--tmpfs',
      `${HOME_DIR}:exec,mode=1777`,
      ...o.env.flatMap((name) => ['-e', name]),
      // Images often set their own ENTRYPOINT, which would swallow our command as arguments.
      '--entrypoint',
      o.entrypoint,
      this.spec.image,
    ];
  }

  /** A shell command for setup or verify, run in `cwd` mounted at /work. */
  command(cwd: string, command: string, phase: 'setup' | 'verify'): CommandSpec {
    const network = phase === 'setup' || this.spec.network === true;
    return { cmd: this.runtime, args: [...this.runArgs(cwd, { network, interactive: false, env: [], entrypoint: 'sh' }), '-c', command] };
  }

  /** Rewrites an agent CLI invocation to run inside the container, or undefined when only commands are sandboxed. */
  agentWrap(cwd: string): Wrap | undefined {
    if (!this.spec.agent) return undefined;
    return ({ cmd, args }) => ({
      cmd: this.runtime,
      args: [...this.runArgs(cwd, { network: true, interactive: true, env: this.spec.env ?? [], entrypoint: cmd }), ...args],
    });
  }
}

function probe(bin: string, args: string[]): Promise<{ code: number; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    const run = spawnable(bin, args);
    const child = spawn(run.cmd, run.args, { windowsHide: true, windowsVerbatimArguments: run.windowsVerbatimArguments });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', () => resolve({ code: 1, stderr, missing: true }));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr, missing: false }));
    setTimeout(() => child.kill(), 20_000).unref();
  });
}
