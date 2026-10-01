import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import { killAllChildren, shell, streamLines } from '../src/proc.js';
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

  it('still reports plain exit codes and output', async () => {
    const dir = workdir();
    const res = await shell('node -e "console.log(\'hi\'); process.exit(3)"', dir);
    assert.equal(res.code, 3);
    assert.match(res.stdout, /hi/);
    assert.equal(res.timedOut, undefined);
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
  });
});
