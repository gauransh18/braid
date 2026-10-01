import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Git } from './git.js';
import { exec, pidAlive } from './proc.js';
import { findExecutable } from './spawn.js';
import { RunStore, stateRoot } from './store.js';
import { describeTokens, totalTokens } from './tokens.js';
import type { PlanSpec, RunState } from './types.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** GitHub stops accepting a body at 65536 characters, and Windows stops a command line at about 32k. */
const MAX_BODY = 30_000;

/** An inline code span that survives backticks and line breaks in what it holds. */
function code(text: string): string {
  const flat = text.replace(/\s*\r?\n\s*/g, ' ').trim();
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

const cell = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** First line of the goal, short enough for a pull request title. */
export function prTitle(state: RunState, plan: PlanSpec): string {
  const line = (plan.goal ?? '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean);
  return line ? clip(line, 72) : `braid run ${state.runId}`;
}

/**
 * The pull request description: goal, a table of every task, what checks they had to pass and what merged.
 * Pure: it reads the two snapshots a run leaves behind and nothing else.
 */
export function renderPrBody(state: RunState, plan: PlanSpec): string {
  const titles = new Map((plan.tasks ?? []).map((t) => [t.id, t.title ?? t.id]));
  const tasks = Object.values(state.tasks ?? {});
  const merged = tasks.filter((t) => t.status === 'done');
  // A replaced task never merges itself; its replacements stand for it.
  const planned = tasks.filter((t) => t.status !== 'replaced').length;
  const out: string[] = [];

  out.push(`braid run ${code(state.runId)}: ${merged.length} of ${planned} task${planned === 1 ? '' : 's'} merged into ${code(state.integrationBranch)}, which started from ${code(state.base)}.`);
  if (state.status !== 'done') out.push(`**This run did not finish (${state.status}).** Tasks that did not merge are not part of this change.`);

  out.push('## Goal', clip((plan.goal ?? '').trim(), 4000).split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join('\n'));

  const rows = tasks.map((t) => {
    const status = t.status === 'replaced' && t.replacedBy?.length ? `replaced by ${t.replacedBy.join(', ')}` : t.status;
    return `| ${cell(`${code(t.id)} ${clip(titles.get(t.id) ?? '', 200)}`)} | ${cell(status)} | ${t.attempts} | ${describeTokens(t.tokens, false)} |`;
  });
  const attempts = tasks.reduce((n, t) => n + t.attempts, 0);
  out.push(
    '## Tasks',
    ['| Task | Status | Attempts | Tokens |', '| --- | --- | ---: | ---: |', ...rows, `| **Total** | | ${attempts} | ${totalTokens(state.tokens) ? describeTokens(state.tokens, false) : '-'} |`].join('\n'),
  );

  const mergedLine = merged.length ? `Merged: ${merged.map((t) => code(t.id)).join(', ')}.` : 'Nothing merged.';
  const left = tasks.filter((t) => t.status !== 'done' && t.status !== 'replaced');
  out.push(left.length ? `${mergedLine} Not merged: ${left.map((t) => `${code(t.id)} (${t.status})`).join(', ')}.` : mergedLine);

  // The checks each task had to pass: per task when it overrides the plan's.
  const byCommand = new Map<string, string[]>();
  for (const t of plan.tasks ?? []) for (const cmd of t.verify ?? plan.verify ?? []) byCommand.set(cmd, [...(byCommand.get(cmd) ?? []), t.id]);
  const every = (plan.tasks ?? []).length;
  out.push(
    '## Verification',
    byCommand.size
      ? ['Each task had to pass these before it merged, and the combined result was checked again after every merge.', '', ...[...byCommand].map(([cmd, ids]) => `- ${code(cmd)}${ids.length < every ? ` (${ids.join(', ')})` : ''}`)].join('\n')
      : 'No verify commands were set for this run.',
  );

  const body = out.join('\n\n');
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n(description cut short)` : body;
}

/** `https://github.com/o/r/compare/base...head?expand=1` for a GitHub remote URL (https, ssh or scp style), else null. */
export function githubCompareUrl(remoteUrl: string, base: string, head: string): string | null {
  const m =
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim()) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim()) ??
    /^git:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (!m) return null;
  const enc = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${m[1]}/${m[2]}/compare/${enc(base)}...${enc(head)}?expand=1`;
}

/** One argument as a POSIX shell would need it written, for the commands braid prints for a person to run. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface PrFlags {
  base?: string;
  draft?: boolean;
  remote?: string;
  dryRun?: boolean;
  allowPartial?: boolean;
}

export interface PrIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Newest run that has an integration branch, or the one named. Refuses one that is still going and, without `allowPartial`, one that did not finish. */
async function chooseRun(repo: string, git: Git, arg: string | undefined, allowPartial: boolean): Promise<{ id: string; state: RunState }> {
  const ids = arg ? [arg] : (await readdir(join(stateRoot(repo), 'runs')).catch(() => [] as string[])).sort().reverse();
  for (const id of ids) {
    // Looking for the newest, a run that does not qualify is passed over; one that was asked for by name is refused.
    const skip = (why: string): void => {
      if (arg) throw new Error(`run ${id} ${why}`);
    };
    if (!ID_RE.test(id)) {
      skip('is not a run id');
      continue;
    }
    const state = await RunStore.loadState(repo, id).catch(() => null);
    if (!state) {
      skip('has no readable state.json');
      continue;
    }
    // This is the one branch braid pushes, so it has to be the one braid made for this run.
    if (state.integrationBranch !== `braid/${id}/integration`) {
      skip(`names an unexpected integration branch (${state.integrationBranch})`);
      continue;
    }
    if (!(await git.branchExists(state.integrationBranch))) {
      skip(`has no integration branch any more (${state.integrationBranch}); braid clean --integration removes merged ones`);
      continue;
    }
    let status = state.status;
    if (status === 'running') {
      if (state.pid && pidAlive(state.pid)) throw new Error(`run ${id} is still running (pid ${state.pid})`);
      status = 'aborted'; // its process is gone
    }
    if (status !== 'done' && !allowPartial) {
      throw new Error(`run ${id} did not finish (${status}), so its branch holds only the tasks that merged. Add --allow-partial to open the pull request anyway, or continue it with: braid resume ${id}`);
    }
    return { id, state };
  }
  throw new Error('no run with an integration branch to open a pull request for');
}

/**
 * `braid pr`: push a run's integration branch and open a pull request for it with the GitHub CLI. Everything goes to
 * git and gh as separate arguments; nothing is built into a shell string. It never pushes any other branch (the base
 * included), never forces, and without gh pushes nothing.
 */
export async function prCommand(repo: string, arg: string | undefined, flags: PrFlags, io: PrIo = { out: console.log, err: console.error }): Promise<number> {
  const git = new Git(repo);
  const { id, state } = await chooseRun(repo, git, arg, !!flags.allowPartial);
  const head = state.integrationBranch;
  const base = flags.base ?? state.base;
  const remote = flags.remote ?? 'origin';
  if (base === 'HEAD') throw new Error('this run started from a detached HEAD, so there is no branch to open the pull request against: pass --base BRANCH');
  // Git's own rules for a branch name, and no leading dash, which gh would take for an option.
  const validBase = !base.startsWith('-') && (await exec('git', ['check-ref-format', `refs/heads/${base}`], { cwd: repo, allowFail: true })).code === 0;
  if (!validBase) throw new Error(`"${base}" is not a usable base branch name`);
  if (base === head) throw new Error('the base and the integration branch are the same branch');
  if (!REMOTE_RE.test(remote)) throw new Error(`"${remote}" is not a usable remote name`);

  const plan = await readFile(join(stateRoot(repo), 'runs', id, 'plan.json'), 'utf8').then(
    (text) => JSON.parse(text) as PlanSpec,
    () => {
      throw new Error(`run ${id} has no readable plan.json`);
    },
  );
  const beyond = state.base.startsWith('-') ? undefined : await exec('git', ['rev-list', '--count', `${state.base}..${head}`], { cwd: repo, allowFail: true });
  if (beyond?.code === 0 && Number(beyond.stdout.trim()) === 0) throw new Error(`nothing to propose: ${head} has no commits beyond ${state.base}`);

  const remotes = (await exec('git', ['remote'], { cwd: repo, allowFail: true })).stdout.split(/\r?\n/).filter(Boolean);
  const remoteKnown = remotes.includes(remote);
  if (!remoteKnown && !flags.dryRun) throw new Error(`this repo has no remote called ${remote}${remotes.length ? ` (it has: ${remotes.join(', ')}); pass --remote` : ''}`);

  const title = prTitle(state, plan);
  const body = renderPrBody(state, plan);
  const pushArgs = ['push', '-u', remote, head];
  // The body goes in on standard input: it is long, it has line breaks, and a .cmd wrapper on Windows runs through
  // cmd.exe, which cannot be given such an argument safely. The title is one line (see prTitle).
  const ghArgs = ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', '-', ...(flags.draft ? ['--draft'] : [])];
  // What is printed for a person is not a command to paste: free text cannot be quoted for every shell (PowerShell, cmd
  // and POSIX sh differ), so the title and body are shown as text and the way to finish is to run braid again.
  const again = `braid pr ${id}${flags.base !== undefined ? ` --base ${shellQuote(flags.base)}` : ''}${flags.remote !== undefined ? ` --remote ${shellQuote(flags.remote)}` : ''}${flags.draft ? ' --draft' : ''}${flags.allowPartial ? ' --allow-partial' : ''}`;
  const commands = [`git ${pushArgs.map(shellQuote).join(' ')}`, `gh pr create --base ${shellQuote(base)} --head ${shellQuote(head)} --title <the title above> --body-file -${flags.draft ? ' --draft' : ''}   (the body above goes in on standard input)`];
  const ghBin = process.env.BRAID_GH_BIN ?? 'gh';
  const haveGh = findExecutable(ghBin) !== null;

  const describe = (): void => {
    io.out(`run ${id}: ${head} into ${base}${flags.draft ? ' (draft)' : ''}\n\ntitle: ${title}\n\nbody:\n${body}\n\ncommands:\n${commands.map((c) => `  ${c}`).join('\n')}`);
  };

  if (flags.dryRun) {
    io.out('dry run: nothing is pushed and no pull request is opened\n');
    describe();
    if (!remoteKnown) io.out(`\nnote: this repo has no remote called ${remote}`);
    if (!haveGh) io.out('\nnote: gh (the GitHub CLI) is not installed, so a real run would stop before pushing');
    return 0;
  }

  if (!haveGh) {
    io.err('braid: gh (the GitHub CLI) is not installed, so nothing was pushed and no pull request was opened.');
    describe();
    const url = githubCompareUrl((await exec('git', ['remote', 'get-url', remote], { cwd: repo, allowFail: true })).stdout, base, head);
    io.out(url ? `\nor push the branch and open the pull request in the browser:\n  ${commands[0]}\n  ${url}` : `\nInstall gh (https://cli.github.com), then run: ${again}`);
    return 1;
  }

  // A prompt would hang: these run without a terminal.
  const push = await exec('git', pushArgs, { cwd: repo, allowFail: true, timeoutMs: 180_000, env: { GIT_TERMINAL_PROMPT: '0' } });
  if (push.code !== 0) {
    const text = push.stderr.trim() || push.stdout.trim() || 'timed out';
    const why = text.split(/\r?\n/).filter((l) => !l.startsWith('hint:')).slice(-3).join(' ');
    throw new Error(`git push failed: ${why}${/rejected|non-fast-forward|fetch first/i.test(text) ? `\nbraid never forces a push; ${remote} has a different ${head}, look at it first` : ''}`);
  }
  io.out(`pushed ${head} to ${remote}`);

  const gh = await exec(ghBin, ghArgs, { cwd: repo, allowFail: true, input: body, timeoutMs: 120_000, env: { GH_PROMPT_DISABLED: '1' } }).catch((err: Error) => ({ code: 1, stdout: '', stderr: err.message }));
  if (gh.code !== 0) {
    io.err(`braid: gh pr create failed: ${(gh.stderr.trim() || gh.stdout.trim() || 'timed out').split(/\r?\n/).slice(-3).join(' ')}`);
    io.err(`${head} is on ${remote}. Once that is sorted out, open the pull request by running this again (the push is then a no-op):\n  ${again}`);
    return 1;
  }
  io.out(gh.stdout.trim());
  return 0;
}
