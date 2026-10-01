import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';

let cached: string | undefined;

/**
 * Where a process id means something: this machine (by host name) and, on Linux, this PID namespace. A pid is only
 * a name for a process in one kernel's namespace, so a pid recorded by a braid on another machine, in a dev container
 * or in WSL says nothing here: `kill(pid, 0)` finds no such process, or an unrelated one. Whatever braid records a
 * pid for (the containers it starts, a run's state.json) records this beside it, and only trusts a pid that was
 * recorded in the same place. A host name can change between runs (some networks rename a laptop), which then makes
 * what an earlier run left look foreign: it is left alone rather than removed, which is the safe way to be wrong.
 */
export function hostIdentity(): string {
  if (cached) return cached;
  let ns = '';
  try {
    ns = /\[(\d+)\]/.exec(readlinkSync('/proc/self/ns/pid'))?.[1] ?? '';
  } catch {
    /* not Linux, or no /proc */
  }
  // Safe in a label value, in the output of `docker ps --format`, and as one word of it.
  cached = `${hostname().replace(/[^A-Za-z0-9.-]/g, '_') || 'host'}${ns ? `:${ns}` : ''}`;
  return cached;
}
