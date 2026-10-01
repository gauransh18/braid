import { lstat, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Git } from './git.js';
import { exec, pidAlive } from './proc.js';
import { stateRoot } from './store.js';
import type { RunState } from './types.js';

export interface CleanOptions {
  /** Only runs that ended at least this long ago, in milliseconds. */
  olderMs?: number;
  /** Look, print, change nothing. */
  dryRun?: boolean;
  /** Also delete integration branches that are merged into a branch of yours. */
  integration?: boolean;
  /** With `integration`: also the ones that are not merged anywhere else. */
  force?: boolean;
  /** Also delete the run folders under .braid/runs. */
  runs?: boolean;
  now?: number;
}

export interface CleanItem {
  kind: 'worktree' | 'leftover' | 'task branch' | 'integration branch' | 'run folder';
  name: string;
  note?: string;
  outcome: 'removed' | 'would remove' | 'kept' | 'failed';
}

export interface CleanedRun {
  runId: string;
  status: string;
  /** Why nothing of this run was touched. */
  skipped?: string;
  endedMs?: number;
  items: CleanItem[];
}

export interface CleanReport {
  dryRun: boolean;
  now: number;
  runs: CleanedRun[];
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** What a run id may look like. Anything else under .braid is not braid's to delete. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** "7d" or "12h" in milliseconds. */
export function parseAge(text: string): number {
  const m = /^(\d{1,6})([dh])$/.exec(text.trim());
  if (!m) throw new Error(`--older takes a number of days or hours, like 7d or 12h (got "${text}")`);
  return Number(m[1]) * (m[2] === 'd' ? DAY : HOUR);
}

export function formatAge(ms: number): string {
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.max(0, Math.floor(ms / 60_000))}m`;
}

export type Verdict = { clean: true; endedMs?: number } | { clean: false; reason: string };

/**
 * Whether a run's leftovers may go. Only a run that is provably over qualifies: done, failed or aborted, or marked
 * running by a process that no longer exists. A pid that cannot be told apart from a live one (EPERM) counts as live.
 */
export function judgeRun(id: string, state: RunState, mtimeMs: number, now: number, olderMs?: number, alive: (pid: number) => boolean = pidAlive): Verdict {
  if (state.runId !== id) return { clean: false, reason: `state.json belongs to run ${state.runId}` };
  let endedMs: number | undefined;
  if (state.status === 'running') {
    if (!state.pid) return { clean: false, reason: 'marked running, and its process is not recorded' };
    if (alive(state.pid)) return { clean: false, reason: `still running (pid ${state.pid})` };
    endedMs = mtimeMs; // a crashed run never wrote an end time: the last save is the last sign of life
  } else if (state.status === 'done' || state.status === 'failed' || state.status === 'aborted') {
    const t = state.endedAt ? Date.parse(state.endedAt) : NaN;
    endedMs = Number.isFinite(t) ? t : mtimeMs;
  } else {
    return { clean: false, reason: `unknown status "${String(state.status)}"` };
  }
  if (olderMs !== undefined) {
    if (!Number.isFinite(endedMs)) return { clean: false, reason: 'end time unknown' };
    if (now - endedMs < olderMs) return { clean: false, reason: `ended ${formatAge(now - endedMs)} ago, too recent for --older` };
  }
  return { clean: true, endedMs };
}

async function names(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

async function readState(dir: string): Promise<{ state: RunState; mtimeMs: number } | null> {
  const file = join(dir, 'state.json');
  try {
    const [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    const state = JSON.parse(text) as RunState;
    return state && typeof state === 'object' && typeof state.status === 'string' ? { state, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

/** Delete a folder. A symlink is unlinked, never followed: whatever it points at is not braid's. */
const removeDir = (path: string): Promise<void> => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

/** The worktrees git has registered, by real path, with the branch each has checked out: a path can then be told from a leftover folder git no longer knows. */
async function registeredWorktrees(repo: string): Promise<Map<string, string | undefined>> {
  const out = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repo, allowFail: true });
  const found: { path: string; branch?: string }[] = [];
  for (const line of out.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) found.push({ path: line.slice(9) });
    else if (line.startsWith('branch refs/heads/') && found.length) found[found.length - 1]!.branch = line.slice('branch refs/heads/'.length);
  }
  return new Map(await Promise.all(found.map(async (w): Promise<[string, string | undefined]> => [await realpath(w.path).catch(() => resolve(w.path)), w.branch])));
}

interface Branch {
  name: string;
  sha: string;
}

async function branchesOf(repo: string, id: string): Promise<Branch[]> {
  // The pattern is a prefix match up to a slash (the id has no glob characters, see ID_RE); the exact names are checked by the callers.
  const out = await exec('git', ['for-each-ref', '--format=%(objectname) %(refname)', `refs/heads/braid/${id}`], { cwd: repo, allowFail: true });
  return out.stdout.split(/\r?\n/).filter(Boolean).flatMap((l) => {
    const [sha = '', ref = ''] = l.split(' ');
    return ref.startsWith('refs/heads/') ? [{ name: ref.slice('refs/heads/'.length), sha }] : [];
  });
}

/** Branches that hold `sha` and are yours: not a braid branch, which may be about to be deleted too. */
async function mergedInto(repo: string, sha: string): Promise<string[]> {
  const out = await exec('git', ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd: repo, allowFail: true });
  return out.stdout.split(/\r?\n/).filter(Boolean).flatMap((ref) => {
    // origin/main counts (the merge was pushed); a remote's HEAD is only a pointer to a branch.
    const remote = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
    const branch = remote ? remote[2]! : ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';
    return branch && branch !== 'HEAD' && !branch.startsWith('braid/') ? [remote ? `${remote[1]}/${branch}` : branch] : [];
  });
}

/** Delete a branch with `-D`, which git still refuses for one that is checked out in any worktree. */
async function deleteBranch(repo: string, name: string): Promise<{ ok: boolean; why: string }> {
  const res = await exec('git', ['branch', '-D', name], { cwd: repo, allowFail: true });
  return { ok: res.code === 0, why: (res.stderr.trim() || res.stdout.trim()).split(/\r?\n/)[0] ?? '' };
}

async function ahead(repo: string, from: string, to: string): Promise<number> {
  if (from.startsWith('-')) return 0; // a base name out of state.json must not read as an option
  const out = await exec('git', ['rev-list', '--count', `${from}..${to}`], { cwd: repo, allowFail: true });
  return out.code === 0 ? Number(out.stdout.trim()) || 0 : 0;
}

const plural = (n: number, word: string): string => `${n} ${n === 1 ? word : word.endsWith('ch') ? `${word}es` : `${word}s`}`;

/**
 * Remove what finished runs left behind: kept task worktrees and task branches, and on request integration branches
 * that are merged elsewhere and run folders. A run is judged right before its own cleanup, from its state.json at that
 * moment. Runs without a readable state.json are never touched: one that is just starting looks the same.
 */
export async function cleanRepo(repo: string, o: CleanOptions = {}): Promise<CleanReport> {
  const now = o.now ?? Date.now();
  const root = stateRoot(repo);
  const ids = new Set([...(await names(join(root, 'runs'))), ...(await names(join(root, 'worktrees')))]);
  const report: CleanReport = { dryRun: !!o.dryRun, now, runs: [] };
  for (const id of [...ids].sort()) {
    if (!ID_RE.test(id)) continue; // .DS_Store or a stray file: not a run
    report.runs.push(await cleanRun(repo, id, o, now));
  }
  return report;
}

async function cleanRun(repo: string, id: string, o: CleanOptions, now: number): Promise<CleanedRun> {
  const root = stateRoot(repo);
  const runDir = join(root, 'runs', id);
  const wtDir = join(root, 'worktrees', id);
  const out: CleanedRun = { runId: id, status: 'unknown', items: [] };
  const loaded = await readState(runDir);
  let state: RunState | undefined;
  if (loaded) {
    state = loaded.state;
    out.status = state.status;
    const v = judgeRun(id, state, loaded.mtimeMs, now, o.olderMs);
    if (!v.clean) return { ...out, skipped: v.reason };
    out.endedMs = v.endedMs;
  } else if (await exists(runDir)) {
    return { ...out, skipped: 'no readable state.json, so it cannot be told apart from a run that is starting' };
  } else {
    // A run makes its folder before its first worktree, so worktrees without one are left from a deleted run.
    out.status = 'no run folder';
    out.endedMs = (await stat(wtDir).catch(() => null))?.mtimeMs;
    if (o.olderMs !== undefined && (out.endedMs === undefined || now - out.endedMs < o.olderMs)) return { ...out, skipped: 'too recent for --older' };
  }

  const rel = (p: string) => relative(repo, p).split('\\').join('/');
  const dry = !!o.dryRun;
  const act = async (item: Omit<CleanItem, 'outcome'>, run: () => Promise<{ kept?: string } | void>): Promise<void> => {
    if (dry) return void out.items.push({ ...item, outcome: 'would remove' });
    try {
      const res = await run();
      out.items.push(res?.kept ? { ...item, note: [item.note, res.kept].filter(Boolean).join('; '), outcome: 'kept' } : { ...item, outcome: 'removed' });
    } catch (err) {
      out.items.push({ ...item, note: String((err as Error).message ?? err).split('\n')[0], outcome: 'failed' });
    }
  };

  // Worktrees first: git will not delete a branch that is checked out in one.
  const git = new Git(repo);
  const entries = (await readdir(wtDir, { withFileTypes: true }).catch(() => [])).map((e) => e.name).sort();
  const registered = await registeredWorktrees(repo);
  if (entries.length) {
    for (const name of entries) {
      const path = join(wtDir, name);
      // A symlink here could lead to a worktree of yours, which git would remove for it: only the link goes.
      const link = (await lstat(path).catch(() => null))?.isSymbolicLink() ?? false;
      const known = !link && registered.has(await realpath(path).catch(() => resolve(path)));
      await act({ kind: known ? 'worktree' : 'leftover', name: rel(path) }, async () => {
        if (!link) await git.removeWorktree(path);
        if (await exists(path)) await removeDir(path);
      });
    }
    if (!dry) {
      await exec('git', ['worktree', 'prune'], { cwd: repo, allowFail: true });
      await removeDir(wtDir).catch(() => undefined);
    }
  }

  // Whatever is checked out outside this run's folder (your own worktree) keeps its branch: git would refuse anyway,
  // and a dry run should say so too.
  const mine = await realpath(wtDir).catch(() => resolve(wtDir));
  const heldBy = new Map<string, string>();
  for (const [path, branch] of await registeredWorktrees(repo)) if (branch && !path.startsWith(mine + sep)) heldBy.set(branch, path);
  const dropBranch = (kind: 'task branch' | 'integration branch', name: string, note: string): Promise<void> => {
    const holder = heldBy.get(name);
    if (holder) return Promise.resolve(void out.items.push({ kind, name, note: `${note}; checked out at ${holder}`, outcome: 'kept' }));
    return act({ kind, name, note }, async () => {
      const res = await deleteBranch(repo, name);
      if (!res.ok) return { kept: res.why };
    });
  };

  const prefix = `braid/${id}/`;
  const branches = await branchesOf(repo, id);
  const integName = `${prefix}integration`;
  const integTip = branches.find((b) => b.name === integName)?.sha;
  for (const b of branches.filter((b) => b.name.startsWith(`${prefix}task-`))) {
    const unmerged = integTip ? await ahead(repo, integTip, b.sha) : 0;
    await dropBranch('task branch', b.name, `was ${b.sha.slice(0, 7)}${unmerged ? `, ${plural(unmerged, 'commit')} not in the integration branch` : ''}`);
  }

  if (o.integration && integTip) {
    const item = { kind: 'integration branch' as const, name: integName };
    if (state && state.integrationBranch !== integName) {
      out.items.push({ ...item, note: `state.json names ${state.integrationBranch}; left alone`, outcome: 'kept' });
    } else {
      const holders = await mergedInto(repo, integTip);
      const was = `was ${integTip.slice(0, 7)}`;
      if (holders.length) {
        await dropBranch('integration branch', integName, `${was}, merged into ${holders[0]}${holders.length > 1 ? ` and ${holders.length - 1} more` : ''}`);
      } else if (o.force) {
        const count = state ? await ahead(repo, state.base, integTip) : 0;
        await dropBranch('integration branch', integName, `${was}, NOT merged into any other branch${count ? `, ${plural(count, 'commit')} only here` : ''}; deleted because of --force`);
      } else {
        out.items.push({ ...item, note: 'not merged into any other branch of yours; --force deletes it anyway', outcome: 'kept' });
      }
    }
  }

  // Not while something above failed: the folder is what lets the next `braid clean` find this run again.
  if (o.runs && (await exists(runDir)) && !out.items.some((i) => i.outcome === 'failed')) {
    await act({ kind: 'run folder', name: rel(runDir) }, () => removeDir(runDir));
  }
  return out;
}

export function formatClean(report: CleanReport): string {
  const lines: string[] = [];
  if (report.dryRun) lines.push('dry run: nothing is changed');
  const counts = new Map<string, number>();
  let kept = 0;
  let failed = 0;
  for (const run of report.runs) {
    if (run.skipped) {
      lines.push(`run ${run.runId}: skipped, ${run.skipped}`);
      continue;
    }
    if (!run.items.length) continue;
    lines.push(`run ${run.runId} (${run.status}${run.endedMs !== undefined ? `, ended ${formatAge(report.now - run.endedMs)} ago` : ''})`);
    for (const i of run.items) {
      const verb = i.outcome === 'failed' ? 'FAILED to remove' : i.outcome;
      lines.push(`  ${verb} ${i.kind} ${i.name}${i.note ? `  (${i.note})` : ''}`);
      if (i.outcome === 'kept') kept++;
      else if (i.outcome === 'failed') failed++;
      else counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
    }
  }
  const parts = [...counts].map(([kind, n]) => plural(n, kind));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const tail = [kept ? `${kept} kept` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ');
  if (!total && !kept && !failed) lines.push('nothing to clean');
  else lines.push(`${report.dryRun ? 'would remove' : 'removed'}: ${parts.join(', ') || 'nothing'}${tail ? `; ${tail}` : ''}`);
  return lines.join('\n');
}

export interface CleanFlags {
  older?: string;
  dryRun?: boolean;
  integration?: boolean;
  force?: boolean;
  runs?: boolean;
}

/** `braid clean`. Exits 1 only when something that should have gone could not be removed. */
export async function cleanCommand(repo: string, arg: string | undefined, flags: CleanFlags, log: (line: string) => void = console.log): Promise<number> {
  if (arg) throw new Error(`clean takes no run id (got "${arg}"); it cleans every finished run, and --older limits it by age`);
  if (flags.force && !flags.integration) throw new Error('--force only goes with --integration');
  const report = await cleanRepo(repo, {
    olderMs: flags.older !== undefined ? parseAge(flags.older) : undefined,
    dryRun: flags.dryRun,
    integration: flags.integration,
    force: flags.force,
    runs: flags.runs,
  });
  log(formatClean(report));
  return report.runs.some((r) => r.items.some((i) => i.outcome === 'failed')) ? 1 : 0;
}
