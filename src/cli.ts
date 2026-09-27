#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ClaudeDriver } from './drivers/claude.js';
import { CodexDriver } from './drivers/codex.js';
import { DriverRegistry } from './drivers/driver.js';
import { MockDriver } from './drivers/mock.js';
import { createDemoRun } from './demo.js';
import { Git } from './git.js';
import { Orchestrator } from './orchestrator.js';
import { loadPlan } from './plan.js';
import { planGoal } from './planner.js';
import { RunStore, type HarnessEvent } from './store.js';
import type { RunState } from './types.js';
import { startWatch } from './watch.js';

const USAGE = `braid - headless multi-agent harness

Usage:
  braid plan "<goal>" [--verify "npm test"]... [--out plan.json] [--driver claude] [--model M]
  braid run <plan.json> [--concurrency N] [--budget USD] [--keep-worktrees] [--watch]
  braid watch [--port 4777]      live dashboard for this repo's runs
  braid demo  [--port 4777]      scripted mock run + dashboard, no agents, no spend
  braid status [runId]
  braid runs

Runs never touch your branches. Work lands on braid/<runId>/integration;
review it and merge it yourself.`;

function registry(): DriverRegistry {
  return new DriverRegistry().register(new ClaudeDriver()).register(new CodexDriver()).register(new MockDriver());
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
    case 'run_end':
      console.log(`${t} run ${e.status}; spend $${Number(e.costUsd).toFixed(2)}`);
      break;
  }
}

function printState(s: RunState): void {
  console.log(`run ${s.runId}: ${s.status}  base=${s.base}  integration=${s.integrationBranch}  spend=$${s.costUsd.toFixed(2)}`);
  for (const t of Object.values(s.tasks)) {
    const err = t.error ? `  ${t.error.split('\n')[0]!.slice(0, 120)}` : '';
    console.log(`  ${t.id.padEnd(24)} ${t.status.padEnd(10)} attempts=${t.attempts} $${t.costUsd.toFixed(2)}${err}`);
  }
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

  const repo = await Git.toplevel(process.cwd());

  if (cmd === 'watch') {
    const watch = await startWatch(repo, port);
    console.log(`braid watch: ${watch.url}  (Ctrl-C to exit)`);
    await new Promise(() => undefined);
  }

  if (cmd === 'plan') {
    if (!arg) throw new Error('plan needs a goal');
    const { plan, costUsd } = await planGoal(registry().get(values.driver ?? 'claude'), {
      repo,
      goal: arg,
      verify: values.verify,
      model: values.model,
    });
    const json = JSON.stringify(plan, null, 2);
    if (values.out) {
      await writeFile(values.out, json + '\n');
      console.error(`wrote ${values.out} (${plan.tasks.length} tasks, planner spend $${costUsd.toFixed(2)}). Edit it, then: braid run ${values.out}`);
    } else console.log(json);
    return 0;
  }

  if (cmd === 'run') {
    if (!arg) throw new Error('run needs a plan file');
    const plan = await loadPlan(arg);
    if (values.concurrency) plan.concurrency = Number(values.concurrency);
    if (values.budget) plan.budgetUsd = Number(values.budget);
    if (values.driver) plan.driver = values.driver;
    const ac = new AbortController();
    process.on('SIGINT', () => {
      console.log('\ninterrupt: stopping agents, keeping merged work...');
      ac.abort();
    });
    const orch = new Orchestrator({ repo, plan, drivers: registry(), signal: ac.signal, keepWorktrees: values['keep-worktrees'] });
    orch.store.onEvent(printEvent);
    if (values.watch) {
      const watch = await startWatch(repo, port);
      console.log(`watch:  ${watch.url}#run=${orch.runId}`);
    }
    const state = await orch.run();
    console.log('');
    printState(state);
    if (state.status !== 'aborted') {
      console.log(`\nReview:  git log --oneline ${state.base}..${state.integrationBranch}`);
      console.log(`Merge:   git merge ${state.integrationBranch}`);
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
      console.log(`${id}  ${s?.status ?? 'unknown'}  $${(s?.costUsd ?? 0).toFixed(2)}`);
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
