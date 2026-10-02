import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { OpenAICompatDriver, stripThinking } from '../src/drivers/openai-compat.js';
import { planGoal } from '../src/planner.js';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

type Reply = { status?: number; body: unknown };
const answer = (content: string | null, finish = 'stop', extra: object = {}): Reply => ({
  body: { choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 30 } },
});

/** A stand-in chat completions endpoint that answers from a script and keeps every request body. */
async function fakeChat(script: Reply[]) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      const { status = 200, body } = script[Math.min(bodies.length - 1, script.length - 1)]!;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { url, bodies, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function driver(url: string, extra = {}) {
  process.env.BRAID_TEST_NIM_KEY3 = 'nvapi-x';
  return new OpenAICompatDriver({ name: 'nim', label: 'NVIDIA NIM', baseUrl: url, keyEnv: 'BRAID_TEST_NIM_KEY3', defaultModel: 'acme/m', retryDelayMs: 1, ...extra });
}
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'braid-nim-answers-'));
  temps.push(d);
  writeFileSync(join(d, 'package.json'), '{}');
  return d;
};
const ask = (d: OpenAICompatDriver, model = 'acme/m') => d.run({ prompt: 'p', cwd: repo(), model, allowedTools: ['Read'], canEdit: false });

describe('what the NIM driver asks for and accepts', () => {
  it('asks for a reply limit on every request, because the endpoint default is small', async () => {
    const api = await fakeChat([answer('ok')]);
    try {
      assert.equal((await ask(driver(api.url))).ok, true);
      assert.equal(api.bodies[0].max_tokens, 8192);
    } finally {
      await api.close();
    }
  });

  it('asks for half as many when the endpoint says that is too many', async () => {
    const api = await fakeChat([{ status: 400, body: { detail: "max_tokens 8192 is too large: this model's maximum context length is 4096 tokens" } }, answer('fits')]);
    try {
      const res = await ask(driver(api.url));
      assert.equal(res.ok, true, res.text);
      assert.deepEqual(api.bodies.map((b) => b.max_tokens), [8192, 4096]);
    } finally {
      await api.close();
    }
  });

  it("keeps a reasoning model's thinking out of the answer", async () => {
    const api = await fakeChat([answer('<think>The plan could be {"a": 1} or maybe not.</think>{"goal":"g","tasks":[]}')]);
    try {
      const res = await ask(driver(api.url));
      assert.equal(res.text, '{"goal":"g","tasks":[]}');
    } finally {
      await api.close();
    }
  });

  it('strips thinking in every shape models write it', () => {
    assert.equal(stripThinking('<think>a</think>answer'), 'answer');
    assert.equal(stripThinking('a reasoning without an opening tag</think>answer'), 'answer');
    assert.equal(stripThinking('<THINK>a</THINK> <think>b</think>answer'), 'answer');
    assert.equal(stripThinking('<think>cut off while thinking'), '');
    assert.equal(stripThinking('plain'), 'plain');
  });

  it('asks the model to carry on when its answer was cut off, and joins the pieces', async () => {
    const api = await fakeChat([answer('{"goal": "g", "tasks": [{"id": "a", ', 'length'), answer('"title": "A", "prompt": "p"}]}', 'stop')]);
    try {
      const res = await ask(driver(api.url));
      assert.equal(res.ok, true, res.text);
      assert.deepEqual(JSON.parse(res.text), { goal: 'g', tasks: [{ id: 'a', title: 'A', prompt: 'p' }] });
      const last = api.bodies[1].messages.at(-1);
      assert.equal(last.role, 'user');
      assert.match(last.content, /cut off at the output limit/);
      assert.equal(api.bodies[1].messages.at(-2).content, '{"goal": "g", "tasks": [{"id": "a", ', 'the model sees what it had written');
    } finally {
      await api.close();
    }
  });

  it('gives up with a clear message when the answer never finishes', async () => {
    const api = await fakeChat([answer('part ', 'length')]);
    try {
      const res = await ask(driver(api.url));
      assert.equal(res.ok, false);
      assert.match(res.text, /kept hitting the reply limit \(8192 tokens\).*Pick a model that answers more briefly/);
    } finally {
      await api.close();
    }
  });

  it('says what happened when the model answers with nothing', async () => {
    const api = await fakeChat([answer('<think>thinking and thinking</think>', 'length', { reasoning_content: 'x' })]);
    try {
      const res = await ask(driver(api.url, { maxTokens: 512 }));
      assert.equal(res.ok, false);
      assert.match(res.text, /kept hitting the reply limit \(512 tokens\)|answered with nothing/);
    } finally {
      await api.close();
    }
    const empty = await fakeChat([answer(null, 'stop')]);
    try {
      const res = await ask(driver(empty.url));
      assert.equal(res.ok, false);
      assert.match(res.text, /answered with nothing \(finish reason: stop\).*pick another model/);
    } finally {
      await empty.close();
    }
  });
});

describe('a model that keeps reading', () => {
  const read = (id: string): Reply => ({ body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: 'package.json' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 10 } } });

  it('has its tools taken away on the last turn, and answers with what it has', async () => {
    const api = await fakeChat([read('c1'), read('c2'), answer('Here is my answer.')]);
    try {
      const d = driver(api.url);
      const res = await d.run({ prompt: 'p', cwd: repo(), model: 'acme/m', allowedTools: ['Read'], canEdit: false, maxTurns: 3 });
      assert.equal(res.ok, true, res.text);
      assert.equal(res.text, 'Here is my answer.');
      assert.ok(api.bodies[0].tools && api.bodies[1].tools, 'tools while there are turns to spare');
      assert.equal(api.bodies[2].tools, undefined, 'none on the last turn');
      assert.match(api.bodies[2].messages.at(-1).content, /Do not call any more tools/);
    } finally {
      await api.close();
    }
  });
});

describe('drafting a plan with NIM', () => {
  const PLAN = { goal: 'Add rate limiting', tasks: [{ id: 'limiter', title: 'Limiter', prompt: 'Write it.' }, { id: 'tests', title: 'Tests', prompt: 'Test it.', deps: ['limiter'] }] };

  it('works when the model thinks first and its JSON arrives in two pieces', async () => {
    const json = JSON.stringify(PLAN);
    const cut = Math.floor(json.length / 2);
    const api = await fakeChat([answer(`<think>Two tasks, the second after the first {"deps": []}.</think>\n\`\`\`json\n${json.slice(0, cut)}`, 'length'), answer(`${json.slice(cut)}\n\`\`\``, 'stop')]);
    try {
      const { plan } = await planGoal(driver(api.url), { repo: repo(), goal: 'Add rate limiting', verify: ['npm test'], model: 'acme/m' });
      assert.deepEqual(plan.tasks.map((t) => t.id), ['limiter', 'tests']);
      assert.deepEqual(plan.verify, ['npm test']);
    } finally {
      await api.close();
    }
  });

  it('shows what the model said when it did not give a plan', async () => {
    const api = await fakeChat([answer('I would split this into two tasks, but I cannot write JSON today.')]);
    try {
      await assert.rejects(planGoal(driver(api.url), { repo: repo(), goal: 'g', model: 'acme/m' }), /planner returned no JSON plan:\s*I would split this into two tasks/);
    } finally {
      await api.close();
    }
  });
});
