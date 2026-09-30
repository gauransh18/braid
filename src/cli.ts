#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ClaudeDriver } from './drivers/claude.js';
import { CodexDriver } from './drivers/codex.js';
import { DriverRegistry } from './drivers/driver.js';
import { GeminiDriver } from './drivers/gemini.js';
import { MockDriver } from './drivers/mock.js';
import { NIM_DEFAULT_MODEL, OpenAICompatDriver } from './drivers/openai-compat.js';
import { createDemoRun } from './demo.js';
import { checkTools, doctorExitCode, formatDoctor } from './doctor.js';
import { Git } from './git.js';
import { fetchModels, isProvider, testProvider } from './models.js';
import { randomBytes } from 'node:crypto';
import { Orchestrator } from './orchestrator.js';
import { describeTokens } from './tokens.js';
import { loadPlan } from './plan.js';
import { planGoal } from './planner.js';
import { RunStore, stateRoot, type HarnessEvent } from './store.js';
import type { PlanSpec, RunState } from './types.js';
import { startWatch } from './watch.js';

const USAGE = `braid - headless multi-agent harness

Usage:
  braid plan "<goal>" [--verify "npm test"]... [--out plan.json] [--driver claude] [--model M]
  braid run <plan.json> [--concurrency N] [--replan N] [--sandbox IMAGE] [--keep-worktrees] [--watch]
  braid resume [runId] [--concurrency N] [--keep-worktrees] [--watch]
                                 continue an interrupted or failed run; merged tasks are kept
  braid watch [--port 4777] [--control]
                                 live dashboard for this repo's runs; --control adds start/stop/resume
                                 buttons, guarded by a per-session token (BRAID_CONTROL_TOKEN or generated)
  braid demo  [--port 4777]      scripted mock run + dashboard, no agents
  braid models <provider> [--json]     live model list (claude|codex|gemini|nim); key from the environment
  braid test-provider <provider> [--model M] [--json]
                                 check a provider's key, reachability and model
  braid doctor [--json]          check that git and an agent CLI are installed
  braid status [runId]
  braid runs

Runs never touch your branches. Work lands on braid/<runId>/integration;
review it and merge it yourself.`;

function registry(): DriverRegistry {
  return new DriverRegistry()
    .register(new ClaudeDriver())
    .register(new CodexDriver())
    .register(new GeminiDriver())
    // NVIDIA NIM's hosted, OpenAI-compatible API. The key comes from Settings (or the shell) at run time.
    .register(
      new OpenAICompatDriver({
        name: 'nim',
        label: 'NVIDIA NIM',
        baseUrl: process.env.BRAID_NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
        keyEnv: 'NVIDIA_API_KEY',
        defaultModel: NIM_DEFAULT_MODEL,
      }),
    )
    .register(new MockDriver());
}

function printEvent(e: HarnessEvent): void {
  const t = e.ts.slice(11, 19);
  const who = e.task ? `[${e.task}]` : '';
  switch (e.type) {
    case 'task_status':
      console.log(`${t} ${who} ${e.status}${e.error ? ` - ${String(e.error).split('\n')[0]}` : ''}`);
      break;
    case 'verify':
      console.log(`${t} ${who} verify (${e.dir}) \`${e.cmd}\` -> ${e.code === 0 ? 'pass' : `fail (${e.code})`}`);
      break;
    case 'review':
      console.log(`${t} ${who} review -> ${e.approve ? 'approved' : `changes requested: ${(e.issues as string[]).join('; ')}`}`);
      break;
    case 'merge':
      console.log(`${t} ${who} merge -> ${e.ok ? 'ok' : 'conflict'}`);
      break;
    case 'sync':
      console.log(`${t} ${who} pulled latest integration${(e.conflicts as string[]).length ? `: conflicts in ${(e.conflicts as string[]).join(', ')}` : ''}`);
      break;
    case 'resolve':
      console.log(`${t} ${who} ${(e.leftover as string[]).length ? `markers remain in ${(e.leftover as string[]).join(', ')}` : 'conflicts resolved'}`);
      break;
    case 'merge_reverted':
      console.log(`${t} ${who} merge reverted: combined tree failed verification`);
      break;
    case 'run_start':
      console.log(`${t} run started on ${e.base}; integration branch ${e.integrationBranch}`);
      break;
    case 'replan':
      console.log(`${t} ${who} replan -> ${e.ok ? `replaced by ${(e.added as string[]).join(', ')}${e.reason ? ` (${e.reason})` : ''}` : `not replaced: ${String(e.reason).split('\n')[0]}`}`);
      break;
    case 'sandbox':
      console.log(`${t} sandbox: ${e.runtime} ${e.image}${e.agent ? ' (agent runs inside too)' : ' (setup and verify only)'}`);
      break;
    case 'run_resume':
      console.log(`${t} run resumed: ${(e.done as string[]).length} task(s) already merged, retrying ${(e.retry as string[]).join(', ') || 'none'}`);
      break;
    case 'run_end':
      console.log(`${t} run ${e.status}; ${describeTokens(e.tokens as never, false)}`);
      break;
  }
}

function printState(s: RunState): void {
  console.log(`run ${s.runId}: ${s.status}  base=${s.base}  integration=${s.integrationBranch}`);
  console.log(`  tokens: ${describeTokens(s.tokens)}`);
  for (const t of Object.values(s.tasks)) {
    const err = t.error ? `  ${t.error.split('\n')[0]!.slice(0, 120)}` : '';
    console.log(`  ${t.id.padEnd(24)} ${t.status.padEnd(10)} attempts=${t.attempts} ${describeTokens(t.tokens, false)}${err}`);
  }
}

/** Newest run that did not finish cleanly. */
async function latestUnfinished(repo: string): Promise<string> {
  const runs = await RunStore.listRuns(repo);
  for (const id of runs.reverse()) {
    const s = await RunStore.loadState(repo, id).catch(() => null);
    if (s && s.status !== 'done') return id;
  }
  throw new Error('no unfinished runs to resume');
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      verify: { type: 'string', multiple: true },
      out: { type: 'string' },
      driver: { type: 'string' },
      model: { type: 'string' },
      concurrency: { type: 'string' },
      replan: { type: 'string' },
      sandbox: { type: 'string' },
      control: { type: 'boolean' },
      json: { type: 'boolean' },
      budget: { type: 'string' },
      'keep-worktrees': { type: 'boolean' },
      watch: { type: 'boolean' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  const port = values.port ? Number(values.port) : undefined;

  if (cmd === 'demo') {
    const orch = await createDemoRun();
    const watch = await startWatch(orch.repo, port);
    console.log(`demo run ${orch.runId} in ${orch.repo}`);
    console.log(`watch:  ${watch.url}#run=${orch.runId}`);
    orch.store.onEvent(printEvent);
    await orch.run();
    console.log(`
demo finished. Dashboard stays up at ${watch.url} - Ctrl-C to exit.`);
    await new Promise(() => undefined);
  }

  if (cmd === 'models' || cmd === 'test-provider') {
    if (!arg || !isProvider(arg)) throw new Error('name a provider: claude, codex, gemini or nim');
    // Keys arrive in the environment (never argv). Output is JSON for the desktop app, or a short summary.
    const result = cmd === 'models' ? await fetchModels(arg) : await testProvider(arg, values.model);
    if (values.json) console.log(JSON.stringify(result));
    else if ('steps' in result) for (const st of result.steps) console.log(`${st.ok ? 'ok  ' : 'FAIL'} ${st.name}: ${st.detail}`);
    else console.log(result.source === 'live' ? result.models.join('\n') : result.error);
    return cmd === 'models' ? 0 : 'steps' in result && result.ok ? 0 : 1;
  }

  if (cmd === 'doctor') {
    const rows = await checkTools();
    console.log(values.json ? JSON.stringify(rows) : formatDoctor(rows));
    return doctorExitCode(rows);
  }

  const repo = await Git.toplevel(process.cwd());

  if (cmd === 'watch') {
    // The token stays out of argv (visible in `ps`): it comes from the environment or is generated here.
    const token = values.control ? process.env.BRAID_CONTROL_TOKEN || randomBytes(24).toString('hex') : undefined;
    const watch = await startWatch(repo, port, token ? { token, drivers: registry } : undefined);
    console.log(`braid watch: ${watch.url}${token && !process.env.BRAID_CONTROL_TOKEN ? `#token=${token}` : ''}  (Ctrl-C to exit)`);
    if (token) console.log('controls enabled: open the URL above (the token is in the part after #)');
    await new Promise(() => undefined);
  }

  if (cmd === 'plan') {
    if (!arg) throw new Error('plan needs a goal');
    const { plan } = await planGoal(registry().get(values.driver ?? 'claude'), {
      repo,
      goal: arg,
      verify: values.verify,
      model: values.model,
    });
    const json = JSON.stringify(plan, null, 2);
    if (values.out) {
      await writeFile(values.out, json + '\n');
      console.error(`wrote ${values.out} (${plan.tasks.length} tasks). Edit it, then: braid run ${values.out}`);
    } else console.log(json);
    return 0;
  }

  if (cmd === 'run' || cmd === 'resume') {
    let plan: PlanSpec;
    let runId: string | undefined;
    if (cmd === 'run') {
      if (!arg) throw new Error('run needs a plan file');
      plan = await loadPlan(arg);
    } else {
      runId = arg ?? (await latestUnfinished(repo));
      plan = await loadPlan(join(stateRoot(repo), 'runs', runId, 'plan.json'));
    }
    if (values.concurrency) plan.concurrency = Number(values.concurrency);
    if (values.budget) plan.budgetUsd = Number(values.budget);
    if (values.replan) plan.maxReplans = Number(values.replan);
    if (values.sandbox) plan.sandbox = { ...plan.sandbox, image: values.sandbox };
    if (values.driver) plan.driver = values.driver;
    const ac = new AbortController();
    process.on('SIGINT', () => {
      console.log('\ninterrupt: stopping agents, keeping merged work...');
      ac.abort();
    });
    const orch = new Orchestrator({ repo, plan, drivers: registry(), signal: ac.signal, keepWorktrees: values['keep-worktrees'], runId, resume: cmd === 'resume' });
    orch.store.onEvent(printEvent);
    if (values.watch) {
      const watch = await startWatch(repo, port);
      console.log(`watch:  ${watch.url}#run=${orch.runId}`);
    }
    const state = await orch.run();
    console.log('');
    printState(state);
    if (state.status === 'aborted') console.log(`\nResume:  braid resume ${state.runId}`);
    else {
      console.log(`\nReview:  git log --oneline ${state.base}..${state.integrationBranch}`);
      console.log(`Merge:   git merge ${state.integrationBranch}`);
      if (state.status === 'failed') console.log(`Retry:   braid resume ${state.runId}`);
    }
    return state.status === 'done' ? 0 : 2;
  }

  if (cmd === 'status') {
    const runs = await RunStore.listRuns(repo);
    const id = arg ?? runs.at(-1);
    if (!id) throw new Error('no runs yet');
    printState(await RunStore.loadState(repo, id));
    return 0;
  }

  if (cmd === 'runs') {
    for (const id of await RunStore.listRuns(repo)) {
      const s = await RunStore.loadState(repo, id).catch(() => null);
      console.log(`${id}  ${s?.status ?? 'unknown'}  ${describeTokens(s?.tokens, false)}`);
    }
    return 0;
  }

  console.error(USAGE);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`braid: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
