import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DriverRegistry } from '../src/drivers/driver.js';
import { MockDriver } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { exec } from '../src/proc.js';
import { hostIdentity } from '../src/host.js';
import { Sandbox, sweepStale } from '../src/sandbox.js';
import type { HarnessEvent } from '../src/store.js';
import type { PlanSpec } from '../src/types.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

/** A pid that belonged to a process that has since exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(child.pid);
  return child.pid;
}

/**
 * Stands in for a container runtime's `info`, `ps` and `rm`: `ps` prints `rows`, `rm` fails for the ids in `rmFails`,
 * and every invocation is logged.
 */
function fakeRuntime(rows: string[], o: { rmFails?: string[]; psFails?: boolean } = {}): { bin: string; calls: () => string[][] } {
  const dir = tmp('braid-sweep-');
  const bin = join(dir, 'fake-docker');
  writeFileSync(join(dir, 'rows.txt'), rows.map((r) => r + '\n').join(''));
  writeFileSync(join(dir, 'rm-fails.txt'), (o.rmFails ?? []).join('\n'));
  if (o.psFails) writeFileSync(join(dir, 'ps-fails'), '1');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(a) + '\\n');
const read = (f) => { try { return fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch { return ''; } };
if (a[0] === 'ps') {
  if (read('ps-fails')) { process.stderr.write('Cannot connect to the daemon\\n'); process.exit(1); }
  process.stdout.write(read('rows.txt'));
}
if (a[0] === 'rm') process.exit(read('rm-fails.txt').split('\\n').includes(a[a.length - 1]) ? 1 : 0);
`,
  );
  chmodSync(bin, 0o755);
  const log = join(dir, 'calls.jsonl');
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []) };
}

const here = hostIdentity();
const removals = (calls: string[][]) => calls.filter((c) => c[0] === 'rm').map((c) => c.join(' '));

describe('sandbox container labels', () => {
  it('puts the braid label and the owning pid on every container, so a later braid can tell it is stale', () => {
    const sb = Sandbox.withRuntime({ image: 'node:22', agent: true }, 'docker');
    for (const { args } of [sb.command('/x', 'true', 'verify'), sb.command('/x', 'true', 'setup'), sb.agentWrap('/x')!({ cmd: 'claude', args: ['-p'] })]) {
      const labels = args.flatMap((a, i) => (args[i - 1] === '--label' ? [a] : []));
      assert.deepEqual(labels, ['braid=1', `braid.pid=${process.pid}`, `braid.host=${here}`]);
      assert.ok(args.indexOf('--label') < args.indexOf('--entrypoint'), 'labels are options of `run`, not arguments of the command');
    }
  });
});

describe('sweeping stale containers', { skip: process.platform === 'win32' && 'stand-in runtime is a shebang script' }, () => {
  it('removes the containers of a braid that is gone, and leaves ours and live ones alone', async () => {
    const dead = deadPid();
    const rt = fakeRuntime([
      `aaaa1111 ${dead} ${here}`, // stale
      `bbbb2222 ${process.pid} ${here}`, // started by this very process
      `cccc3333 ${process.ppid} ${here}`, // started by a braid that is still running
      `dddd4444 ${dead} ${here}`, // stale
    ]);
    const removed = await sweepStale(rt.bin);
    assert.deepEqual(removed, ['aaaa1111', 'dddd4444']);
    const calls = rt.calls();
    assert.deepEqual(calls[0], ['ps', '-a', '--filter', 'label=braid', '--format', '{{.ID}} {{.Label "braid.pid"}} {{.Label "braid.host"}}']);
    assert.deepEqual(removals(calls), ['rm -f aaaa1111', 'rm -f dddd4444']);
  });

  it('leaves alone a container from another host or PID namespace, or with no host recorded, even though its pid is not here', async () => {
    const dead = deadPid();
    const rt = fakeRuntime([
      `aaaa1111 ${dead} some-build-host`, // another machine on the same daemon: its pid exists there, not here
      `bbbb2222 ${dead}`, // no host recorded, so there is no saying where the pid is from
      `cccc3333 ${dead} ${here}x`, // not the same place, only alike
      `dddd4444 ${dead} ${here}`, // ours to judge, and stale
    ]);
    assert.deepEqual(await sweepStale(rt.bin), ['dddd4444']);
    assert.deepEqual(removals(rt.calls()), ['rm -f dddd4444']);
  });

  it('knows its own place as one word that stays the same', () => {
    assert.match(here, /^[A-Za-z0-9.-]+(:\d+)?$/);
    assert.equal(hostIdentity(), here);
  });

  it('ignores rows it cannot read, and ids that are not hex ids', async () => {
    const dead = deadPid();
    const rt = fakeRuntime(['', 'garbage', `eeee5555`, `eeee5556 `, `eeee5557 not-a-pid`, `eeee5558 0`, `eeee5559 -${dead}`, `eeee555a ${dead} extra`, `--force ${dead}`, `x;rm ${dead}`, `ffff6666 ${dead} ${here}`]);
    assert.deepEqual(await sweepStale(rt.bin), ['ffff6666']);
    assert.deepEqual(removals(rt.calls()), ['rm -f ffff6666']);
  });

  it('counts only what the runtime really removed, and carries on past one it could not', async () => {
    const dead = deadPid();
    const rt = fakeRuntime([`aaaa1111 ${dead} ${here}`, `bbbb2222 ${dead} ${here}`, `cccc3333 ${dead} ${here}`], { rmFails: ['bbbb2222'] });
    assert.deepEqual(await sweepStale(rt.bin), ['aaaa1111', 'cccc3333']);
    assert.equal(removals(rt.calls()).length, 3);
  });

  it('never throws: no runtime, a runtime that cannot list, or a run that is already stopped', async () => {
    assert.deepEqual(await sweepStale('/nonexistent/docker'), []);
    const down = fakeRuntime([`aaaa1111 ${deadPid()} ${here}`], { psFails: true });
    assert.deepEqual(await sweepStale(down.bin), []);
    assert.deepEqual(removals(down.calls()), []);
    const live = fakeRuntime([`aaaa1111 ${deadPid()} ${here}`]);
    assert.deepEqual(await sweepStale(live.bin, AbortSignal.abort()), []);
    assert.deepEqual(removals(live.calls()), []);
  });

  it('runs once from Sandbox.create, after the runtime has answered, and keeps the ids', async () => {
    const dead = deadPid();
    const rt = fakeRuntime([`aaaa1111 ${dead} ${here}`, `bbbb2222 ${process.pid} ${here}`]);
    process.env.BRAID_CONTAINER_RUNTIME = rt.bin;
    try {
      const sb = await Sandbox.create({ image: 'node:22' });
      assert.deepEqual(sb.swept, ['aaaa1111']);
      sb.command('/x', 'true', 'verify');
      assert.deepEqual(
        rt.calls().map((c) => c[0]),
        ['info', 'ps', 'rm'],
      );
    } finally {
      delete process.env.BRAID_CONTAINER_RUNTIME;
    }
  });

  it('does not sweep a runtime that is not working', async () => {
    const dir = tmp('braid-sweep-');
    const bin = join(dir, 'fake-docker');
    writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(join(dir, 'calls'))}, process.argv[2] + '\\n');\nprocess.exit(1);\n`);
    chmodSync(bin, 0o755);
    process.env.BRAID_CONTAINER_RUNTIME = bin;
    try {
      await assert.rejects(Sandbox.create({ image: 'node:22' }), /not running/);
      assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'info\n');
    } finally {
      delete process.env.BRAID_CONTAINER_RUNTIME;
    }
  });

  it('is logged by the orchestrator as sandbox_sweep, only when something was removed', async () => {
    async function runWith(rows: string[]): Promise<HarnessEvent[]> {
      const dir = tmp('braid-sweeprepo-');
      const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
      await git('init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'README.md'), 'hi\n');
      await git('add', '-A');
      await git('commit', '-q', '-m', 'init');
      const repo = await Git.toplevel(dir);
      const plan: PlanSpec = { goal: 'g', driver: 'mock', sandbox: { image: 'node:22' }, tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
      const orch = new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(new MockDriver(() => ({ files: { 'out.txt': 'x' } }))) });
      const events: HarnessEvent[] = [];
      orch.store.onEvent((e) => events.push(e));
      process.env.BRAID_CONTAINER_RUNTIME = fakeRuntime(rows).bin;
      try {
        assert.equal((await orch.run()).status, 'done');
      } finally {
        delete process.env.BRAID_CONTAINER_RUNTIME;
      }
      return events;
    }
    const dead = deadPid();
    const swept = (await runWith([`aaaa1111 ${dead} ${here}`, `bbbb2222 ${dead} ${here}`])).filter((e) => e.type === 'sandbox_sweep');
    assert.equal(swept.length, 1);
    assert.equal(swept[0]!.count, 2);
    assert.ok(!(await runWith([`cccc3333 ${process.ppid} ${here}`])).some((e) => e.type === 'sandbox_sweep'));
  });
});
