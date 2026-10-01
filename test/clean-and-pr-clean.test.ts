import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { cleanRepo, formatAge, judgeRun, parseAge, type CleanReport } from '../src/clean.js';
import type { RunState } from '../src/types.js';
import { deadPid, git, gitOut, makeRepo, makeRun, tmp } from './clean-and-pr-fixtures.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const DAY = 86_400_000;

const branches = async (repo: string) => (await gitOut(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n').filter(Boolean).sort();
const worktreeList = async (repo: string) => gitOut(repo, 'worktree', 'list', '--porcelain');
/** Every file and folder under .braid, so "nothing changed" can be checked as a whole. */
function tree(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return [p.slice(base.length), ...(e.isDirectory() ? tree(p, base) : [])];
  });
}
const itemsOf = (r: CleanReport, id: string) => r.runs.find((x) => x.runId === id)?.items ?? [];
const names = (r: CleanReport, id: string) => itemsOf(r, id).map((i) => i.name);

/** One run of each kind, plus branches that are yours. */
async function scenario() {
  const repo = await makeRepo();
  const alive = '20260101-000000-live';
  const done = '20260101-000001-done';
  const failed = '20260101-000002-fail';
  const crashed = '20260101-000003-dead';
  await makeRun(repo, done, { status: 'done', kept: ['a', 'b'], integrationCommits: 2 });
  await makeRun(repo, failed, { status: 'failed', kept: ['z'], integrationCommits: 1, taskCommits: { z: 2 } });
  await makeRun(repo, crashed, { status: 'running', pid: await deadPid(), kept: ['c'], integrationWorktree: true, integrationCommits: 1 });
  await makeRun(repo, alive, { status: 'running', pid: process.pid, kept: ['x'], integrationWorktree: true, integrationCommits: 1 });
  for (const b of ['feature/keep', 'braid-user', 'braid/mine']) await git(repo, 'branch', b, 'main');
  return { repo, alive, done, failed, crashed };
}

describe('braid clean: which runs', () => {
  it('reads --older as days or hours and nothing else', () => {
    assert.equal(parseAge('7d'), 7 * DAY);
    assert.equal(parseAge('12h'), 12 * 3_600_000);
    assert.equal(parseAge('0d'), 0);
    for (const bad of ['', '7', 'd', '7w', '-1d', '1.5d', '7 d x', 'seven']) assert.throws(() => parseAge(bad), /--older takes/, bad);
    assert.equal(formatAge(3 * DAY + 5), '3d');
    assert.equal(formatAge(5 * 3_600_000), '5h');
    assert.equal(formatAge(90_000), '1m');
  });

  it('only a run that is provably over qualifies', () => {
    const state = (extra: Partial<RunState>): RunState => ({ runId: 'r', repo: '/', base: 'main', integrationBranch: 'braid/r/integration', status: 'done', costUsd: 0, createdAt: '', tasks: {}, ...extra });
    const now = Date.parse('2026-02-01T00:00:00Z');
    const j = (s: Partial<RunState>, older?: number, alive = (_pid: number) => false) => judgeRun('r', state(s), now - DAY, now, older, alive);
    for (const status of ['done', 'failed', 'aborted'] as const) assert.equal(j({ status }).clean, true, status);
    assert.equal(j({ status: 'running', pid: 4242 }).clean, true, 'its process is gone');
    assert.deepEqual(j({ status: 'running', pid: 4242 }, undefined, () => true), { clean: false, reason: 'still running (pid 4242)' });
    assert.equal(j({ status: 'running' }).clean, false, 'no pid recorded: cannot tell it is dead');
    assert.equal(j({ status: 'weird' as never }).clean, false);
    assert.equal(judgeRun('other', state({}), 0, now).clean, false, 'a state.json that names another run');
    // --older counts from the end; a crashed run has none, so from its last save.
    assert.equal(j({ endedAt: '2026-01-30T00:00:00Z' }, 7 * DAY).clean, false);
    assert.equal(j({ endedAt: '2026-01-20T00:00:00Z' }, 7 * DAY).clean, true);
    assert.equal(j({ status: 'running', pid: 1 }, 7 * DAY).clean, false, 'last saved a day ago');
    assert.equal(j({ endedAt: 'not a date' }, 7 * DAY).clean, false, 'falls back to the file time, which is a day old');
  });
});

describe('braid clean', () => {
  it('removes the worktrees and task branches of finished runs, and nothing that is yours or a live run', async () => {
    const { repo, alive, done, failed, crashed } = await scenario();
    const integrations = (await branches(repo)).filter((b) => b.endsWith('/integration'));
    assert.equal(integrations.length, 4);

    const report = await cleanRepo(repo);

    assert.deepEqual(names(report, done), [`.braid/worktrees/${done}/a`, `.braid/worktrees/${done}/b`, `braid/${done}/task-a`, `braid/${done}/task-b`]);
    assert.deepEqual(itemsOf(report, done).map((i) => i.kind), ['worktree', 'worktree', 'task branch', 'task branch']);
    assert.ok(itemsOf(report, failed).some((i) => i.name === `braid/${failed}/task-z` && /2 commits not in the integration branch/.test(i.note ?? '')), 'says what is lost with an unmerged branch');
    assert.ok(itemsOf(report, crashed).some((i) => i.name.endsWith('/_integration')), 'a crashed run leaves its integration worktree');
    assert.equal(report.runs.find((r) => r.runId === alive)?.skipped, `still running (pid ${process.pid})`);
    assert.ok(itemsOf(report, alive).length === 0);

    const after = await branches(repo);
    for (const b of integrations) assert.ok(after.includes(b), `${b} survives`);
    for (const b of ['main', 'feature/keep', 'braid-user', 'braid/mine']) assert.ok(after.includes(b), `${b} survives`);
    assert.deepEqual(after.filter((b) => b.includes('/task-')), [`braid/${alive}/task-x`], 'only the live run keeps its task branch');
    for (const id of [done, failed, crashed, alive]) assert.ok(existsSync(join(repo, '.braid', 'runs', id, 'state.json')), `run folder of ${id} survives`);
    assert.ok(existsSync(join(repo, '.braid', 'worktrees', alive, 'x')), 'the live run keeps its worktree');
    assert.ok(existsSync(join(repo, '.braid', 'worktrees', alive, '_integration')));
    assert.ok(!existsSync(join(repo, '.braid', 'worktrees', done)));
    assert.ok(!existsSync(join(repo, '.braid', 'worktrees', crashed)));
    const listed = await worktreeList(repo);
    assert.ok(!listed.includes(done) && !listed.includes(failed) && !listed.includes(crashed), 'git no longer lists them');
    assert.ok(listed.includes(alive), 'git still lists the live run');
  });

  it('--dry-run prints what would go and changes nothing', async () => {
    const { repo } = await scenario();
    const before = { branches: await branches(repo), worktrees: await worktreeList(repo), tree: tree(join(repo, '.braid')), refs: await gitOut(repo, 'for-each-ref') };
    const report = await cleanRepo(repo, { dryRun: true, integration: true, force: true, runs: true });
    assert.equal(report.dryRun, true);
    const all = report.runs.flatMap((r) => r.items);
    assert.ok(all.length > 8, 'it lists plenty');
    assert.ok(all.every((i) => i.outcome === 'would remove'), 'every line is a promise, not an action');
    assert.deepEqual(
      { branches: await branches(repo), worktrees: await worktreeList(repo), tree: tree(join(repo, '.braid')), refs: await gitOut(repo, 'for-each-ref') },
      before,
    );
  });

  it('never touches a run whose process is alive, whatever the flags', async () => {
    const repo = await makeRepo();
    const id = '20260101-000009-live';
    await makeRun(repo, id, { status: 'running', pid: process.pid, kept: ['x', 'y'], integrationWorktree: true, integrationCommits: 1 });
    // Merge it into main: even "merged" does not make a live run's integration branch fair game.
    await git(repo, 'merge', '--ff-only', `braid/${id}/integration`);
    const before = { branches: await branches(repo), worktrees: await worktreeList(repo), tree: tree(join(repo, '.braid')) };
    const report = await cleanRepo(repo, { integration: true, force: true, runs: true, olderMs: 0 });
    assert.equal(report.runs[0]!.skipped, `still running (pid ${process.pid})`);
    assert.deepEqual({ branches: await branches(repo), worktrees: await worktreeList(repo), tree: tree(join(repo, '.braid')) }, before);
  });

  it('leaves a run alone when it cannot tell whether it is starting', async () => {
    const repo = await makeRepo();
    const id = '20260101-000008-new';
    // A run makes its folder and its integration worktree before it saves state.json for the first time.
    await makeRun(repo, id, { noState: true, kept: [], integrationWorktree: true });
    const before = { branches: await branches(repo), worktrees: await worktreeList(repo), tree: tree(join(repo, '.braid')) };
    const report = await cleanRepo(repo, { integration: true, force: true, runs: true });
    assert.match(report.runs[0]!.skipped!, /no readable state\.json/);
    assert.deepEqual({ branches: await branches(repo), worktrees: await worktreeList(repo), tree: tree(join(repo, '.braid')) }, before);
    // Nor one whose state.json is damaged.
    writeFileSync(join(repo, '.braid', 'runs', id, 'state.json'), '{"status": "done"');
    assert.match((await cleanRepo(repo)).runs[0]!.skipped!, /no readable state\.json/);
  });

  it('--older keeps recent runs', async () => {
    const repo = await makeRepo();
    const old = '20260101-000001-old';
    const recent = '20260101-000002-new';
    const ended = (days: number) => new Date(Date.now() - days * DAY).toISOString();
    await makeRun(repo, old, { kept: ['a'], endedAt: ended(10) });
    await makeRun(repo, recent, { kept: ['a'], endedAt: ended(1) });
    const report = await cleanRepo(repo, { olderMs: parseAge('7d') });
    assert.equal(itemsOf(report, old).length, 2);
    assert.match(report.runs.find((r) => r.runId === recent)!.skipped!, /^ended 1d ago, too recent/);
    assert.ok(existsSync(join(repo, '.braid', 'worktrees', recent, 'a')));
    assert.ok((await branches(repo)).includes(`braid/${recent}/task-a`));
    assert.ok(!(await branches(repo)).includes(`braid/${old}/task-a`));
    // Hours count too.
    assert.equal(itemsOf(await cleanRepo(repo, { olderMs: parseAge('20h'), dryRun: true }), recent).length, 2);
    assert.equal(itemsOf(await cleanRepo(repo, { olderMs: parseAge('30h'), dryRun: true }), recent).length, 0);
  });

  it('cleans up what git no longer knows about, and worktrees whose run folder is gone', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-done';
    await makeRun(repo, id, { kept: ['a'] });
    // A worktree directory git has forgotten (pruned, or removal that stopped half way).
    mkdirSync(join(repo, '.braid', 'worktrees', id, 'stray', 'node_modules'), { recursive: true });
    writeFileSync(join(repo, '.braid', 'worktrees', id, 'stray', 'node_modules', 'x.js'), '1');
    // A deleted run's worktrees.
    const gone = '20260101-000002-gone';
    await makeRun(repo, gone, { kept: ['a'], status: 'failed' });
    rmSync(join(repo, '.braid', 'runs', gone), { recursive: true });
    // Not a run at all.
    writeFileSync(join(repo, '.braid', 'runs', '.DS_Store'), '');

    const report = await cleanRepo(repo);
    assert.deepEqual(itemsOf(report, id).map((i) => i.kind), ['worktree', 'leftover', 'task branch']);
    assert.equal(report.runs.find((r) => r.runId === gone)?.status, 'no run folder');
    assert.equal(itemsOf(report, gone).length, 2);
    assert.ok(!existsSync(join(repo, '.braid', 'worktrees', id)));
    assert.ok(!existsSync(join(repo, '.braid', 'worktrees', gone)));
    assert.ok(!report.runs.some((r) => r.runId === '.DS_Store'));
    assert.ok(!(await worktreeList(repo)).includes('.braid'), 'no stale worktree entries');
  });

  it('keeps a task branch somebody has checked out, and their worktree', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-done';
    await makeRun(repo, id, { kept: ['a', 'b'] });
    await git(repo, 'worktree', 'remove', '--force', join(repo, '.braid', 'worktrees', id, 'a'));
    const mine = join(tmp('braid-mine-'), 'wt');
    await git(repo, 'worktree', 'add', mine, `braid/${id}/task-a`);
    const dry = await cleanRepo(repo, { dryRun: true });
    assert.equal(itemsOf(dry, id).find((i) => i.name === `braid/${id}/task-a`)!.outcome, 'kept', 'a dry run knows too');
    assert.equal(itemsOf(dry, id).find((i) => i.name === `braid/${id}/task-b`)!.outcome, 'would remove');
    const report = await cleanRepo(repo);
    const a = itemsOf(report, id).find((i) => i.name === `braid/${id}/task-a`)!;
    assert.equal(a.outcome, 'kept');
    assert.match(a.note!, /checked out at /);
    assert.ok((await branches(repo)).includes(`braid/${id}/task-a`));
    assert.ok(existsSync(join(mine, 'README.md')), 'their worktree is intact');
    assert.ok(!(await branches(repo)).includes(`braid/${id}/task-b`), 'the rest still goes');
    assert.equal(report.runs.flatMap((r) => r.items).filter((i) => i.outcome === 'failed').length, 0, 'keeping it is not a failure');
  });

  it('removes a link under a run, not what it points at', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-done';
    await makeRun(repo, id, { kept: [] });
    // Your own worktree and your own folder, reachable from inside .braid/worktrees.
    const mine = join(tmp('braid-mine-'), 'wt');
    await git(repo, 'worktree', 'add', '-b', 'feature/mine', mine, 'main');
    const folder = tmp('braid-folder-');
    writeFileSync(join(folder, 'precious.txt'), 'keep');
    symlinkSync(mine, join(repo, '.braid', 'worktrees', id, 'link-to-worktree'), 'dir');
    symlinkSync(folder, join(repo, '.braid', 'worktrees', id, 'link-to-folder'), 'dir');

    const report = await cleanRepo(repo);
    assert.deepEqual(itemsOf(report, id).map((i) => i.kind), ['leftover', 'leftover']);
    assert.ok(!existsSync(join(repo, '.braid', 'worktrees', id, 'link-to-worktree')));
    assert.ok(existsSync(join(mine, 'README.md')), 'your worktree is intact');
    assert.ok((await worktreeList(repo)).includes('branch refs/heads/feature/mine'), 'git still lists your worktree');
    assert.ok(existsSync(join(folder, 'precious.txt')));
    assert.ok((await branches(repo)).includes('feature/mine'));
  });
});

describe('braid clean --integration', () => {
  it('deletes an integration branch only when another branch of yours holds all of it', async () => {
    const repo = await makeRepo();
    const merged = '20260101-000001-merged';
    const unmerged = '20260101-000002-unmerged';
    await makeRun(repo, merged, { kept: ['a'], integrationCommits: 2 });
    await makeRun(repo, unmerged, { kept: ['a'], integrationCommits: 3 });
    // The first run's work went into main, as it would after a pull request.
    await git(repo, 'merge', '--ff-only', `braid/${merged}/integration`);

    const report = await cleanRepo(repo, { integration: true });
    const m = itemsOf(report, merged).find((i) => i.kind === 'integration branch')!;
    const u = itemsOf(report, unmerged).find((i) => i.kind === 'integration branch')!;
    assert.equal(m.outcome, 'removed');
    assert.match(m.note!, /merged into main/);
    assert.equal(u.outcome, 'kept');
    assert.match(u.note!, /not merged into any other branch/);
    const after = await branches(repo);
    assert.ok(!after.includes(`braid/${merged}/integration`));
    assert.ok(after.includes(`braid/${unmerged}/integration`), 'unmerged work survives --integration');
    assert.ok(after.includes('main'));
    assert.ok(existsSync(join(repo, '.braid', 'runs', merged)), 'run folders are not touched without --runs');
  });

  it('does not count a braid branch, which may be deleted too, as the place the work lives', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-x';
    await makeRun(repo, id, { kept: ['a'], integrationCommits: 2, taskCommits: { a: 1 } });
    // The kept task branch forked from the integration branch, so it holds all of it; so does a branch of braid's under another name.
    await git(repo, 'branch', 'braid/other/integration', `braid/${id}/integration`);
    // And so does a remote-tracking branch for a pushed braid branch.
    await git(repo, 'update-ref', 'refs/remotes/origin/braid/pushed', `braid/${id}/integration`);
    const report = await cleanRepo(repo, { integration: true });
    assert.equal(itemsOf(report, id).find((i) => i.kind === 'integration branch')!.outcome, 'kept');
    assert.ok((await branches(repo)).includes(`braid/${id}/integration`));
    // A remote-tracking branch that is not braid's does count: the work is on the remote.
    const tip = await gitOut(repo, 'rev-parse', '--short=7', `braid/${id}/integration`);
    await git(repo, 'update-ref', 'refs/remotes/origin/main', `braid/${id}/integration`);
    const item = itemsOf(await cleanRepo(repo, { integration: true }), id).find((i) => i.kind === 'integration branch')!;
    assert.equal(item.note, `was ${tip}, merged into origin/main`);
    assert.equal(item.outcome, 'removed');
  });

  it('--force deletes an unmerged one, and says so', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-x';
    await makeRun(repo, id, { status: 'failed', kept: ['a'], integrationCommits: 3 });
    const tip = (await gitOut(repo, 'rev-parse', '--short=7', `braid/${id}/integration`));
    const dry = await cleanRepo(repo, { integration: true, force: true, dryRun: true });
    const item = itemsOf(dry, id).find((i) => i.kind === 'integration branch')!;
    assert.equal(item.outcome, 'would remove');
    assert.equal(item.note, `was ${tip}, NOT merged into any other branch, 3 commits only here; deleted because of --force`);
    assert.ok((await branches(repo)).includes(`braid/${id}/integration`), 'a dry run deletes nothing');
    const real = await cleanRepo(repo, { integration: true, force: true });
    assert.equal(itemsOf(real, id).find((i) => i.kind === 'integration branch')!.outcome, 'removed');
    assert.ok(!(await branches(repo)).includes(`braid/${id}/integration`));
    assert.equal(await gitOut(repo, 'cat-file', '-t', tip), 'commit', 'the commits are still in the repository, reachable by the sha printed');
  });

  it('keeps an integration branch that is checked out, even with --force', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-x';
    await makeRun(repo, id, { kept: [], integrationCommits: 1 });
    const mine = join(tmp('braid-mine-'), 'wt');
    await git(repo, 'worktree', 'add', mine, `braid/${id}/integration`);
    const report = await cleanRepo(repo, { integration: true, force: true });
    assert.equal(itemsOf(report, id).find((i) => i.kind === 'integration branch')!.outcome, 'kept');
    assert.ok((await branches(repo)).includes(`braid/${id}/integration`));
  });

  it('does not delete a branch a tampered state.json points at', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-x';
    await makeRun(repo, id, { kept: ['a'] });
    await git(repo, 'branch', 'feature/precious', 'main');
    const file = join(repo, '.braid', 'runs', id, 'state.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.integrationBranch = 'feature/precious';
    writeFileSync(file, JSON.stringify(state));
    const report = await cleanRepo(repo, { integration: true, force: true });
    assert.ok((await branches(repo)).includes('feature/precious'));
    assert.equal(itemsOf(report, id).find((i) => i.kind === 'integration branch')!.outcome, 'kept');
  });
});

describe('braid clean --runs', () => {
  it('deletes the run folders of the runs it cleans, and only those', async () => {
    const { repo, alive, done, failed, crashed } = await scenario();
    const report = await cleanRepo(repo, { runs: true });
    for (const id of [done, failed, crashed]) {
      assert.ok(itemsOf(report, id).some((i) => i.kind === 'run folder' && i.outcome === 'removed'), id);
      assert.ok(!existsSync(join(repo, '.braid', 'runs', id)), id);
    }
    assert.ok(existsSync(join(repo, '.braid', 'runs', alive, 'state.json')));
    assert.ok((await branches(repo)).includes(`braid/${done}/integration`), 'integration branches stay without --integration');
    assert.ok(!(await branches(repo)).some((b) => b.startsWith(`braid/${done}/task-`)));
  });
});

describe('braid clean on the command line', () => {
  const cli = (repo: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8' });

  it('prints what it did and a summary, and a dry run changes nothing', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-done';
    await makeRun(repo, id, { kept: ['a', 'b'], integrationCommits: 1 });
    const before = await branches(repo);
    const dry = cli(repo, 'clean', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /^dry run: nothing is changed/);
    assert.match(dry.stdout, new RegExp(`would remove worktree .braid/worktrees/${id}/a`));
    assert.match(dry.stdout, /would remove: 2 worktrees, 2 task branches/);
    assert.deepEqual(await branches(repo), before);

    const real = cli(repo, 'clean');
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout, new RegExp(`removed task branch braid/${id}/task-a  \\(was [0-9a-f]{7}\\)`));
    assert.match(real.stdout, /removed: 2 worktrees, 2 task branches\n$/);
    assert.deepEqual(await branches(repo), [`braid/${id}/integration`, 'main']);
    assert.equal(cli(repo, 'clean').stdout, 'nothing to clean\n');
  });

  it('refuses what it cannot do safely', async () => {
    const repo = await makeRepo();
    for (const [args, message] of [
      [['clean', '--older', '7'], /--older takes a number of days or hours/],
      [['clean', '--force'], /--force only goes with --integration/],
      [['clean', '20260101-000001-done'], /clean takes no run id/],
    ] as const) {
      const res = cli(repo, ...args);
      assert.equal(res.status, 1, args.join(' '));
      assert.match(res.stderr, message);
    }
    assert.match(cli(repo, '--help').stdout, /braid clean \[--older 7d\|12h\] \[--dry-run\] \[--integration \[--force\]\] \[--runs\]/);
    assert.match(cli(repo, '--help').stdout, /braid pr \[runId\] \[--base BRANCH\] \[--draft\] \[--remote origin\] \[--dry-run\] \[--allow-partial\]/);
  });
});
