import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { exec } from './proc.js';

const FALLBACK_IDENTITY = ['-c', 'user.name=braid', '-c', 'user.email=braid@localhost'];

/** Thin wrapper over git. The harness only ever writes to branches it created. */
export class Git {
  constructor(readonly repo: string) {}

  /**
   * Worktrees this object created, with the git directory recorded at creation. A task's worktree is mounted into a
   * sandbox container that can rewrite its `.git` pointer file, and git trusts that file to find the repository (and
   * its config, which can name a program to run). Host-side git therefore never discovers the repository from a
   * worktree: it is told where it is.
   */
  private pinned = new Map<string, string>();

  async run(args: string[], cwd = this.repo, allowFail = false) {
    const gitDir = this.pinned.get(resolve(cwd));
    const pin = gitDir ? ['--git-dir', gitDir, '--work-tree', resolve(cwd), '-c', 'core.fsmonitor=false'] : [];
    return exec('git', [...pin, ...args], { cwd, allowFail });
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

  async addWorktree(path: string, newBranch: string, from: string): Promise<void> {
    await this.run(['worktree', 'add', '-b', newBranch, path, from]);
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
    await this.run([...(await this.identityArgs(cwd)), 'commit', '-q', '-m', message], cwd);
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
    const res = await this.run([...id, 'merge', '--no-ff', '-m', message, branch], cwd, true);
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
    const res = await this.run([...id, 'merge', '--no-ff', '-m', message, ref], cwd, true);
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
