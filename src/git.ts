import { spawnSync } from 'node:child_process';
import { appendFile, readFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { abortError, exec, type ExecResult } from './proc.js';

const FALLBACK_IDENTITY = ['-c', 'user.name=braid', '-c', 'user.email=braid@localhost'];

/** File times can be coarser than a clock reading (1 s on HFS+, 2 s on FAT). */
const MTIME_SLACK_MS = 2000;

/**
 * Whether a git process has one of `paths` on its command line (-C, --git-dir, --work-tree), which is how a process
 * that may hold a lock on that worktree shows itself. Undefined when the process list cannot be read (Windows, a
 * minimal `ps`): then nobody can say that none does.
 */
function gitProcessNames(paths: string[]): boolean | undefined {
  if (process.platform === 'win32') return undefined;
  const ps = spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  if (ps.status !== 0 || !ps.stdout) return undefined;
  return ps.stdout.split('\n').some((line) => {
    const cmd = line.trim().replace(/^\d+\s+/, '');
    const exe = cmd.split(/\s+/, 1)[0] ?? '';
    return /(?:^|\/)git(?:-[\w-]+)?$/.test(exe) && paths.some((p) => cmd.includes(p));
  });
}

/** Thin wrapper over git. The harness only ever writes to branches it created. */
export class Git {
  /**
   * `signal` is the run's: it ends the commands that can sit in a slow hook (commit, merge, worktree add), so a Stop
   * does not wait for a pre-commit hook that runs the whole test suite.
   */
  constructor(
    readonly repo: string,
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * Worktrees this object created, with the git directory recorded at creation. A task's worktree is mounted into a
   * sandbox container that can rewrite its `.git` pointer file, and git trusts that file to find the repository (and
   * its config, which can name a program to run). Host-side git therefore never discovers the repository from a
   * worktree: it is told where it is.
   */
  private pinned = new Map<string, string>();

  async run(args: string[], cwd = this.repo, allowFail = false, signal?: AbortSignal) {
    const gitDir = this.pinned.get(resolve(cwd));
    const pin = gitDir ? ['--git-dir', gitDir, '--work-tree', resolve(cwd), '-c', 'core.fsmonitor=false'] : [];
    return exec('git', [...pin, ...args], { cwd, allowFail, signal });
  }

  /**
   * Run a command that can sit in a slow hook, so that a Stop ends it: git and the hook are killed, `cleanup` makes the
   * repository usable again, and an AbortError is thrown. A command that had finished when the Stop reached it counts
   * as finished; one that failed after the Stop is taken as stopped (the run is ending either way).
   */
  private async stoppable(args: string[], cwd: string, allowFail: boolean, cleanup: (startedAt: number) => Promise<void>): Promise<ExecResult> {
    const signal = this.signal;
    if (!signal) return this.run(args, cwd, allowFail);
    // Not started at all: a git spawned just to be killed could die anywhere.
    if (signal.aborted) throw abortError();
    const startedAt = Date.now();
    const res = await this.run(args, cwd, true, signal);
    if (res.code !== 0 && signal.aborted) {
      await cleanup(startedAt).catch(() => undefined);
      throw abortError();
    }
    if (res.code !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
    return res;
  }

  /**
   * Leave a worktree of ours usable after a git command in it was killed midway: a merge it left in progress is
   * aborted, and an index.lock it left behind is removed, but only one made while the command ran and only when no git
   * process names the worktree (git removes its own locks on SIGTERM; SIGKILL leaves them). Never throws: the Stop that
   * got us here is what gets reported. Worktrees only: never the person's own checkout.
   */
  async settle(cwd: string, since: number): Promise<void> {
    if (!this.pinned.has(resolve(cwd))) return;
    try {
      const { stdout } = await this.run(['rev-parse', '--git-path', 'index.lock'], cwd);
      const lock = resolve(cwd, stdout.trim());
      const made = await stat(lock).catch(() => null);
      if (made && made.mtimeMs >= since - MTIME_SLACK_MS && gitProcessNames([resolve(cwd), dirname(lock)]) === false) await rm(lock, { force: true });
      if (await this.inMerge(cwd)) await this.run(['merge', '--abort'], cwd, true);
    } catch {
      /* what could not be cleaned up is left for the worktree's removal */
    }
  }

  private async pin(path: string): Promise<void> {
    const { stdout } = await exec('git', ['rev-parse', '--absolute-git-dir'], { cwd: path });
    this.pinned.set(resolve(path), stdout.trim());
  }

  static async toplevel(dir: string): Promise<string> {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
    return resolve(stdout.trim());
  }

  /** Keep .braid/ out of `git status` without touching the team's .gitignore. */
  async excludeStateDir(): Promise<void> {
    const { stdout } = await this.run(['rev-parse', '--git-path', 'info/exclude']);
    const path = resolve(this.repo, stdout.trim());
    const current = await readFile(path, 'utf8').catch(() => '');
    if (!current.split(/\r?\n/).includes('.braid/')) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${current.endsWith('\n') || !current ? '' : '\n'}.braid/\n`);
    }
  }

  async currentBranch(): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  }

  async revParse(ref: string, cwd = this.repo): Promise<string> {
    return (await this.run(['rev-parse', ref], cwd)).stdout.trim();
  }

  /**
   * `stoppable: false` for the run's own integration worktree: a Stop there is honoured once git returns, so the run
   * still ends as aborted, with a branch to resume from.
   */
  async addWorktree(path: string, newBranch: string, from: string, stoppable = true): Promise<void> {
    const args = ['worktree', 'add', '-b', newBranch, path, from];
    if (!stoppable) await this.run(args);
    else {
      await this.stoppable(args, this.repo, false, async () => {
        // A killed `worktree add` leaves a locked, half-made worktree and the new branch.
        await this.removeWorktree(path);
        await rm(path, { recursive: true, force: true });
        await this.deleteBranch(newBranch);
      });
    }
    await this.pin(path);
  }

  /** Check out an existing branch into a new worktree. */
  async attachWorktree(path: string, branch: string): Promise<void> {
    await this.run(['worktree', 'prune']);
    await this.run(['worktree', 'add', path, branch]);
    await this.pin(path);
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.run(['rev-parse', '-q', '--verify', `refs/heads/${branch}`], this.repo, true)).code === 0;
  }

  /** Discard untracked files in a harness-owned worktree. */
  async cleanUntracked(cwd: string): Promise<void> {
    await this.run(['clean', '-fdq'], cwd);
  }

  /**
   * Remove a worktree, whatever state it is in. A git killed in the middle of `worktree add` leaves the new worktree
   * locked ("initializing"), which a plain `remove --force` refuses and `prune` skips, so it is unlocked first.
   */
  async removeWorktree(path: string): Promise<void> {
    await this.run(['worktree', 'unlock', path], this.repo, true);
    await this.run(['worktree', 'remove', '--force', '--force', path], this.repo, true);
    await this.run(['worktree', 'prune'], this.repo, true);
    this.pinned.delete(resolve(path));
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.run(['branch', '-D', branch], this.repo, true);
  }

  private async identityArgs(cwd: string): Promise<string[]> {
    const { stdout } = await this.run(['config', 'user.email'], cwd, true);
    return stdout.trim() ? [] : FALLBACK_IDENTITY;
  }

  /** Stage and commit everything in a worktree (concluding an in-progress merge). Returns false when there was nothing to commit. */
  async commitAll(cwd: string, message: string): Promise<boolean> {
    await this.run(['add', '-A'], cwd);
    const { stdout } = await this.run(['status', '--porcelain'], cwd);
    if (!stdout.trim() && !(await this.inMerge(cwd))) return false;
    await this.stoppable([...(await this.identityArgs(cwd)), 'commit', '-q', '-m', message], cwd, false, (t) => this.settle(cwd, t));
    return true;
  }

  async diff(cwd: string, from: string, maxChars = 60_000): Promise<string> {
    const { stdout } = await this.run(['diff', `${from}...HEAD`], cwd);
    return stdout.length > maxChars ? `${stdout.slice(0, maxChars)}\n... (diff truncated)` : stdout;
  }

  async changedFiles(cwd: string, from: string): Promise<string[]> {
    const { stdout } = await this.run(['diff', '--name-only', `${from}...HEAD`], cwd);
    return stdout.split(/\r?\n/).filter(Boolean);
  }

  /** Merge `branch` into whatever `cwd` has checked out. Aborts cleanly on conflict. */
  async merge(cwd: string, branch: string, message: string): Promise<{ ok: boolean; detail: string }> {
    const id = await this.identityArgs(cwd);
    const res = await this.stoppable([...id, 'merge', '--no-ff', '-m', message, branch], cwd, true, (t) => this.settle(cwd, t));
    if (res.code === 0) return { ok: true, detail: res.stdout };
    await this.run(['merge', '--abort'], cwd, true);
    return { ok: false, detail: (res.stdout + res.stderr).trim() };
  }

  async inMerge(cwd: string): Promise<boolean> {
    return (await this.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd, true)).code === 0;
  }

  /**
   * Merge `ref` into the branch checked out in `cwd`. On conflict the merge is left in
   * progress (markers in the files) and the conflicted paths are returned.
   */
  async mergeIn(cwd: string, ref: string, message: string): Promise<{ conflicts: string[] }> {
    const id = await this.identityArgs(cwd);
    const res = await this.stoppable([...id, 'merge', '--no-ff', '-m', message, ref], cwd, true, (t) => this.settle(cwd, t));
    if (res.code === 0) return { conflicts: [] };
    const { stdout } = await this.run(['diff', '--name-only', '--diff-filter=U'], cwd);
    const conflicts = stdout.split(/\r?\n/).filter(Boolean);
    if (!conflicts.length) {
      await this.run(['merge', '--abort'], cwd, true);
      throw new Error(`merge of ${ref} failed without conflicts: ${(res.stdout + res.stderr).trim()}`);
    }
    return { conflicts };
  }

  /** Hard reset a harness-owned worktree (integration branch only). */
  async resetHard(cwd: string, ref: string): Promise<void> {
    await this.run(['reset', '--hard', '-q', ref], cwd);
  }
}
