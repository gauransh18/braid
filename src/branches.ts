import { exec } from './proc.js';
import type { RunState } from './types.js';

/** Git subcommands the branch view may run. Every one only reads; nothing here can move a ref, touch the index or rewrite history. */
const READ_ONLY = new Set(['for-each-ref', 'rev-parse', 'rev-list', 'merge-base', 'log', 'diff', 'remote']);

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

export interface HistoryRef {
  name: string;
  /** local branch, remote-tracking branch (what GitHub had at the last fetch), or tag */
  kind: 'local' | 'remote' | 'tag';
  head?: boolean;
}

export interface HistoryCommit {
  sha: string;
  parents: string[];
  author: string;
  /** Unix seconds. */
  ts: number;
  subject: string;
  refs: HistoryRef[];
}

export interface HistoryPage {
  commits: HistoryCommit[];
  hasMore: boolean;
  remotes: { name: string; url: string }[];
  head?: string;
}

const SEP = '\x1f';

/** One page of the repo's whole commit graph: every local branch, remote-tracking branch and tag, newest first. Read-only. */
export async function readHistory(repo: string, skip = 0, limit = 300): Promise<HistoryPage> {
  limit = Math.min(Math.max(1, limit), 1000);
  const log = await git(repo, [
    'log', '--branches', '--remotes', '--tags', '--topo-order', '--decorate=full',
    `--skip=${Math.max(0, skip)}`, `-n`, String(limit + 1),
    `--format=%H${SEP}%P${SEP}%an${SEP}%at${SEP}%s${SEP}%D`,
  ]);
  const rows = log.code === 0 ? log.out.split('\n').filter(Boolean) : [];
  const commits = rows.slice(0, limit).map((line): HistoryCommit => {
    const [sha = '', parents = '', author = '', at = '0', subject = '', deco = ''] = line.split(SEP);
    const refs: HistoryRef[] = [];
    for (const raw of deco.split(', ').filter(Boolean)) {
      let name = raw;
      let head = false;
      if (name.startsWith('HEAD -> ')) { head = true; name = name.slice(8); }
      if (name === 'HEAD') continue;
      if (name.startsWith('tag: refs/tags/')) refs.push({ name: name.slice(15), kind: 'tag' });
      else if (name.startsWith('refs/heads/')) refs.push({ name: name.slice(11), kind: 'local', head });
      else if (name.startsWith('refs/remotes/') && !name.endsWith('/HEAD')) refs.push({ name: name.slice(13), kind: 'remote' });
    }
    return { sha, parents: parents.split(' ').filter(Boolean), author, ts: Number(at), subject, refs };
  });
  const remotesOut = await git(repo, ['remote', '-v']);
  const remotes = new Map<string, string>();
  for (const l of remotesOut.out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(l);
    if (m) remotes.set(m[1]!, m[2]!);
  }
  const head = await git(repo, ['rev-parse', '-q', '--verify', 'HEAD']);
  return { commits, hasMore: rows.length > limit, remotes: [...remotes].map(([name, url]) => ({ name, url })), head: head.out.slice(0, 40) || undefined };
}

/**
 * Bring in what the remotes have. This is the one write in this file, and it is a narrow one: `git fetch` only
 * adds objects and moves remote-tracking refs (origin/main and friends). It never touches a local branch, the
 * working tree, the index or any commit you already have. No prune, so nothing is ever deleted. It never prompts.
 */
export async function fetchRemotes(repo: string): Promise<{ updated: { name: string; from?: string; to: string }[]; remotes: number }> {
  const snap = async () => {
    const r = await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes', 'refs/tags']);
    return new Map(r.out.split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]).filter(([n]) => !n.endsWith('/HEAD')).map(([n, sha]): [string, string] => [n.replace(/^refs\/(remotes|tags)\//, ''), sha]));
  };
  const remotes = (await git(repo, ['remote'])).out.split('\n').filter(Boolean);
  if (!remotes.length) throw new Error('This repo has no remote to fetch from.');
  const before = await snap();
  const res = await exec('git', ['--no-optional-locks', '-c', 'core.askPass=', 'fetch', '--all', '--no-write-fetch-head'], {
    cwd: repo, allowFail: true, timeoutMs: 90_000, env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' },
  });
  if (res.code !== 0) throw new Error(`git fetch failed: ${(res.stderr.trim() || res.stdout.trim() || 'timed out').split('\n').slice(-3).join(' ')}`);
  const after = await snap();
  const updated = [...after].filter(([n, sha]) => before.get(n) !== sha).map(([name, to]) => ({ name, from: before.get(name)?.slice(0, 8), to: to.slice(0, 8) }));
  return { updated, remotes: remotes.length };
}
