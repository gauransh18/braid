import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { OpenAICompatDriver, RetiredModelError } from '../src/drivers/openai-compat.js';
import { testProvider } from '../src/models.js';
import { forgetPickedModels, isRetired, NIM_PREFERRED_MODELS, pickNimModel } from '../src/nim.js';
import type { AgentEvent } from '../src/types.js';

const [BEST, SECOND, THIRD] = NIM_PREFERRED_MODELS as [string, string, string];
const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => forgetPickedModels());

type Answer = { status?: number; body?: unknown };
const RETIRED_BODY = (m: string) => ({ type: 'about:blank', title: 'Gone', status: 410, detail: `The model '${m}' has reached its end of life and is no longer available.` });
const ok = (content = 'done') => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 2 } } });

/** A stand-in for NIM: a model list, and one answer per model for chat requests. */
async function fakeNim(listed: string[], answer: (model: string, n: number) => Answer) {
  const chats: { model: string; tools: boolean }[] = [];
  let lists = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url!.endsWith('/models')) {
        lists++;
        res.end(JSON.stringify({ data: listed.map((id) => ({ id })) }));
        return;
      }
      const body = JSON.parse(raw);
      chats.push({ model: body.model, tools: Array.isArray(body.tools) });
      const { status = 200, body: out } = answer(body.model, chats.length - 1);
      res.statusCode = status;
      res.end(JSON.stringify(out ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { url, chats, lists: () => lists, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('choosing a NIM model when none was named', () => {
  it('takes the first listed model that accepts a tool call, passing over retired and tool-less ones', async () => {
    const api = await fakeNim([BEST, SECOND, THIRD, 'other/unlisted-by-braid'], (m) =>
      m === BEST ? { status: 410, body: RETIRED_BODY(m) } : m === SECOND ? { status: 400, body: { detail: 'tools are not supported by this model' } } : ok(),
    );
    try {
      const pick = await pickNimModel({ baseUrl: api.url, key: 'nvapi-x' });
      assert.equal(pick.model, THIRD);
      assert.deepEqual(pick.skipped.map((s) => s.model), [BEST, SECOND]);
      assert.match(pick.skipped[0]!.why, /retired \(HTTP 410\)/);
      assert.match(pick.skipped[1]!.why, /does not support tool calling/);
      assert.ok(api.chats.every((c) => c.tools), 'every probe asked for a tool call');
    } finally {
      await api.close();
    }
  });

  it('does not try a name the service no longer lists, and remembers what worked', async () => {
    const api = await fakeNim([SECOND], () => ok());
    try {
      const first = await pickNimModel({ baseUrl: api.url, key: 'nvapi-x' });
      assert.equal(first.model, SECOND);
      assert.equal(api.chats.length, 1, 'BEST is not listed, so it was never asked');
      const again = await pickNimModel({ baseUrl: api.url, key: 'nvapi-x' });
      assert.equal(again.model, SECOND);
      assert.equal(api.chats.length, 1, 'the second time nothing is asked');
      const other = await pickNimModel({ baseUrl: api.url, key: 'nvapi-x', avoid: [SECOND] }).catch((e: Error) => e);
      assert.match((other as Error).message, /lists none of the models braid knows/, 'a model that was just found retired is not chosen again');
    } finally {
      await api.close();
    }
  });

  it('says what to do when the service lists none of the models braid knows', async () => {
    const api = await fakeNim(['acme/some-instruct-model', 'acme/embed-1b'], () => ok());
    try {
      await assert.rejects(pickNimModel({ baseUrl: api.url, key: 'nvapi-x' }), /lists none of the models braid knows to handle tool calls.*Braid > Settings.*acme\/some-instruct-model/);
    } finally {
      await api.close();
    }
  });

  it('stops at once when the key is rejected, instead of trying every model', async () => {
    const api = await fakeNim([BEST, SECOND, THIRD], () => ({ status: 403, body: { detail: 'forbidden' } }));
    try {
      await assert.rejects(pickNimModel({ baseUrl: api.url, key: 'nvapi-x' }), /rejected the API key \(HTTP 403\)/);
      assert.equal(api.chats.length, 1);
    } finally {
      await api.close();
    }
  });

  it('reports every model that was tried when none answers', async () => {
    const api = await fakeNim([BEST, SECOND], () => ({ status: 503, body: { detail: 'overloaded' } }));
    try {
      await assert.rejects(pickNimModel({ baseUrl: api.url, key: 'nvapi-x' }), new RegExp(`None of the models braid tries.*${BEST}.*busy or failing \\(HTTP 503\\).*${SECOND}`));
    } finally {
      await api.close();
    }
  });

  it('recognizes how NIM announces a retired model', () => {
    assert.equal(isRetired(410, ''), true);
    assert.equal(isRetired(404, 'This model has reached its end of life'), true);
    assert.equal(isRetired(404, 'no such route'), false);
    assert.equal(isRetired(400, 'end of life'), false);
  });
});

describe('the NIM driver and a retired model', () => {
  const cwd = () => {
    const d = mkdtempSync(join(tmpdir(), 'braid-nim-'));
    temps.push(d);
    writeFileSync(join(d, 'a.txt'), 'x\n');
    return d;
  };
  const make = (url: string, resolve = true) => {
    process.env.BRAID_TEST_NIM_KEY2 = 'nvapi-x';
    return new OpenAICompatDriver({
      name: 'nim',
      label: 'NVIDIA NIM',
      baseUrl: url,
      keyEnv: 'BRAID_TEST_NIM_KEY2',
      defaultModel: BEST,
      retryDelayMs: 1,
      ...(resolve ? { resolveModel: async (key, signal, avoid) => (await pickNimModel({ baseUrl: url, key, signal, avoid })).model } : {}),
    });
  };
  const run = (d: OpenAICompatDriver, model?: string) => {
    const events: AgentEvent[] = [];
    return d.run({ prompt: 'p', cwd: cwd(), model, allowedTools: ['Read'], canEdit: false, onEvent: (e) => events.push(e) }).then((res) => ({ res, events }));
  };

  it('uses a model that works when the plan and Settings name none', async () => {
    const api = await fakeNim([BEST, SECOND], (m) => (m === BEST ? { status: 410, body: RETIRED_BODY(m) } : ok('all good')));
    try {
      const { res } = await run(make(api.url));
      assert.equal(res.ok, true, res.text);
      assert.equal(res.text, 'all good');
      assert.equal(api.chats.at(-1)!.model, SECOND, 'the real request went to the model that passed the probe');
    } finally {
      await api.close();
    }
  });

  it('uses exactly the model that was named, without asking NVIDIA which models there are or testing it first', async () => {
    const api = await fakeNim([BEST, SECOND], () => ok('as asked'));
    try {
      const { res } = await run(make(api.url), 'acme/the-one-the-user-chose');
      assert.equal(res.ok, true, res.text);
      assert.deepEqual(api.chats.map((c) => c.model), ['acme/the-one-the-user-chose'], 'one request, to the chosen model');
      assert.equal(api.lists(), 0, 'the model list was never read');
    } finally {
      await api.close();
    }
  });

  it('switches once, and says so, when the model that was named has been retired', async () => {
    const api = await fakeNim([SECOND], (m) => (m === 'meta/llama-3.3-70b-instruct' ? { status: 410, body: RETIRED_BODY(m) } : ok('finished')));
    try {
      const { res, events } = await run(make(api.url), 'meta/llama-3.3-70b-instruct');
      assert.equal(res.ok, true, res.text);
      assert.equal(api.chats[0]!.model, 'meta/llama-3.3-70b-instruct');
      assert.equal(api.chats.at(-1)!.model, SECOND);
      const note = events.find((e) => e.kind === 'text' && /has retired meta\/llama-3\.3-70b-instruct/.test(e.text));
      assert.ok(note, 'the transcript says which model was dropped and which is used');
    } finally {
      await api.close();
    }
  });

  it('fails with a plain message when the named model is retired and nothing can replace it', async () => {
    const api = await fakeNim(['acme/nothing-braid-knows'], (m) => ({ status: 410, body: RETIRED_BODY(m) }));
    try {
      const { res } = await run(make(api.url), 'meta/llama-3.3-70b-instruct');
      assert.equal(res.ok, false);
      assert.match(res.text, /has retired the model meta\/llama-3\.3-70b-instruct \(HTTP 410\).*leave the model empty/);
      assert.match(res.text, /No replacement could be chosen/);
    } finally {
      await api.close();
    }
  });

  it('without a resolver, a retired model is a clear error, not a mystery', async () => {
    const api = await fakeNim([], (m) => ({ status: 410, body: RETIRED_BODY(m) }));
    try {
      const { res } = await run(make(api.url, false), 'meta/llama-3.3-70b-instruct');
      assert.equal(res.ok, false);
      assert.match(res.text, /has retired the model meta\/llama-3\.3-70b-instruct/);
      assert.ok(new RetiredModelError('m', 'x') instanceof Error);
    } finally {
      await api.close();
    }
  });
});

describe('Settings > Test connection for NIM', () => {
  const env = (url: string) => ({ NVIDIA_API_KEY: 'nvapi-x', BRAID_NIM_BASE_URL: url });

  it('with no model chosen, finds the one a run would use and says which', async () => {
    const api = await fakeNim([BEST, SECOND], (m) => (m === BEST ? { status: 410, body: RETIRED_BODY(m) } : ok()));
    try {
      const res = await testProvider('nim', undefined, env(api.url));
      assert.equal(res.ok, true, JSON.stringify(res.steps));
      const step = res.steps.find((s) => s.name === 'Model chosen automatically')!;
      assert.ok(step.ok);
      assert.match(step.detail, new RegExp(`${SECOND.replace(/[/.]/g, '\\$&')} is available and accepts tool calls`));
      assert.match(step.detail, /passed over: .*retired/);
    } finally {
      await api.close();
    }
  });

  it('with a model that is gone from the list, says it may have been retired and names models that work', async () => {
    const api = await fakeNim([BEST, SECOND], () => ok());
    try {
      const res = await testProvider('nim', 'meta/llama-3.3-70b-instruct', env(api.url));
      assert.equal(res.ok, false);
      const step = res.steps.find((s) => s.name === 'Model is available')!;
      assert.match(step.detail, /retires models without notice.*for example nvidia\/nemotron-3-super-120b-a12b/);
    } finally {
      await api.close();
    }
  });

  it('with a model that is listed but retired, says so', async () => {
    const api = await fakeNim(['meta/llama-3.3-70b-instruct'], (m) => ({ status: 410, body: RETIRED_BODY(m) }));
    try {
      const res = await testProvider('nim', 'meta/llama-3.3-70b-instruct', env(api.url));
      assert.equal(res.ok, false);
      assert.match(res.steps.at(-1)!.detail, /has been retired by NVIDIA NIM.*clear the field/);
    } finally {
      await api.close();
    }
  });
});
