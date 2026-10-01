import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ClaudeDriver } from '../src/drivers/claude.js';
import { DriverRegistry } from '../src/drivers/driver.js';
import { MockDriver } from '../src/drivers/mock.js';
import { Git } from '../src/git.js';
import { Orchestrator } from '../src/orchestrator.js';
import { validatePlan } from '../src/plan.js';
import { exec } from '../src/proc.js';
import { Sandbox } from '../src/sandbox.js';
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

/**
 * Stands in for `docker run`: records the invocation, then runs the trailing command on the host in the
 * directory mounted at /work. Enough to check what braid asks a runtime to do without needing one.
 */
function fakeRuntime(): { bin: string; calls: () => { args: string[]; image: string; command: string[] }[] } {
  const dir = tmp('braid-fakedocker-');
  const log = join(dir, 'calls.jsonl');
  const bin = join(dir, 'fake-docker');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === 'info') process.exit(0);
const withValue = new Set(['--name', '--entrypoint', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus', '--user', '--network', '-v', '-w', '-e', '--tmpfs']);
let i = 1, host = process.cwd(), entry = null;
for (; i < a.length && a[i].startsWith('-'); i++) {
  if (a[i] === '-v') host = a[i + 1].split(':/work')[0];
  if (a[i] === '--entrypoint') entry = a[i + 1];
  if (withValue.has(a[i])) i++;
}
const image = a[i], command = [entry, ...a.slice(i + 1)];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, image, command }) + '\\n');
const r = spawnSync(command[0], command.slice(1), { cwd: host, stdio: 'inherit' });
process.exit(r.status ?? 1);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

async function makeRepo(): Promise<string> {
  const dir = tmp('braid-sbrepo-');
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  return Git.toplevel(dir);
}

describe('sandbox command lines', () => {
  const sb = (spec = {}) => Sandbox.withRuntime({ image: 'node:22', ...spec }, 'docker');

  it('mounts only the worktree, drops privileges, and gives verify no network by default', () => {
    const { cmd, args } = sb().command('/repo/.braid/wt/a', 'npm test', 'verify');
    assert.equal(cmd, 'docker');
    assert.ok(args.includes('--rm') && args.includes('--init'));
    assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
    assert.ok(args.includes('no-new-privileges'));
    assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'none']);
    assert.equal(args.filter((x) => x === '-v').length, 1, 'exactly one mount');
    assert.equal(args[args.indexOf('-v') + 1], '/repo/.braid/wt/a:/work');
    assert.deepEqual(args.slice(-5), ['--entrypoint', 'sh', 'node:22', '-c', 'npm test'], 'entrypoint overridden so the image cannot swallow the command');
  });

  it('lets setup use the network, and verify too when asked', () => {
    assert.ok(!sb().command('/x', 'npm ci', 'setup').args.includes('--network'));
    assert.ok(!sb({ network: true }).command('/x', 'npm test', 'verify').args.includes('--network'));
  });

  it('applies resource limits', () => {
    const { args } = sb({ memory: '2g', cpus: '1.5' }).command('/x', 'true', 'verify');
    assert.equal(args[args.indexOf('--memory') + 1], '2g');
    assert.equal(args[args.indexOf('--cpus') + 1], '1.5');
  });

  it('wraps the agent only when asked, passing secrets by name', () => {
    assert.equal(sb().agentWrap('/x'), undefined);
    process.env.BRAID_TEST_SECRET = 'hunter2';
    const wrapped = sb({ agent: true, env: ['BRAID_TEST_SECRET'] }).agentWrap('/x')!({ cmd: 'claude', args: ['-p', '--model', 'm'] });
    assert.ok(wrapped.args.includes('-i'), 'stdin must reach the agent');
    assert.equal(wrapped.args[wrapped.args.indexOf('BRAID_TEST_SECRET') - 1], '-e');
    assert.ok(!wrapped.args.join(' ').includes('hunter2'), 'the secret value never appears in argv');
    assert.deepEqual(wrapped.args.slice(-6), ['--entrypoint', 'claude', 'node:22', '-p', '--model', 'm']);
    // A name to remove the container by when the run is stopped, since killing the docker client does not stop it.
    assert.ok(wrapped.container, 'the wrapped agent names its container');
    assert.equal(wrapped.args[wrapped.args.indexOf('--name') + 1], wrapped.container.name);
    assert.match(wrapped.container.name, /^braid-[0-9a-f]{12}$/);
    assert.notEqual(sb({ agent: true }).agentWrap('/x')!({ cmd: 'claude', args: [] }).container!.name, wrapped.container.name, 'a fresh name for every call');
    delete process.env.BRAID_TEST_SECRET;
  });

  it('validates the sandbox section of a plan', () => {
    const base = { goal: 'g', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] };
    assert.doesNotThrow(() => validatePlan({ ...base, sandbox: { image: 'node:22', agent: true, env: ['ANTHROPIC_API_KEY'] } }));
    assert.throws(() => validatePlan({ ...base, sandbox: { image: '' } }), /sandbox.image/);
    assert.throws(() => validatePlan({ ...base, sandbox: { image: 'i', agent: true, env: ['KEY=secret'] } }), /variable NAME/);
    assert.throws(() => validatePlan({ ...base, sandbox: { image: 'i', env: ['KEY'] } }), /only applies when sandbox.agent/);
  });

  it('explains when no container runtime works', async () => {
    process.env.BRAID_CONTAINER_RUNTIME = '/nonexistent/docker';
    try {
      await assert.rejects(Sandbox.create({ image: 'node:22' }), /none works[\s\S]*not installed[\s\S]*remove "sandbox"/);
    } finally {
      delete process.env.BRAID_CONTAINER_RUNTIME;
    }
  });
});

// The stand-in container runtime is a script with a #!/usr/bin/env node line, which Windows cannot execute. The
// real Docker path on Windows has not been tried.
describe('sandboxed runs', { skip: process.platform === 'win32' && 'stand-in runtime is a shebang script' }, () => {
  it('runs setup and verify in the container, and the agent on the host by default', async () => {
    const rt = fakeRuntime();
    const repo = await makeRepo();
    const plan: PlanSpec = {
      goal: 'g',
      driver: 'mock',
      setup: ['echo setup-ran'],
      verify: ['test -f out.txt'],
      sandbox: { image: 'node:22' },
      tasks: [{ id: 'a', title: 'A', prompt: 'p' }],
    };
    const mock = new MockDriver(() => ({ files: { 'out.txt': 'x' } }));
    const state = await new Orchestrator({ repo, plan, drivers: new DriverRegistry().register(mock), sandbox: Sandbox.withRuntime(plan.sandbox!, rt.bin) }).run();
    assert.equal(state.status, 'done');
    const calls = rt.calls();
    const verifies = calls.filter((c) => c.command.join(' ') === 'sh -c test -f out.txt');
    assert.equal(verifies.length, 2, 'verified in the task worktree and again on the merged tree');
    assert.ok(verifies.every((c) => c.args.includes('none')), 'verify has no network');
    const setups = calls.filter((c) => c.command[2]?.includes('setup-ran'));
    assert.ok(setups.length >= 2 && setups.every((c) => !c.args.includes('--network')), 'setup keeps the network');
    assert.ok(mock.calls.every((c) => c.wrap === undefined), 'agent not wrapped without agent: true');
  });

  it('runs the agent in the container when asked', async () => {
    const rt = fakeRuntime();
    const repo = await makeRepo();
    const fakeClaude = join(tmp('braid-fakeclaude-'), 'claude');
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
require('node:fs').writeFileSync('out.txt', 'from the sandboxed agent\\n');
process.stdin.resume().on('end', () => console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 7 } })));
`,
    );
    chmodSync(fakeClaude, 0o755);
    const plan: PlanSpec = {
      goal: 'g',
      verify: ['test -f out.txt'],
      allowedTools: ['Read', 'Edit', 'Bash(npm test)'],
      sandbox: { image: 'my/claude-image', agent: true, env: ['ANTHROPIC_API_KEY'] },
      tasks: [{ id: 'a', title: 'A', prompt: 'p' }],
    };
    const drivers = new DriverRegistry().register(new ClaudeDriver(fakeClaude));
    const state = await new Orchestrator({ repo, plan, drivers, sandbox: Sandbox.withRuntime(plan.sandbox!, rt.bin) }).run();
    assert.equal(state.status, 'done');
    assert.deepEqual(state.tasks.a!.tokens, { input: 5, cached: 0, output: 7 });
    const agent = rt.calls().find((c) => c.command[0] === fakeClaude);
    assert.ok(agent, 'the claude CLI was launched through the container runtime');
    assert.equal(agent.image, 'my/claude-image');
    assert.ok(agent.args.includes('-i') && agent.args.includes('ANTHROPIC_API_KEY'));
    assert.ok(agent.command.includes('Read,Edit,Bash(npm test)'), 'Bash pattern reaches the sandboxed agent');
  });
});
