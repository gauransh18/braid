import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry, type DriverRunOptions } from '../src/drivers/driver.js';
import { MockDriver, type MockStep } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { terminalHint } from '../src/hints.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import type { PlanSpec } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('terminalHint', () => {
  const cases: [string, string, RegExp][] = [
    ["fatal: could not read Username for 'https://github.com': Device not configured", 'git on macOS', /^Hint: .*git cannot ask for a username or password/],
    ["fatal: could not read Username for 'https://github.com': No such device or address", 'git on Linux', /git cannot ask/],
    ["fatal: could not read Password for 'https://user@example.test': terminal prompts disabled", 'git password', /git cannot ask/],
    ['fatal: could not read from remote repository.\nfatal: terminal prompts disabled', 'GIT_TERMINAL_PROMPT=0', /git cannot ask/],
    ['npm ERR! open /dev/tty: Device not configured', 'macOS refusing /dev/tty to any program', /asked a question on the terminal/],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'ssh key not usable', /ssh cannot ask for a key passphrase/],
    ['Host key verification failed.\nfatal: Could not read from remote repository.', 'ssh new host', /ssh cannot ask .* to trust a new host/],
    ['sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper', 'sudo', /sudo cannot ask for a password/],
    ["gpg: cannot open '/dev/tty': No such device or address\nerror: gpg failed to sign the data", 'gpg', /gpg cannot ask for a passphrase/],
    ['gpg: signing failed: Inappropriate ioctl for device', 'gpg without GPG_TTY', /gpg cannot ask/],
  ];
  for (const [output, what, expected] of cases) {
    it(`recognizes ${what}`, () => {
      const hint = terminalHint(`some output before\n${output}\nand after`);
      assert.match(hint ?? '', expected);
    });
  }

  it('gives one line', () => {
    const hint = terminalHint("fatal: could not read Username for 'https://x.test': terminal prompts disabled\nsudo: a terminal is required to read the password\nHost key verification failed.")!;
    assert.ok(hint);
    assert.ok(!hint.includes('\n'), 'one line, even when several prompts failed');
    assert.ok(hint.length < 220, 'and a short one');
  });

  it('says nothing about other failures', () => {
    for (const output of [
      '',
      'FAIL src/a.test.ts\n  expected 2 to equal 3',
      'error: 3 tests failed',
      'npm ERR! code ELIFECYCLE',
      'fatal: unable to access https://x.test/: Could not resolve host: x.test',
      'gpg: key 1234 not found',
      'Permission denied: ./run.sh',
      'No such device',
    ]) {
      assert.equal(terminalHint(output), undefined, output);
    }
  });
});

// The same text in a real run: what a failing setup or verify command prints reaches the agent and the dashboard with the hint.
const CHECK_JS = `
console.error("fatal: could not read Username for 'https://example.test/repo.git': terminal prompts disabled");
process.exit(1);
`;

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-hint-'));
  temps.push(dir);
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'prompt.js'), CHECK_JS);
  writeFileSync(join(dir, 'plain.js'), "console.error('2 tests failed'); process.exit(1);\n");
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

const taskOf = (o: DriverRunOptions) => /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? 'reviewer';
const work = (o: DriverRunOptions): MockStep => ({ files: { [`${taskOf(o)}.txt`]: 'ok\n' } });
const HINT = /Hint: braid runs this command without a terminal\. git cannot ask for a username or password/;

describe('the hint in a run', () => {
  it('is added to a failing verify, for the agent and for the dashboard, without changing what fails', async () => {
    const repo = await makeRepo();
    const mock = new MockDriver(work);
    const plan: PlanSpec = { goal: 'g', driver: 'mock', maxAttempts: 2, verify: ['node prompt.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
    const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(mock) }).run();
    assert.equal(state.tasks.a!.status, 'failed', 'a failing check still fails the task');
    assert.equal(state.tasks.a!.attempts, 2);
    assert.match(state.tasks.a!.error!, /`node prompt\.js` exited 1/);
    assert.match(state.tasks.a!.error!, HINT);
    assert.match(mock.calls[1]!.prompt, HINT, 'the agent is told on its next attempt');
  });

  it('is added to a failing setup', async () => {
    const repo = await makeRepo();
    const plan: PlanSpec = { goal: 'g', driver: 'mock', setup: ['node prompt.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
    const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(new MockDriver(work)) }).run();
    assert.equal(state.tasks.a!.status, 'skipped');
    assert.match(state.tasks.a!.error!, /setup failed in the integration worktree/);
    assert.match(state.tasks.a!.error!, HINT);
  });

  it('is not added to an ordinary failure', async () => {
    const repo = await makeRepo();
    const plan: PlanSpec = { goal: 'g', driver: 'mock', maxAttempts: 1, verify: ['node plain.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
    const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(new MockDriver(work)) }).run();
    assert.equal(state.tasks.a!.status, 'failed');
    assert.ok(!state.tasks.a!.error!.includes('Hint:'));
  });

  it('survives a long output: the hint is not cut off with the end of the error', async () => {
    const repo = await makeRepo();
    writeFileSync(join(repo, 'noisy.js'), "console.error('x'.repeat(20000)); console.error(\"fatal: could not read Password for 'https://x.test': terminal prompts disabled\"); process.exit(1);\n");
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'noisy'], { cwd: repo });
    const plan: PlanSpec = { goal: 'g', driver: 'mock', maxAttempts: 1, verify: ['node noisy.js'], tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
    const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(new MockDriver(work)) }).run();
    assert.match(state.tasks.a!.error!, HINT);
  });
});
