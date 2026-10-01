import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { exec } from '../src/proc.js';

// scripts/canary.mjs runs a two-task plan through the compiled braid with each real agent CLI, to catch output-schema
// drift. Here it runs with --fake (stand-in agents, no network), so what is checked is the script: that it passes on
// well-formed output, fails on the drift it exists to catch, and skips what is not installed. Its stand-ins are shebang
// scripts, so this is POSIX only.
const skip = process.platform === 'win32' && 'the stand-in agents are shell scripts';
const SCRIPT = fileURLToPath(new URL('../../scripts/canary.mjs', import.meta.url));

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** Runs the script in a work folder of its own, which it keeps when something fails, and the test removes. */
function canary(args: string[], env: Record<string, string | undefined> = {}, dir = mkdtempSync(join(tmpdir(), 'braid-canary-test-'))) {
  temps.push(dir);
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args, '--dir', dir], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** No agent can start: every CLI is a path that does not exist and there is no NIM key. */
const NO_AGENTS = { BRAID_CLAUDE_BIN: '/nonexistent/claude', BRAID_CODEX_BIN: '/nonexistent/codex', BRAID_GEMINI_BIN: '/nonexistent/gemini', NVIDIA_API_KEY: '' };

describe('the canary script', { skip }, () => {
  it('passes on every driver when the agents print what braid expects, and leaves real work behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'braid-canary-test-'));
    const { code, out } = await canary(['--fake'], {}, dir);
    assert.equal(code, 0, out);
    for (const name of ['claude', 'codex', 'gemini', 'nim']) assert.match(out, new RegExp(`^ok   ${name}`, 'm'), out);
    assert.match(out, /4 passed, 0 failed, 0 skipped/);
    // What it asserted is really there: a finished run whose integration branch holds both files.
    const runs = join(dir, 'claude', '.braid', 'runs');
    const state = JSON.parse(readFileSync(join(runs, readdirSync(runs)[0]!, 'state.json'), 'utf8'));
    assert.equal(state.status, 'done');
    const show = await exec('git', ['show', `${state.integrationBranch}:beta.txt`], { cwd: join(dir, 'claude') });
    assert.equal(show.stdout.trim(), 'beta');
  });

  it('fails the driver whose output lost its token counts, or its final answer, and only that one', async () => {
    const [a, b] = await Promise.all([
      canary(['--fake'], { CANARY_FAKE_DRIFT: 'claude:usage,gemini:result' }),
      canary(['--fake'], { CANARY_FAKE_DRIFT: 'codex:result,nim:usage' }),
    ]);
    assert.equal(a.code, 1, a.out);
    assert.match(a.out, /^FAIL claude/m);
    assert.match(a.out, /task alpha reported no tokens/);
    assert.match(a.out, /^FAIL gemini/m);
    assert.match(a.out, /task alpha ended "failed"/);
    assert.match(a.out, /^ok   codex/m);
    assert.match(a.out, /^ok   nim/m);
    assert.match(a.out, /2 passed, 2 failed, 0 skipped/);

    assert.equal(b.code, 1, b.out);
    assert.match(b.out, /^FAIL codex/m);
    assert.match(b.out, /task alpha has no summary/);
    assert.match(b.out, /^FAIL nim/m);
    assert.match(b.out, /the run reported no tokens/);
    assert.match(b.out, /^ok   claude/m);
    assert.match(b.out, /^ok   gemini/m);
  });

  it('fails gemini when its result stops carrying the usage figures, which an estimate must not hide', async () => {
    const r = await canary(['--fake', '--drivers', 'gemini'], { CANARY_FAKE_DRIFT: 'gemini:usage' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^FAIL gemini/m);
    assert.match(r.out, /task alpha reported no tokens/);
    assert.match(r.out, /0 passed, 1 failed, 0 skipped/);
  });

  it('skips a driver that is not installed and says why; --strict makes that a failure', async () => {
    const lax = await canary([], NO_AGENTS);
    assert.equal(lax.code, 0, lax.out);
    assert.match(lax.out, /skip claude: +the claude CLI is not on PATH/);
    assert.match(lax.out, /skip nim: +NVIDIA_API_KEY is not set/);
    assert.match(lax.out, /0 passed, 0 failed, 4 skipped/);
    assert.match(lax.out, /Nothing ran/);

    const strict = await canary(['--strict'], NO_AGENTS);
    assert.equal(strict.code, 1, strict.out);
  });

  it('with --require-keys, skips a CLI whose API key is not in the environment even though the CLI is there', async () => {
    const r = await canary(['--fake', '--require-keys'], { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', GEMINI_API_KEY: 'fake-key' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /skip claude: +ANTHROPIC_API_KEY is not set/);
    assert.match(r.out, /skip codex: +OPENAI_API_KEY or CODEX_API_KEY is not set/);
    assert.match(r.out, /^ok   gemini/m);
    assert.match(r.out, /^ok   nim/m);
    assert.match(r.out, /2 passed, 0 failed, 2 skipped/);
  });

  it('runs only the drivers it is asked for, and refuses a name it does not know', async () => {
    const one = await canary(['--fake', '--drivers', 'nim']);
    assert.equal(one.code, 0, one.out);
    assert.match(one.out, /1 passed, 0 failed, 0 skipped/);
    assert.doesNotMatch(one.out, /claude/);

    const bad = await canary(['--fake', '--drivers', 'nope']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /unknown driver nope/);
  });
});
