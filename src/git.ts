import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { exec } from './proc.js';

const FALLBACK_IDENTITY = ['-c', 'user.name=braid', '-c', 'user.email=braid@localhost'];

/** Thin wrapper over git. The harness only ever writes to branches it created. */
export class Git {
  constructor(readonly repo: string) {}

  async run(args: string[], cwd = this.repo, allowFail = false) {
    return exec('git', args, { cwd, allowFail });
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
  }

  async removeWorktree(path: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', path], this.repo, true);
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.run(['branch', '-D', branch], this.repo, true);
  }

  private async identityArgs(cwd: string): Promise<string[]> {
    const { stdout } = await this.run(['config', 'user.email'], cwd, true);
    return stdout.trim() ? [] : FALLBACK_IDENTITY;
  }

  /** Stage and commit everything in a worktree. Returns false when there was nothing to commit. */
  async commitAll(cwd: string, message: string): Promise<boolean> {
    await this.run(['add', '-A'], cwd);
    const { stdout } = await this.run(['status', '--porcelain'], cwd);
    if (!stdout.trim()) return false;
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

  /** Hard reset a harness-owned worktree (integration branch only). */
  async resetHard(cwd: string, ref: string): Promise<void> {
    await this.run(['reset', '--hard', '-q', ref], cwd);
  }
}
