import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DriverRegistry } from './drivers/driver.js';
import { Git } from './git.js';
import { Orchestrator } from './orchestrator.js';
import { exec, shell } from './proc.js';
import { validatePlan } from './plan.js';
import type { PlanSpec } from './types.js';

/**
 * One benchmark task: a starting repo, a plan, and acceptance checks the agents never see.
 * Acceptance is what decides pass/fail, not the plan's own `verify` (which the agents can see and satisfy).
 */
export interface EvalCase {
  id: string;
  /** Directory (relative to the suite file) copied into a fresh git repo. */
  fixture?: string;
  /** Alternative to `fixture`: a git URL or path to clone, at `ref`. */
  repo?: string;
  ref?: string;
  plan: PlanSpec;
  /** Directory (relative to the suite file) overlaid on the integration tree before `accept` runs. Holds hidden tests. */
  acceptDir?: string;
  /** Shell commands that must all exit 0 on the integration tree. */
  accept: string[];
}

export interface EvalSuite {
  name: string;
  cases: EvalCase[];
}

/** A driver and model to measure. Applied to every task of every case. */
export interface Variant {
  driver: string;
  model?: string;
}

export interface CaseResult {
  caseId: string;
  variant: string;
  /** Run reached `done` and every acceptance command passed. */
  pass: boolean;
  runStatus: string;
  accepted: boolean;
  costUsd: number;
  wallMs: number;
  /** Total worker attempts across tasks; above the task count means retries were needed. */
  attempts: number;
  tasks: number;
  error?: string;
}

export interface VariantSummary {
  variant: string;
  cases: number;
  passes: number;
  passRate: number;
  costUsd: number;
  /** Total spend divided by passes; the price of one working result. Null when nothing passed. */
  costPerPass: number | null;
  meanWallSec: number;
  meanAttempts: number;
}

export const variantLabel = (v: Variant): string => (v.model ? `${v.driver}:${v.model}` : v.driver);

/** Parse `claude:sonnet,codex` style specs. */
export function parseVariants(spec: string): Variant[] {
  return spec.split(',').map((part) => {
    const [driver, ...rest] = part.trim().split(':');
    if (!driver) throw new Error(`bad variant "${part}"`);
    return { driver, model: rest.join(':') || undefined };
  });
}

export async function loadSuite(path: string): Promise<EvalSuite> {
  const suite = JSON.parse(await readFile(path, 'utf8')) as EvalSuite;
  const errors: string[] = [];
  if (!suite.name) errors.push('suite.name is required');
  if (!Array.isArray(suite.cases) || !suite.cases.length) errors.push('suite.cases must be a non-empty array');
  const ids = new Set<string>();
  for (const c of suite.cases ?? []) {
    if (ids.has(c.id)) errors.push(`duplicate case id "${c.id}"`);
    ids.add(c.id);
    if (!c.fixture && !c.repo) errors.push(`case "${c.id}" needs a fixture or repo`);
    if (!c.accept?.length) errors.push(`case "${c.id}" needs at least one accept command`);
    try {
      validatePlan(c.plan);
    } catch (err) {
      errors.push(`case "${c.id}": ${(err as Error).message}`);
    }
  }
  if (errors.length) throw new Error(`invalid suite:\n  - ${errors.join('\n  - ')}`);
  return suite;
}

/** Same plan with the variant forced onto every task, so the comparison changes one thing. */
export function applyVariant(plan: PlanSpec, v: Variant): PlanSpec {
  return {
    ...plan,
    driver: v.driver,
    model: v.model,
    tasks: plan.tasks.map(({ driver: _d, model: _m, ...t }) => t),
  };
}

async function prepareRepo(c: EvalCase, suiteDir: string, into: string): Promise<void> {
  const id = ['-c', 'user.name=braid-eval', '-c', 'user.email=eval@localhost'];
  if (c.fixture) {
    await cp(resolve(suiteDir, c.fixture), into, { recursive: true });
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: into });
    await exec('git', [...id, 'add', '-A'], { cwd: into });
    await exec('git', [...id, 'commit', '-q', '-m', 'fixture'], { cwd: into });
  } else {
    await exec('git', ['clone', '-q', c.repo!, into], { cwd: tmpdir() });
    if (c.ref) await exec('git', ['checkout', '-q', '-B', 'main', c.ref], { cwd: into });
  }
}

export interface RunEvalOptions {
  suite: EvalSuite;
  suiteDir: string;
  variants: Variant[];
  drivers: DriverRegistry;
  signal?: AbortSignal;
  onResult?: (r: CaseResult) => void;
}

/** Runs every case under every variant, one at a time so wall time and spend are not muddied by neighbours. */
export async function runEval(opts: RunEvalOptions): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const variant of opts.variants) {
    for (const c of opts.suite.cases) {
      if (opts.signal?.aborted) return results;
      const r = await runCase(c, variant, opts);
      results.push(r);
      opts.onResult?.(r);
    }
  }
  return results;
}

async function runCase(c: EvalCase, variant: Variant, opts: RunEvalOptions): Promise<CaseResult> {
  const label = variantLabel(variant);
  const work = await mkdtemp(join(tmpdir(), 'braid-eval-'));
  const repo = join(work, 'repo');
  const started = Date.now();
  const base = { caseId: c.id, variant: label, tasks: c.plan.tasks.length };
  try {
    await prepareRepo(c, opts.suiteDir, repo);
    const orch = new Orchestrator({
      repo: await Git.toplevel(repo),
      plan: applyVariant(c.plan, variant),
      drivers: opts.drivers,
      signal: opts.signal,
    });
    const state = await orch.run();
    const attempts = Object.values(state.tasks).reduce((n, t) => n + t.attempts, 0);
    const wallMs = Date.now() - started;

    let accepted = false;
    let error: string | undefined;
    if (state.status === 'done') {
      const check = await acceptance(c, opts.suiteDir, orch.repo, state.integrationBranch, work);
      accepted = check.ok;
      error = check.error;
    } else {
      error = Object.values(state.tasks).find((t) => t.error)?.error?.split('\n')[0];
    }
    return { ...base, pass: state.status === 'done' && accepted, runStatus: state.status, accepted, costUsd: state.costUsd, wallMs, attempts, error };
  } catch (err) {
    return { ...base, pass: false, runStatus: 'error', accepted: false, costUsd: 0, wallMs: Date.now() - started, attempts: 0, error: String(err) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function acceptance(c: EvalCase, suiteDir: string, repo: string, branch: string, work: string) {
  const dir = join(work, 'accept');
  const git = new Git(repo);
  await git.attachWorktree(dir, branch);
  try {
    if (c.acceptDir) await cp(resolve(suiteDir, c.acceptDir), dir, { recursive: true });
    for (const cmd of c.accept) {
      const res = await shell(cmd, dir);
      if (res.code !== 0) return { ok: false, error: `accept \`${cmd}\` exited ${res.code}: ${failureHint(res.stdout)}` };
    }
    return { ok: true, error: undefined };
  } finally {
    await git.removeWorktree(dir);
  }
}

export function summarize(results: CaseResult[]): VariantSummary[] {
  const by = new Map<string, CaseResult[]>();
  for (const r of results) by.set(r.variant, [...(by.get(r.variant) ?? []), r]);
  return [...by].map(([variant, rs]) => {
    const passes = rs.filter((r) => r.pass).length;
    const costUsd = rs.reduce((n, r) => n + r.costUsd, 0);
    const mean = (f: (r: CaseResult) => number) => rs.reduce((n, r) => n + f(r), 0) / rs.length;
    return {
      variant,
      cases: rs.length,
      passes,
      passRate: passes / rs.length,
      costUsd,
      costPerPass: passes ? costUsd / passes : null,
      meanWallSec: mean((r) => r.wallMs) / 1000,
      meanAttempts: mean((r) => r.attempts),
    };
  });
}

export function formatSummary(rows: VariantSummary[]): string {
  const head = ['variant', 'pass', 'rate', 'spend', '$/pass', 'sec/case', 'attempts'];
  const body = rows.map((r) => [
    r.variant,
    `${r.passes}/${r.cases}`,
    `${Math.round(r.passRate * 100)}%`,
    `$${r.costUsd.toFixed(2)}`,
    r.costPerPass === null ? '-' : `$${r.costPerPass.toFixed(2)}`,
    r.meanWallSec.toFixed(1),
    r.meanAttempts.toFixed(1),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(head), ...body.map(line)].join('\n');
}

export async function saveResults(path: string, suite: EvalSuite, results: CaseResult[]): Promise<void> {
  await writeFile(path, JSON.stringify({ suite: suite.name, at: new Date().toISOString(), summary: summarize(results), results }, null, 2));
}

/** Most telling lines of a failed check: failing test names and errors, else the last lines. */
function failureHint(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const telling = lines.filter((l) => /^not ok|error|expected|want|fail/i.test(l));
  return (telling.length ? telling : lines.slice(-3)).slice(0, 3).join(' | ');
}
