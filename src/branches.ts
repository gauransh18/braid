import { exec } from './proc.js';
import type { RunState } from './types.js';

/** Git subcommands the branch view may run. Every one only reads; nothing here can move a ref, touch the index or rewrite history. */
const READ_ONLY = new Set(['for-each-ref', 'rev-parse', 'rev-list', 'merge-base', 'log', 'diff']);

async function git(repo: string, args: string[]): Promise<{ code: number; out: string }> {
  if (!READ_ONLY.has(args[0] ?? '')) throw new Error(`branch view refuses to run git ${args[0]}`);
  // --no-optional-locks: even the opportunistic index refresh git does for some commands is off.
  const res = await exec('git', ['--no-optional-locks', ...args], { cwd: repo, allowFail: true });
  return { code: res.code, out: res.stdout.trim() };
}

export interface BranchCommit {
  sha: string;
  subject: string;
}

export interface BranchInfo {
  task: string;
  name: string;
  /** False once the branch was deleted (a retry starts a fresh branch) or the repo was cleaned up. */
  exists: boolean;
  tip?: string;
  /** True when everything on the branch is reachable from the integration branch. */
  merged: boolean;
  commits: BranchCommit[];
  files?: number;
  insertions?: number;
  deletions?: number;
}

export interface BranchReport {
  base: string;
  integration: { name: string; exists: boolean; head?: string; commitsAhead?: number };
  branches: BranchInfo[];
}

/**
 * What the run's git branches look like right now, for the dashboard. Read-only by construction: see READ_ONLY.
 * Branch history of what happened over time (merged, rolled back, retried) comes from the event log, not from git.
 */
export async function readBranches(repo: string, state: RunState): Promise<BranchReport> {
  const integ = state.integrationBranch;
  const head = await git(repo, ['rev-parse', '-q', '--verify', `refs/heads/${integ}`]);
  const report: BranchReport = { base: state.base, integration: { name: integ, exists: head.code === 0, head: head.out.slice(0, 8) || undefined }, branches: [] };
  if (head.code === 0) {
    const ahead = await git(repo, ['rev-list', '--count', `${state.base}..${integ}`]);
    if (ahead.code === 0) report.integration.commitsAhead = Number(ahead.out);
  }
  for (const t of Object.values(state.tasks)) {
    if (!t.branch) continue;
    const ref = `refs/heads/${t.branch}`;
    const tip = await git(repo, ['rev-parse', '-q', '--verify', ref]);
    const info: BranchInfo = { task: t.id, name: t.branch, exists: tip.code === 0, merged: false, commits: [] };
    if (tip.code === 0) {
      info.tip = tip.out.slice(0, 8);
      if (head.code === 0) info.merged = (await git(repo, ['merge-base', '--is-ancestor', ref, `refs/heads/${integ}`])).code === 0;
      const fork = await git(repo, ['merge-base', state.base, ref]);
      if (fork.code === 0 && fork.out) {
        const log = await git(repo, ['log', '--format=%h%x09%s', '-n', '8', `${fork.out}..${ref}`]);
        info.commits = log.out.split('\n').filter(Boolean).map((l) => {
          const [sha = '', ...rest] = l.split('\t');
          return { sha, subject: rest.join('\t') };
        });
        const stat = await git(repo, ['diff', '--shortstat', `${fork.out}..${ref}`]);
        const m = (re: RegExp) => Number(re.exec(stat.out)?.[1] ?? 0);
        info.files = m(/(\d+) files? changed/);
        info.insertions = m(/(\d+) insertions?/);
        info.deletions = m(/(\d+) deletions?/);
      }
    }
    report.branches.push(info);
  }
  return report;
}
