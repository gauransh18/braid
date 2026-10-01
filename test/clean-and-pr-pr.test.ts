import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { githubCompareUrl, prCommand, prTitle, renderPrBody, shellQuote, type PrFlags } from '../src/pr.js';
import type { PlanSpec, RunState } from '../src/types.js';
import { deadPid, git, gitOut, makeRepoWithOrigin, makeRun, tmp, type FakeRun } from './clean-and-pr-fixtures.js';

const state = (extra: Partial<RunState> = {}): RunState => ({
  runId: '20260101-120000-ab12',
  repo: '/r',
  base: 'main',
  integrationBranch: 'braid/20260101-120000-ab12/integration',
  status: 'done',
  costUsd: 0,
  createdAt: '2026-01-01T12:00:00Z',
  tokens: { input: 40_000, cached: 500_000, output: 2_300 },
  tasks: {
    api: { id: 'api', status: 'done', attempts: 1, costUsd: 0, tokens: { input: 12_000, cached: 100_000, output: 800 } },
    ui: { id: 'ui', status: 'done', attempts: 2, costUsd: 0, tokens: { input: 28_000, cached: 400_000, output: 1_500 } },
  },
  ...extra,
});

const plan = (extra: Partial<PlanSpec> = {}): PlanSpec => ({
  goal: 'Add rate limiting to the API',
  verify: ['npm test'],
  tasks: [
    { id: 'api', title: 'Limit the API', prompt: 'p' },
    { id: 'ui', title: 'Show the limit', prompt: 'p', deps: ['api'] },
  ],
  ...extra,
});

describe('renderPrBody', () => {
  it('lays out the goal, every task, the checks and what merged', () => {
    assert.equal(
      renderPrBody(state(), plan()),
      [
        'braid run `20260101-120000-ab12`: 2 of 2 tasks merged into `braid/20260101-120000-ab12/integration`, which started from `main`.',
        '## Goal',
        '> Add rate limiting to the API',
        '## Tasks',
        [
          '| Task | Status | Attempts | Tokens |',
          '| --- | --- | ---: | ---: |',
          '| `api` Limit the API | done | 1 | 112.8k tok |',
          '| `ui` Show the limit | done | 2 | 429.5k tok |',
          '| **Total** | | 3 | 542.3k tok |',
        ].join('\n'),
        'Merged: `api`, `ui`.',
        '## Verification',
        'Each task had to pass these before it merged, and the combined result was checked again after every merge.\n\n- `npm test`',
      ].join('\n\n'),
    );
  });

  it('says plainly when a run did not finish and which tasks are not in the branch', () => {
    const s = state({
      status: 'failed',
      tasks: {
        api: { id: 'api', status: 'done', attempts: 1, costUsd: 0 },
        ui: { id: 'ui', status: 'failed', attempts: 2, costUsd: 0, error: 'x' },
        docs: { id: 'docs', status: 'blocked', attempts: 0, costUsd: 0 },
      },
      tokens: undefined,
    });
    const body = renderPrBody(s, plan());
    assert.match(body, /1 of 3 tasks merged/);
    assert.match(body, /\*\*This run did not finish \(failed\)\.\*\* Tasks that did not merge are not part of this change\./);
    assert.match(body, /\| `ui` Show the limit \| failed \| 2 \| - \|/);
    assert.match(body, /\| `docs` \| blocked \| 0 \| - \|/, 'a task the plan does not name is listed by id alone');
    assert.match(body, /Merged: `api`\. Not merged: `ui` \(failed\), `docs` \(blocked\)\./);
    assert.match(body, /\| \*\*Total\*\* \| \| 3 \| - \|/);
  });

  it('lists the checks per task when tasks override the plan, and says when there are none', () => {
    const p = plan({ tasks: [{ id: 'api', title: 'A', prompt: 'p' }, { id: 'ui', title: 'U', prompt: 'p', verify: ['npm run lint', 'npm test'] }] });
    const body = renderPrBody(state(), p);
    assert.ok(body.endsWith('- `npm test`\n- `npm run lint` (ui)'), body);
    assert.match(renderPrBody(state(), plan({ verify: undefined })), /No verify commands were set for this run\./);
  });

  it('keeps data from breaking the layout', () => {
    const body = renderPrBody(
      state({ tasks: { a: { id: 'a', status: 'done', attempts: 1, costUsd: 0 } } }),
      plan({
        goal: '# Not a heading\n\n| not | a table |\n- not a list',
        verify: ['echo `date` | tee out.txt', 'make\n  check'],
        tasks: [{ id: 'a', title: 'Split | the\nbundle', prompt: 'p' }],
      }),
    );
    assert.match(body, /^> # Not a heading\n>\n> \| not \| a table \|\n> - not a list$/m, 'every goal line stays quoted');
    assert.match(body, /\| `a` Split \\\| the bundle \| done \| 1 \| - \|/, 'a pipe or a line break in a title stays in its cell');
    assert.match(body, /- ``echo `date` \| tee out\.txt``/, 'backticks in a command get a longer fence');
    assert.match(body, /- `make check`/, 'a command on two lines stays on one');
  });

  it('counts a replaced task as covered by its replacements, and stays within what GitHub accepts', () => {
    const s = state({
      tasks: {
        a: { id: 'a', status: 'replaced', attempts: 2, costUsd: 0, replacedBy: ['a1', 'a2'] },
        a1: { id: 'a1', status: 'done', attempts: 1, costUsd: 0, replanOf: 'a' },
        a2: { id: 'a2', status: 'done', attempts: 1, costUsd: 0, replanOf: 'a' },
      },
    });
    const body = renderPrBody(s, plan({ tasks: [{ id: 'a', title: 'A', prompt: 'p' }, { id: 'a1', title: 'A1', prompt: 'p' }, { id: 'a2', title: 'A2', prompt: 'p' }] }));
    assert.match(body, /2 of 2 tasks merged/);
    assert.match(body, /\| `a` A \| replaced by a1, a2 \|/);
    assert.match(body, /Merged: `a1`, `a2`\.$/m, 'a replaced task is not "not merged"');
    const huge = renderPrBody(s, plan({ goal: 'x'.repeat(200_000) }));
    assert.ok(huge.length < 40_000);
  });
});

describe('prTitle', () => {
  it('is the first line of the goal, short', () => {
    assert.equal(prTitle(state(), plan()), 'Add rate limiting to the API');
    assert.equal(prTitle(state(), plan({ goal: '\n\n  Fix   the\tbug \nand then more' })), 'Fix the bug');
    const long = prTitle(state(), plan({ goal: `Refactor ${'the thing '.repeat(20)}` }));
    assert.equal(long.length, 72);
    assert.ok(long.endsWith('…'));
    assert.equal(prTitle(state(), plan({ goal: '  ' })), 'braid run 20260101-120000-ab12');
  });
});

describe('githubCompareUrl and shellQuote', () => {
  it('builds a compare link for GitHub remotes only, never from anything but owner and repo', () => {
    const want = 'https://github.com/acme/widgets/compare/main...braid/r1/integration?expand=1';
    for (const url of [
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets',
      'https://github.com/acme/widgets/',
      'https://user:secret@github.com/acme/widgets.git',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
      'git://github.com/acme/widgets.git',
    ]) assert.equal(githubCompareUrl(url, 'main', 'braid/r1/integration'), want, url);
    assert.ok(!githubCompareUrl('https://user:secret@github.com/acme/widgets.git', 'main', 'x')!.includes('secret'));
    for (const url of ['https://gitlab.com/acme/widgets.git', '/srv/git/widgets.git', 'https://github.com.evil.test/acme/widgets', 'https://evil.test/github.com/acme/widgets', '']) assert.equal(githubCompareUrl(url, 'main', 'x'), null, url);
    assert.equal(githubCompareUrl('https://github.com/a/b', 'release/1.0', 'h#1'), 'https://github.com/a/b/compare/release/1.0...h%231?expand=1');
  });

  it('quotes for a POSIX shell', () => {
    assert.equal(shellQuote('braid/r1/integration'), 'braid/r1/integration');
    assert.equal(shellQuote('Fix the bug'), "'Fix the bug'");
    assert.equal(shellQuote("it's $(touch x) `y`\nz"), "'it'\\''s $(touch x) `y`\nz'");
    assert.equal(shellQuote(''), "''");
  });
});

// The stand-in gh is a script with a #!/usr/bin/env node line, which Windows cannot execute.
describe('braid pr', { skip: process.platform === 'win32' && 'stand-in gh is a shebang script' }, () => {
  const saved = { gh: process.env.BRAID_GH_BIN, log: process.env.FAKE_GH_LOG, fail: process.env.FAKE_GH_FAIL };
  let ghLog: string;
  beforeEach(() => {
    const bin = join(tmp('braid-gh-'), 'gh');
    ghLog = join(tmp('braid-ghlog-'), 'calls.jsonl');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
let body = '';
process.stdin.on('data', (d) => (body += d));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_GH_LOG + '.body', body);
  if (process.env.FAKE_GH_FAIL) { console.error(process.env.FAKE_GH_FAIL); process.exit(1); }
  console.log('https://github.com/acme/widgets/pull/7');
});
`,
    );
    chmodSync(bin, 0o755);
    process.env.BRAID_GH_BIN = bin;
    process.env.FAKE_GH_LOG = ghLog;
    delete process.env.FAKE_GH_FAIL;
  });
  afterEach(() => {
    for (const [k, v] of [['BRAID_GH_BIN', saved.gh], ['FAKE_GH_LOG', saved.log], ['FAKE_GH_FAIL', saved.fail]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const ghCalls = (): string[][] => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  /** What the stand-in gh read on standard input in its last call. */
  const ghBody = (): string => (existsSync(`${ghLog}.body`) ? readFileSync(`${ghLog}.body`, 'utf8') : '');
  const ID = '20260101-120000-ab12';
  const BRANCH = `braid/${ID}/integration`;

  async function pr(repo: string, arg?: string, flags: PrFlags = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await prCommand(repo, arg, flags, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  /** A finished run with something to propose. */
  const finished = (repo: string, extra: FakeRun = {}, id = ID) => makeRun(repo, id, { integrationCommits: 2, tasks: { a: {}, b: {} }, verify: ['npm test'], goal: 'Add rate limiting', ...extra });
  const remoteHas = (origin: string, ref: string) => gitOut(origin, 'rev-parse', '-q', '--verify', ref).catch(() => '');

  it('pushes the integration branch, never the base, and opens the pull request with gh', async () => {
    const { repo, origin } = await makeRepoWithOrigin();
    await finished(repo);
    const mainBefore = await gitOut(origin, 'rev-parse', 'main');

    const res = await pr(repo);

    assert.equal(res.code, 0, res.err);
    assert.match(res.out, new RegExp(`pushed ${BRANCH} to origin`));
    assert.match(res.out, /https:\/\/github\.com\/acme\/widgets\/pull\/7$/);
    assert.equal(await remoteHas(origin, `refs/heads/${BRANCH}`), await gitOut(repo, 'rev-parse', BRANCH), 'the branch is on the remote');
    assert.equal(await gitOut(origin, 'rev-parse', 'main'), mainBefore, 'the base branch on the remote did not move');
    assert.deepEqual((await gitOut(origin, 'for-each-ref', '--format=%(refname)')).split('\n').sort(), [`refs/heads/${BRANCH}`, 'refs/heads/main']);
    assert.equal(await gitOut(repo, 'config', `branch.${BRANCH}.remote`), 'origin', '-u set the upstream');
    assert.equal(await gitOut(repo, 'rev-parse', 'main'), mainBefore, 'and the local base did not move');
    const calls = ghCalls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['pr', 'create', '--base', 'main', '--head', BRANCH, '--title', 'Add rate limiting', '--body-file', '-'], 'no --draft unless asked');
    assert.match(ghBody(), /^braid run `20260101-120000-ab12`: 2 of 2 tasks merged/, 'the body went in on standard input');
  });

  it('--draft, --base and --remote reach gh and git as given', async () => {
    const { repo } = await makeRepoWithOrigin();
    const other = tmp('braid-other-');
    await git(other, 'init', '-q', '--bare');
    await git(repo, 'remote', 'add', 'fork', other);
    await finished(repo);
    const res = await pr(repo, undefined, { draft: true, base: 'release/1.0', remote: 'fork' });
    assert.equal(res.code, 0, res.err);
    assert.ok(await remoteHas(other, `refs/heads/${BRANCH}`));
    const [call] = ghCalls();
    assert.deepEqual([call![3], call![call!.length - 1]], ['release/1.0', '--draft']);
  });

  it('--dry-run prints the title, body and commands and does nothing', async () => {
    const { repo, origin } = await makeRepoWithOrigin();
    await finished(repo);
    const refs = await gitOut(origin, 'for-each-ref');
    const config = await gitOut(repo, 'config', '--local', '--list');
    const res = await pr(repo, undefined, { dryRun: true, draft: true });
    assert.equal(res.code, 0);
    assert.match(res.out, /^dry run: nothing is pushed and no pull request is opened/);
    assert.match(res.out, /title: Add rate limiting/);
    assert.match(res.out, /body:\nbraid run `20260101-120000-ab12`: 2 of 2 tasks merged/);
    assert.ok(res.out.includes(`  git push -u origin ${BRANCH}\n`));
    assert.match(res.out, new RegExp(`  gh pr create --base main --head ${BRANCH} --title <the title above> --body-file - --draft {3}\\(the body above goes in on standard input\\)`));
    assert.equal(await gitOut(origin, 'for-each-ref'), refs);
    assert.equal(await gitOut(repo, 'config', '--local', '--list'), config);
    assert.deepEqual(ghCalls(), []);
  });

  it('without gh it pushes nothing, prints the commands and a compare link, and exits 1', async () => {
    const { repo, origin } = await makeRepoWithOrigin();
    await git(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git');
    await git(repo, 'remote', 'set-url', '--push', 'origin', origin); // so a push, if one happened, would be visible
    await finished(repo);
    process.env.BRAID_GH_BIN = join(tmp('braid-nogh-'), 'gh');

    const res = await pr(repo);

    assert.equal(res.code, 1);
    assert.match(res.err, /gh \(the GitHub CLI\) is not installed, so nothing was pushed/);
    assert.ok(res.out.includes(`git push -u origin ${BRANCH}`));
    assert.match(res.out, /gh pr create --base main --head \S+ --title <the title above> --body-file -/);
    assert.ok(res.out.includes(`https://github.com/acme/widgets/compare/main...${BRANCH}?expand=1`));
    assert.equal(await remoteHas(origin, `refs/heads/${BRANCH}`), '', 'nothing was pushed');
    assert.deepEqual(ghCalls(), []);
  });

  it('without gh on a remote that is not GitHub it prints no link', async () => {
    const { repo } = await makeRepoWithOrigin();
    await finished(repo);
    process.env.BRAID_GH_BIN = join(tmp('braid-nogh-'), 'gh');
    const res = await pr(repo);
    assert.equal(res.code, 1);
    assert.ok(!res.out.includes('compare'));
    assert.match(res.out, /Install gh/);
  });

  it('picks the newest run that has an integration branch', async () => {
    const { repo } = await makeRepoWithOrigin();
    await finished(repo, {}, '20260101-100000-old1');
    await finished(repo, {}, '20260101-110000-mid2');
    await finished(repo, {}, '20260101-120000-new3');
    await git(repo, 'branch', '-D', 'braid/20260101-120000-new3/integration');
    const res = await pr(repo, undefined, { dryRun: true });
    assert.ok(res.out.includes('run 20260101-110000-mid2: braid/20260101-110000-mid2/integration into main'), res.out);
    // A run can also be named.
    assert.ok((await pr(repo, '20260101-100000-old1', { dryRun: true })).out.includes('run 20260101-100000-old1:'));
    await assert.rejects(pr(repo, '20260101-120000-new3', { dryRun: true }), /has no integration branch any more/);
    await assert.rejects(pr(repo, 'nope', { dryRun: true }), /run nope has no readable state\.json/);
    await assert.rejects(pr(repo, '../runs', { dryRun: true }), /is not a run id/);
  });

  it('refuses a failed or aborted run unless --allow-partial, and a run that is still going', async () => {
    const { repo } = await makeRepoWithOrigin();
    await finished(repo, { status: 'failed', tasks: { a: { status: 'done' }, b: { status: 'failed' } } });
    await assert.rejects(pr(repo), /did not finish \(failed\), so its branch holds only the tasks that merged\. Add --allow-partial.*braid resume 20260101-120000-ab12/);
    assert.deepEqual(ghCalls(), []);
    const partial = await pr(repo, undefined, { allowPartial: true, dryRun: true });
    assert.match(partial.out, /1 of 2 tasks merged/);
    assert.match(partial.out, /This run did not finish \(failed\)/);

    const aborted = '20260101-130000-ab34';
    await finished(repo, { status: 'aborted' }, aborted);
    await assert.rejects(pr(repo), /run 20260101-130000-ab34 did not finish \(aborted\)/);
    await assert.rejects(pr(repo, ID), /did not finish \(failed\)/);

    // A crashed run (marked running by a process that is gone) is a partial one; one whose process is alive is not finished at all.
    const crashed = '20260101-140000-ab56';
    await finished(repo, { status: 'running', pid: await deadPid() }, crashed);
    await assert.rejects(pr(repo), /run 20260101-140000-ab56 did not finish \(aborted\)/);
    const live = '20260101-150000-ab78';
    await finished(repo, { status: 'running', pid: process.pid }, live);
    await assert.rejects(pr(repo, undefined, { allowPartial: true }), new RegExp(`run ${live} is still running`));
  });

  it('refuses a run that has nothing beyond its base', async () => {
    const { repo } = await makeRepoWithOrigin();
    await finished(repo, { integrationCommits: 0 });
    await assert.rejects(pr(repo), /nothing to propose: braid\/20260101-120000-ab12\/integration has no commits beyond main/);
  });

  it('passes goals, titles and branch names as data, never through a shell', async () => {
    const { repo } = await makeRepoWithOrigin();
    // Anything a shell would run would leave this file in the repo, where gh and git run.
    const marker = join(repo, 'pwned');
    const title = `"; touch pwned; echo '$(touch pwned)' \`touch pwned\``;
    await finished(repo, { goal: `${title}\nsecond line`, planTasks: [{ id: 'a', title: '$(touch pwned)', prompt: 'p' }, { id: 'b', title: "it's", prompt: 'p' }], verify: ['echo "$HOME" && touch pwned'] });
    const res = await pr(repo);
    assert.equal(res.code, 0, res.err);
    const [call] = ghCalls();
    assert.equal(call![7], title, 'the title is the first line of the goal, byte for byte');
    assert.ok(ghBody().includes('$(touch pwned)') && ghBody().includes('echo "$HOME" && touch pwned'));
    assert.ok(!existsSync(marker), 'nothing ran');
  });

  it('refuses a remote or base it cannot pass on safely', async () => {
    const { repo } = await makeRepoWithOrigin();
    await finished(repo);
    await assert.rejects(pr(repo, undefined, { remote: 'upstream' }), /no remote called upstream \(it has: origin\)/);
    for (const remote of ['--mirror', '-f', 'https://example.test/x.git', 'a b']) await assert.rejects(pr(repo, undefined, { remote }), /not a usable remote name/, remote);
    for (const base of ['-x', '--force', 'a..b', 'a b', 'x/', 'x.lock', 'a~1', 'a:b', '']) await assert.rejects(pr(repo, undefined, { base, dryRun: true }), /not a usable base branch name/, base);
    assert.deepEqual(ghCalls(), []);
  });

  it('refuses to push a branch that is not the run\'s own integration branch', async () => {
    const { repo } = await makeRepoWithOrigin();
    await finished(repo);
    await git(repo, 'branch', 'feature/mine', 'main');
    const file = join(repo, '.braid', 'runs', ID, 'state.json');
    const s = JSON.parse(readFileSync(file, 'utf8'));
    s.integrationBranch = 'main';
    writeFileSync(file, JSON.stringify(s));
    await assert.rejects(pr(repo, ID), /unexpected integration branch \(main\)/);
    s.integrationBranch = '--force';
    writeFileSync(file, JSON.stringify(s));
    await assert.rejects(pr(repo, ID), /unexpected integration branch/);
    assert.deepEqual(ghCalls(), []);
  });

  it('a run that started from a detached HEAD needs --base', async () => {
    const { repo } = await makeRepoWithOrigin();
    await finished(repo);
    const file = join(repo, '.braid', 'runs', ID, 'state.json');
    const s = JSON.parse(readFileSync(file, 'utf8'));
    s.base = 'HEAD';
    writeFileSync(file, JSON.stringify(s));
    await assert.rejects(pr(repo, ID), /detached HEAD.*pass --base BRANCH/);
  });

  it('does not force: a remote branch with other history is left as it is', async () => {
    const { repo, origin } = await makeRepoWithOrigin();
    await finished(repo);
    // Somebody already pushed a branch of that name with history of its own.
    await git(repo, 'checkout', '-q', '--orphan', 'theirs');
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'someone else');
    await git(repo, 'push', '-q', 'origin', `theirs:refs/heads/${BRANCH}`);
    await git(repo, 'checkout', '-q', 'main');
    const before = await gitOut(origin, 'rev-parse', `refs/heads/${BRANCH}`);
    await assert.rejects(pr(repo), /git push failed.*braid never forces a push/s);
    assert.equal(await gitOut(origin, 'rev-parse', `refs/heads/${BRANCH}`), before);
    assert.deepEqual(ghCalls(), [], 'no pull request for a branch that did not go up');
  });

  it('when gh fails the branch is already up, and braid says how to finish', async () => {
    const { repo, origin } = await makeRepoWithOrigin();
    await finished(repo);
    process.env.FAKE_GH_FAIL = 'HTTP 401: Bad credentials (gh auth login)';
    const res = await pr(repo);
    assert.equal(res.code, 1);
    assert.match(res.err, /gh pr create failed: HTTP 401: Bad credentials/);
    assert.match(res.err, new RegExp(`${BRANCH} is on origin\\. .*\\n  braid pr ${ID}$`));
    assert.ok(await remoteHas(origin, `refs/heads/${BRANCH}`));
  });

  it('hands gh the title as one argument and the body on standard input, whatever characters they hold', async () => {
    const { repo } = await makeRepoWithOrigin();
    await finished(repo, { goal: `Fix "quoted" 100% & it's $(touch x)\nsecond line of the goal` });
    const res = await pr(repo);
    assert.equal(res.code, 0, res.err);
    const [call] = ghCalls();
    assert.equal(call!.length, 10);
    assert.equal(call![7], `Fix "quoted" 100% & it's $(touch x)`);
    assert.ok(!call!.some((a) => a.includes('braid run') || a.includes('second line')), 'no free text beyond the title is on the command line');
    assert.match(ghBody(), /second line of the goal/);
  });

  it('says how to finish by running braid again, which no shell has to quote', async () => {
    const { repo } = await makeRepoWithOrigin();
    await finished(repo, { goal: "Fix user's login" });
    process.env.FAKE_GH_FAIL = 'HTTP 401: Bad credentials (gh auth login)';
    const res = await pr(repo, undefined, { draft: true, remote: 'origin', base: 'main' });
    assert.equal(res.code, 1);
    assert.match(res.err, new RegExp(`\\n  braid pr ${ID} --base main --remote origin --draft$`));
    assert.doesNotMatch(res.err, /Fix user|'\\''/, 'no command with the title in it for a particular shell to misread');

    process.env.BRAID_GH_BIN = join(tmp('braid-nogh-'), 'gh');
    const missing = await pr(repo);
    assert.doesNotMatch(missing.out, /'\\''/);
    assert.match(missing.out, new RegExp(`Install gh .* then run: braid pr ${ID}$`));
  });
});
