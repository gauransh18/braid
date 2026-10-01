import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import { exec, killAllChildren, shell, STOP_TIMING, streamLines } from '../src/proc.js';
import { Sandbox } from '../src/sandbox.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A directory with `grand.js`: it starts a grandchild that sleeps for 30 s, records its pid, and sleeps itself. */
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'braid-proc-'));
  temps.push(dir);
  writeFileSync(
    join(dir, 'grand.js'),
    `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
require('node:fs').writeFileSync('grandchild.pid', String(c.pid));
setTimeout(() => {}, 30000);
`,
  );
  return dir;
}

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const posix = process.platform !== 'win32';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!posix) return true;
  // A killed process stays a zombie until its parent reaps it, and inside a container nothing may (PID 1 is often
  // not an init). Dead is dead for these tests.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
};

/** Run `body` with shorter stop timings, so escalation can be tested in a second instead of five. */
async function withTiming(timing: Partial<typeof STOP_TIMING>, body: () => Promise<void>): Promise<void> {
  const saved = { ...STOP_TIMING };
  Object.assign(STOP_TIMING, timing);
  try {
    await body();
  } finally {
    Object.assign(STOP_TIMING, saved);
  }
}

async function pidFrom(dir: string, name: string): Promise<number> {
  const file = join(dir, name);
  await until(() => existsSync(file) && readFileSync(file, 'utf8').length > 0, `${name} to be written`);
  return Number(readFileSync(file, 'utf8'));
}

async function grandchild(dir: string): Promise<number> {
  const file = join(dir, 'grandchild.pid');
  await until(() => existsSync(file) && readFileSync(file, 'utf8').length > 0, 'the grandchild to start');
  return Number(readFileSync(file, 'utf8'));
}

describe('shell', () => {
  it('kills what a command started when it runs past its time limit, and still returns', async () => {
    const dir = workdir();
    // Long enough for node to start the grandchild even on a slow machine.
    const res = await shell('node grand.js', dir, 2500);
    assert.equal(res.timedOut, true);
    assert.notEqual(res.code, 0);
    const pid = await grandchild(dir);
    await until(() => !alive(pid), 'the grandchild to die');
  });

  it('stops the command and everything it started when the signal aborts', async () => {
    const dir = workdir();
    const ac = new AbortController();
    const started = Date.now();
    const run = shell('node grand.js', dir, 60_000, undefined, ac.signal);
    const pid = await grandchild(dir);
    ac.abort();
    const res = await run;
    assert.equal(res.aborted, true);
    assert.ok(Date.now() - started < 10_000, 'did not wait for the 30 s sleepers');
    await until(() => !alive(pid), 'the grandchild to die');
  });

  it('does not start anything when the signal is already aborted', async () => {
    const dir = workdir();
    const res = await shell('node grand.js', dir, 60_000, undefined, AbortSignal.abort());
    assert.equal(res.aborted, true);
    await sleep(300);
    assert.ok(!existsSync(join(dir, 'grandchild.pid')));
  });

  it('is stopped with everything else when braid quits', async () => {
    const dir = workdir();
    const run = shell('node grand.js', dir, 60_000);
    const pid = await grandchild(dir);
    killAllChildren();
    await run;
    await until(() => !alive(pid), 'the grandchild to die');
  });

  it('does not call a stopped command a pass, even when it exits 0 on the way out', async () => {
    const dir = workdir();
    writeFileSync(join(dir, 'polite.js'), "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 30000);\n");
    const res = await shell('node polite.js', dir, 800);
    assert.equal(res.timedOut, true);
    assert.notEqual(res.code, 0, 'a check that had to be killed has not passed');
  });

  it('stops what a finished command left holding its output, instead of abandoning it', { skip: !posix }, async () => {
    const dir = workdir();
    writeFileSync(
      join(dir, 'leader.js'),
      `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
require('node:fs').writeFileSync('grandchild.pid', String(c.pid));
process.exit(0);
`,
    );
    const res = await shell('node leader.js', dir);
    assert.equal(res.code, 0);
    await until(() => !alive(Number(readFileSync(join(dir, 'grandchild.pid'), 'utf8'))), 'the leftover process to be stopped');
  });

  it('escalates to SIGKILL for a command that ignores SIGTERM', { skip: !posix }, async () => {
    const dir = workdir();
    writeFileSync(join(dir, 'stubborn.js'), "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('stubborn.pid', String(process.pid)); setTimeout(() => {}, 30000);\n");
    await withTiming({ killAfterMs: 700 }, async () => {
      const res = await shell('node stubborn.js', dir, 500);
      assert.equal(res.timedOut, true);
      await until(() => !alive(Number(readFileSync(join(dir, 'stubborn.pid'), 'utf8'))), 'SIGKILL to land', 4000);
    });
  });

  it('finishes off a command that is still dying when braid quits', { skip: !posix }, async () => {
    const dir = workdir();
    writeFileSync(join(dir, 'stubborn.js'), "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('stubborn.pid', String(process.pid)); setTimeout(() => {}, 30000);\n");
    await withTiming({ killAfterMs: 60_000 }, async () => {
      const ac = new AbortController();
      const run = shell('node stubborn.js', dir, 60_000, undefined, ac.signal);
      const pid = await pidFrom(dir, 'stubborn.pid');
      ac.abort();
      await sleep(300);
      assert.ok(alive(pid), 'it ignored SIGTERM, so it is still running');
      killAllChildren();
      await until(() => !alive(pid), 'the exit hook to kill it', 3000);
      await run;
    });
  });

  it('keeps a character that arrives in two pieces whole', async () => {
    const dir = workdir();
    writeFileSync(join(dir, 'split.js'), 'process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 150);\n');
    const res = await shell('node split.js', dir);
    assert.equal(res.stdout, '\u{1F600}');
  });

  it('still reports plain exit codes and output', async () => {
    const dir = workdir();
    const res = await shell('node -e "console.log(\'hi\'); process.exit(3)"', dir);
    assert.equal(res.code, 3);
    assert.match(res.stdout, /hi/);
    assert.equal(res.timedOut, undefined);
  });
});

describe('exec', () => {
  it('stops a command that runs past its time limit together with what it started, and returns', async () => {
    const dir = workdir();
    const res = await exec(process.execPath, ['grand.js'], { cwd: dir, allowFail: true, timeoutMs: 2500 });
    assert.notEqual(res.code, 0);
    await until(() => !alive(Number(readFileSync(join(dir, 'grandchild.pid'), 'utf8'))), 'the grandchild to die');
  });

  it('stops when its signal aborts, and is stopped with the rest when braid quits', async () => {
    const dir = workdir();
    const ac = new AbortController();
    const first = exec(process.execPath, ['grand.js'], { cwd: dir, allowFail: true, signal: ac.signal });
    const pid = await grandchild(dir);
    ac.abort();
    await first;
    await until(() => !alive(pid), 'the grandchild to die');

    const second = exec(process.execPath, ['grand.js'], { cwd: dir, allowFail: true });
    await sleep(500);
    killAllChildren();
    await second;
  });
});

describe('streamLines', () => {
  it('stops the process tree and throws when the signal aborts', async () => {
    const dir = workdir();
    const ac = new AbortController();
    const run = streamLines(process.execPath, ['grand.js'], { cwd: dir, input: '', signal: ac.signal }, () => undefined);
    const caught = assert.rejects(run, (err: Error) => err.name === 'AbortError');
    const pid = await grandchild(dir);
    ac.abort();
    await caught;
    await until(() => !alive(pid), 'the grandchild to die');
  });

  // Codex starts every tool command in a session of its own, which no signal to the agent's group reaches.
  const agentScript = `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const tool = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"], { detached: true, stdio: 'ignore' });
fs.writeFileSync('tool.pid', String(tool.pid));
if (process.argv[2] === 'cleans-up') process.on('SIGINT', () => { try { process.kill(tool.pid, 'SIGKILL'); } catch {} process.exit(1); });
else process.on('SIGINT', () => {});
setTimeout(() => {}, 30000);
`;

  it("asks an agent to stop with SIGINT first, so it can clean up the commands it started in sessions of its own", { skip: !posix }, async () => {
    const dir = workdir();
    writeFileSync(join(dir, 'agent.js'), agentScript);
    await withTiming({ termAfterMs: 20_000, killAfterMs: 30_000 }, async () => {
      const ac = new AbortController();
      const run = streamLines(process.execPath, ['agent.js', 'cleans-up'], { cwd: dir, input: '', signal: ac.signal }, () => undefined);
      const caught = assert.rejects(run, (err: Error) => err.name === 'AbortError');
      const tool = await pidFrom(dir, 'tool.pid');
      ac.abort();
      await caught;
      await until(() => !alive(tool), 'the tool command to be cleaned up by the agent itself', 3000);
    });
  });

  it("still kills an agent's tool command that lives in its own session when the agent ignores SIGINT and dies on SIGTERM", { skip: !posix }, async () => {
    const dir = workdir();
    writeFileSync(join(dir, 'agent.js'), agentScript);
    await withTiming({ termAfterMs: 300, killAfterMs: 900 }, async () => {
      const ac = new AbortController();
      const run = streamLines(process.execPath, ['agent.js', 'ignores-sigint'], { cwd: dir, input: '', signal: ac.signal }, () => undefined);
      const caught = assert.rejects(run, (err: Error) => err.name === 'AbortError');
      const tool = await pidFrom(dir, 'tool.pid');
      ac.abort();
      await caught;
      await until(() => !alive(tool), 'the escalation to reach the tool command through the snapshot', 5000);
    });
  });

  it('throws at once for a signal that is already aborted', async () => {
    await assert.rejects(streamLines(process.execPath, ['-e', ''], { cwd: '.', input: '', signal: AbortSignal.abort() }, () => undefined), (err: Error) => err.name === 'AbortError');
  });
});

// The stand-in runtime is a script with a #!/usr/bin/env node line, which Windows cannot execute.
describe('sandbox containers', { skip: process.platform === 'win32' && 'stand-in runtime is a shebang script' }, () => {
  it('removes the container by name when a sandboxed command is aborted', async () => {
    const dir = workdir();
    const log = join(dir, 'runtime.jsonl');
    const bin = join(dir, 'fake-docker');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'run') setTimeout(() => {}, 30000);
`,
    );
    chmodSync(bin, 0o755);
    const spec = Sandbox.withRuntime({ image: 'node:22' }, bin).command(dir, 'sleep 30', 'verify');
    assert.ok(spec.container, 'the command names its container');
    assert.equal(spec.args[spec.args.indexOf('--name') + 1], spec.container.name);

    const ac = new AbortController();
    const run = shell('', dir, 60_000, spec, ac.signal);
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
    await until(() => calls().some((c) => c[0] === 'run'), 'the container to start');
    ac.abort();
    await run;
    await until(() => calls().some((c) => c.join(' ') === `rm -f ${spec.container!.name}`), 'the container to be removed');
    // Once at once and once after a pause: the first can land before the daemon has registered the container.
    await until(() => calls().filter((c) => c.join(' ') === `rm -f ${spec.container!.name}`).length >= 2, 'the second removal', 6000);
  });

  it('can be stopped while it is still asking whether the runtime works', async () => {
    const dir = workdir();
    const bin = join(dir, 'fake-docker');
    writeFileSync(bin, '#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n');
    chmodSync(bin, 0o755);
    process.env.BRAID_CONTAINER_RUNTIME = bin;
    try {
      const ac = new AbortController();
      const started = Date.now();
      const created = Sandbox.create({ image: 'node:22' }, ac.signal);
      const caught = assert.rejects(created, (err: Error) => err.name === 'AbortError');
      setTimeout(() => ac.abort(), 300);
      await caught;
      assert.ok(Date.now() - started < 5000);
    } finally {
      delete process.env.BRAID_CONTAINER_RUNTIME;
    }
  });

  it('does not wait for a wedged runtime when braid quits', async () => {
    const dir = workdir();
    const log = join(dir, 'runtime.jsonl');
    const bin = join(dir, 'fake-docker');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
setTimeout(() => {}, process.argv[2] === 'rm' ? 8000 : 30000);
`,
    );
    chmodSync(bin, 0o755);
    const spec = Sandbox.withRuntime({ image: 'node:22' }, bin).command(dir, 'sleep 30', 'verify');
    const run = shell('', dir, 60_000, spec);
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('"run"'), 'the container to start');
    const started = Date.now();
    killAllChildren();
    assert.ok(Date.now() - started < 1500, 'force-quit returned without waiting for `rm -f` to answer');
    await run;
  });
});
