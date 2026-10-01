import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cleanCommand, cleanRepo, type CleanReport } from '../src/clean.js';
import { git, gitOut, makeRepo, makeRun, tmp } from './clean-and-pr-fixtures.js';

const branches = async (repo: string) => (await gitOut(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n').filter(Boolean).sort();
const itemsOf = (r: CleanReport, id: string) => r.runs.find((x) => x.runId === id)?.items ?? [];
const runFolder = (repo: string, id: string) => join(repo, '.braid', 'runs', id);

describe('braid clean --runs keeps a run whose branches are still there', () => {
  it('does not delete the folder of a run whose unmerged integration branch --integration kept', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-done';
    await makeRun(repo, id, { kept: ['a'], integrationCommits: 2 });

    const report = await cleanRepo(repo, { runs: true, integration: true });
    assert.equal(itemsOf(report, id).find((i) => i.kind === 'integration branch')!.outcome, 'kept');
    assert.ok((await branches(repo)).includes(`braid/${id}/integration`));
    assert.ok(existsSync(join(runFolder(repo, id), 'state.json')), '`braid pr` and `braid resume` still need it');
    assert.ok(!itemsOf(report, id).some((i) => i.kind === 'run folder'));

    // The branch the note advertises --force for can still be found, and goes together with the run.
    const forced = await cleanRepo(repo, { runs: true, integration: true, force: true });
    assert.equal(itemsOf(forced, id).find((i) => i.kind === 'integration branch')!.outcome, 'removed');
    assert.equal(itemsOf(forced, id).find((i) => i.kind === 'run folder')!.outcome, 'removed');
    assert.ok(!(await branches(repo)).includes(`braid/${id}/integration`));
    assert.ok(!existsSync(runFolder(repo, id)));
  });

  it('does not delete the folder while a task branch somebody has checked out is kept', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-done';
    await makeRun(repo, id, { kept: ['a'] });
    await git(repo, 'worktree', 'remove', '--force', join(repo, '.braid', 'worktrees', id, 'a'));
    await git(repo, 'worktree', 'add', join(tmp('braid-mine-'), 'wt'), `braid/${id}/task-a`);

    const report = await cleanRepo(repo, { runs: true });
    assert.equal(itemsOf(report, id).find((i) => i.kind === 'task branch')!.outcome, 'kept');
    assert.ok(existsSync(runFolder(repo, id)), 'the branch is still braid/<id>/..., so the run has to stay findable');
  });

  it('reports a branch that would not go as a failure, and keeps the folder', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-done';
    await makeRun(repo, id, { kept: ['a'] });
    // A lock a killed git left behind: deleting the branch fails.
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'braid', id, 'task-a.lock'), '');

    const lines: string[] = [];
    const code = await cleanCommand(repo, undefined, { runs: true }, (l) => lines.push(l));
    assert.equal(code, 1, 'something that should have gone could not be removed');
    assert.match(lines.join('\n'), /FAILED to remove task branch/);
    assert.ok((await branches(repo)).includes(`braid/${id}/task-a`));
    assert.ok(existsSync(join(runFolder(repo, id), 'state.json')));
  });
});

describe('braid clean --integration on a run that can still be resumed', () => {
  it('keeps the branch of a failed run whose tip is only its base, which main trivially contains', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-fail';
    await makeRun(repo, id, { status: 'failed', kept: [], tasks: { a: { status: 'failed' } }, integrationCommits: 0 });

    const report = await cleanRepo(repo, { integration: true });
    const item = itemsOf(report, id).find((i) => i.kind === 'integration branch')!;
    assert.equal(item.outcome, 'kept');
    assert.match(item.note!, /can be resumed/);
    assert.ok((await branches(repo)).includes(`braid/${id}/integration`), '`braid resume` can still continue it');
  });

  it('deletes it with --runs, which removes the run too', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-a';
    await makeRun(repo, id, { status: 'aborted', kept: [], tasks: { a: { status: 'skipped' } } });
    const report = await cleanRepo(repo, { integration: true, runs: true });
    assert.equal(itemsOf(report, id).find((i) => i.kind === 'integration branch')!.outcome, 'removed');
    assert.ok(!existsSync(runFolder(repo, id)), 'nothing is left to resume, and nothing lists it');
  });

  it('deletes it with --force, when the person says they do not want the run', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-b';
    await makeRun(repo, id, { status: 'aborted', kept: [], tasks: { a: { status: 'skipped' } } });
    const report = await cleanRepo(repo, { integration: true, force: true });
    assert.equal(itemsOf(report, id).find((i) => i.kind === 'integration branch')!.outcome, 'removed');
  });

  it('still deletes the merged branch of a run that finished', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-done';
    await makeRun(repo, id, { kept: [], integrationCommits: 0 });
    const report = await cleanRepo(repo, { integration: true });
    assert.equal(itemsOf(report, id).find((i) => i.kind === 'integration branch')!.outcome, 'removed');
  });
});

describe('braid clean and a worktrees folder that is a link', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  /** Somebody's folder, reachable from .braid/worktrees through a link. */
  function target(): string {
    const folder = tmp('braid-folder-');
    writeFileSync(join(folder, 'precious.txt'), 'keep');
    mkdirSync(join(folder, 'sub'));
    writeFileSync(join(folder, 'sub', 'also.txt'), 'keep too');
    return folder;
  }

  it('unlinks it and leaves what it points at, when there is no run folder', async () => {
    const repo = await makeRepo();
    const folder = target();
    mkdirSync(join(repo, '.braid', 'worktrees'), { recursive: true });
    const link = join(repo, '.braid', 'worktrees', 'moved');
    symlinkSync(folder, link, 'dir');

    const report = await cleanRepo(repo);
    assert.equal(itemsOf(report, 'moved').length, 1);
    assert.ok(!existsSync(link) && !lstatExists(link), 'the link is gone');
    assert.equal(readFileSync(join(folder, 'precious.txt'), 'utf8'), 'keep');
    assert.equal(readFileSync(join(folder, 'sub', 'also.txt'), 'utf8'), 'keep too');
  });

  it('does the same for the worktrees folder of a finished run', async () => {
    const repo = await makeRepo();
    const id = '20260101-000001-done';
    await makeRun(repo, id, { kept: [] });
    const folder = target();
    const link = join(repo, '.braid', 'worktrees', id);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(folder, link, 'dir');

    await cleanRepo(repo, { runs: true });
    assert.ok(!lstatExists(link));
    assert.ok(existsSync(join(folder, 'precious.txt')));
    assert.ok(existsSync(join(folder, 'sub', 'also.txt')));
  });
});

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
