import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DriverRegistry, type DriverRunOptions } from './drivers/driver.js';
import { MockDriver, type MockStep } from './drivers/mock.js';
import { Git } from './git.js';
import { Orchestrator } from './orchestrator.js';
import { exec } from './proc.js';
import type { AgentEvent, PlanSpec } from './types.js';

const CHECK_JS = `const fs = require('fs');
for (const f of fs.readdirSync('.')) {
  if (f.endsWith('.txt') && fs.readFileSync(f, 'utf8').includes('bad')) { console.error(f + ': contains a known-bad value'); process.exit(1); }
}
console.log('all checks passed');
`;

const PLAN: PlanSpec = {
  goal: 'Add a notes API with auth, validation, tests and docs',
  driver: 'mock',
  concurrency: 3,
  budgetUsd: 10,
  verify: ['node check.js'],
  maxAttempts: 3,
  tasks: [
    { id: 'schema', title: 'Note schema and validation', prompt: 'Define the note schema and validators.' },
    { id: 'auth', title: 'Token auth middleware', prompt: 'Add bearer-token auth middleware.' },
    { id: 'errors', title: 'Error responses', prompt: 'Map thrown errors to JSON responses.' },
    { id: 'routes', title: 'CRUD routes', prompt: 'Add CRUD routes for notes.', deps: ['schema', 'auth', 'errors'], review: true },
    { id: 'tests', title: 'Route tests', prompt: 'Cover every route with tests.', deps: ['routes'] },
    { id: 'docs', title: 'API reference', prompt: 'Document every endpoint.', deps: ['schema'], review: true },
    { id: 'sdk', title: 'Typed client SDK', prompt: 'Generate a typed client.', deps: ['routes'] },
  ],
};

const FILES: Record<string, string[]> = {
  schema: ['src/notes/schema.ts', 'src/notes/validate.ts'],
  auth: ['src/middleware/auth.ts', 'src/config.ts'],
  errors: ['src/middleware/errors.ts'],
  routes: ['src/routes/notes.ts', 'src/app.ts'],
  tests: ['test/notes.test.ts', 'test/helpers.ts'],
  docs: ['docs/api.md'],
  sdk: ['sdk/client.ts', 'sdk/types.ts'],
};

function taskOf(o: DriverRunOptions): string {
  return /Your task \(([a-z0-9-]+)\)/.exec(o.prompt)?.[1] ?? /implements task "([a-z0-9-]+)"/.exec(o.prompt)?.[1] ?? '?';
}

function transcript(task: string, retry: boolean): AgentEvent[] {
  const files = FILES[task] ?? ['src/index.ts'];
  const ev: AgentEvent[] = [
    { kind: 'text', text: retry ? `Picking up the rejected attempt for ${task}. Reading the failure first.` : `Starting on ${task}. Looking at the existing layout.` },
    { kind: 'tool', name: 'Glob', input: { pattern: 'src/**/*.ts' } },
    { kind: 'tool_result', isError: false, preview: 'src/app.ts\nsrc/config.ts\nsrc/index.ts' },
    { kind: 'tool', name: 'Read', input: { file_path: 'src/app.ts' } },
    { kind: 'tool_result', isError: false, preview: "import express from 'express';\nexport const app = express();" },
  ];
  for (const f of files) {
    ev.push({ kind: 'tool', name: 'Write', input: { file_path: f } });
    ev.push({ kind: 'tool_result', isError: false, preview: `File created successfully at: ${f}` });
  }
  ev.push({ kind: 'tool', name: 'Grep', input: { pattern: 'TODO', path: 'src' } });
  ev.push({ kind: 'tool_result', isError: false, preview: 'No matches found' });
  ev.push({ kind: 'text', text: `Done. Changed ${files.join(', ')}.` });
  return ev;
}

/** A scripted run with realistic failure modes: a verify failure, a review rejection and a merge conflict. */
function script(): (o: DriverRunOptions) => MockStep {
  const calls = new Map<string, number>();
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  return (o) => {
    const task = taskOf(o);
    const key = `${o.canEdit ? 'w' : 'r'}:${task}`;
    const n = (calls.get(key) ?? 0) + 1;
    calls.set(key, n);
    const cost = Number(rand(0.08, 0.35).toFixed(2));

    if (!o.canEdit) {
      const reject = task === 'routes' && n === 1;
      return {
        delayMs: rand(2500, 4000),
        costUsd: cost / 2,
        events: [
          { kind: 'text', text: 'Reviewing the diff against the task.' },
          { kind: 'tool', name: 'Read', input: { file_path: FILES[task]?.[0] } },
        ],
        text: reject
          ? '{"approve": false, "issues": ["DELETE /notes/:id does not check the note owner", "PATCH accepts unknown fields"]}'
          : '{"approve": true, "issues": []}',
      };
    }

    const files: Record<string, string> = {};
    // auth writes a failing value on its first try so verification rejects it.
    files[`${task}.txt`] = task === 'auth' && n === 1 ? 'token=bad\n' : `${task} v${n}\n`;
    // schema and errors both touch shared.txt, so whichever merges second conflicts and is redone.
    if (task === 'schema' || task === 'errors') {
      const current = readFileSync(join(o.cwd, 'shared.txt'), 'utf8');
      files['shared.txt'] = `${current}${task}\n`;
    }
    return { delayMs: rand(5000, 9000), costUsd: cost, files, events: transcript(task, n > 1), text: `Implemented ${task}.` };
  };
}

export async function createDemoRun(): Promise<Orchestrator> {
  const dir = mkdtempSync(join(tmpdir(), 'braid-demo-'));
  const git = (...a: string[]) => exec('git', ['-c', 'user.name=braid', '-c', 'user.email=braid@localhost', ...a], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.js'), CHECK_JS);
  writeFileSync(join(dir, 'shared.txt'), 'notes api\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  const repo = await Git.toplevel(dir);
  return new Orchestrator({ repo, plan: PLAN, drivers: new DriverRegistry().register(new MockDriver(script())) });
}
