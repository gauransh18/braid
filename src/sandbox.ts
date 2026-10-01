import { randomBytes } from 'node:crypto';
import { abortError, exec, pidAlive } from './proc.js';
import type { SandboxSpec } from './types.js';

/** A command line about to be spawned; a sandbox rewrites it to run inside a container. */
export interface CommandSpec {
  cmd: string;
  args: string[];
  /** Set when the command is a container run: stopping the client does not stop the container, so it is removed by name. */
  container?: { runtime: string; name: string };
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
  /** Ids of stale containers (left by a braid that died) removed when this sandbox was created. */
  swept: string[] = [];

  private constructor(
    readonly spec: SandboxSpec,
    readonly runtime: string,
  ) {}

  /** Find a working runtime and fail early, with a fix, if there is none. */
  static async create(spec: SandboxSpec, signal?: AbortSignal): Promise<Sandbox> {
    const candidates = process.env.BRAID_CONTAINER_RUNTIME ? [process.env.BRAID_CONTAINER_RUNTIME] : ['docker', 'podman'];
    const problems: string[] = [];
    for (const bin of candidates) {
      const res = await probe(bin, ['info'], signal);
      if (signal?.aborted) throw abortError();
      if (res.code === 0) {
        const sandbox = new Sandbox(spec, bin);
        sandbox.swept = await sweepStale(bin, signal);
        if (signal?.aborted) throw abortError();
        return sandbox;
      }
      problems.push(res.missing ? `${bin}: not installed` : `${bin}: not running (${res.stderr.trim().split('\n')[0] || `exit ${res.code}`})`);
    }
    throw new Error(`sandbox needs a container runtime, but none works:\n  - ${problems.join('\n  - ')}\nInstall and start Docker or Podman, or remove "sandbox" from the plan.`);
  }

  /** Test seam: skip detection. */
  static withRuntime(spec: SandboxSpec, runtime: string): Sandbox {
    return new Sandbox(spec, runtime);
  }

  private runArgs(cwd: string, o: { name: string; network: boolean; interactive: boolean; env: string[]; entrypoint: string }): string[] {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    return [
      'run',
      '--rm',
      '--init',
      '--name',
      o.name,
      // What sweepStale finds them by, when this process is no longer around to remove them.
      '--label',
      'braid=1',
      '--label',
      `braid.pid=${process.pid}`,
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
    const name = containerName();
    return {
      cmd: this.runtime,
      args: [...this.runArgs(cwd, { name, network, interactive: false, env: [], entrypoint: 'sh' }), '-c', command],
      container: { runtime: this.runtime, name },
    };
  }

  /** Rewrites an agent CLI invocation to run inside the container, or undefined when only commands are sandboxed. */
  agentWrap(cwd: string): Wrap | undefined {
    if (!this.spec.agent) return undefined;
    return ({ cmd, args }) => {
      const name = containerName();
      return {
        cmd: this.runtime,
        args: [...this.runArgs(cwd, { name, network: true, interactive: true, env: this.spec.env ?? [], entrypoint: cmd }), ...args],
        container: { runtime: this.runtime, name },
      };
    };
  }
}

/** A name braid can stop the container by, since killing the `docker run` client leaves the container running. */
function containerName(): string {
  return `braid-${randomBytes(6).toString('hex')}`;
}

/**
 * Containers outlive a braid that was killed outright (SIGKILL, a crash, power loss): `--rm` and the removal by name only
 * run while braid does. Each container carries the pid of the braid that started it, so one whose pid is gone is stale.
 * Never touches our own pid or a live one, skips rows it cannot read, and never throws: housekeeping must not stop a run.
 * Returns the ids it removed.
 */
export async function sweepStale(runtime: string, signal?: AbortSignal): Promise<string[]> {
  const removed: string[] = [];
  try {
    const list = await exec(runtime, ['ps', '-a', '--filter', 'label=braid', '--format', '{{.ID}} {{.Label "braid.pid"}}'], { cwd: process.cwd(), allowFail: true, timeoutMs: 20_000, signal });
    if (list.code !== 0) return removed;
    for (const row of list.stdout.split('\n')) {
      const m = /^\s*([0-9a-f]{4,64})\s+(\d+)\s*$/i.exec(row);
      const pid = m ? Number(m[2]) : 0;
      if (!m || !Number.isSafeInteger(pid) || pid < 1 || pid === process.pid || pidAlive(pid)) continue;
      if (signal?.aborted) break;
      const rm = await exec(runtime, ['rm', '-f', m[1]!], { cwd: process.cwd(), allowFail: true, timeoutMs: 20_000, signal });
      if (rm.code === 0) removed.push(m[1]!);
    }
  } catch {
    /* no runtime, a daemon that stopped answering: whatever was removed so far still counts */
  }
  return removed;
}

/** Ask a container runtime whether it works. Stoppable, and its whole process tree dies on the time limit. */
async function probe(bin: string, args: string[], signal?: AbortSignal): Promise<{ code: number; stderr: string; missing: boolean }> {
  try {
    const res = await exec(bin, args, { cwd: process.cwd(), allowFail: true, timeoutMs: 20_000, signal });
    return { code: res.code, stderr: res.stderr, missing: false };
  } catch {
    return { code: 1, stderr: '', missing: true };
  }
}
