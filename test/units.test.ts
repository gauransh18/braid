import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GeminiDriver, GeminiStreamParser } from '../src/drivers/gemini.js';
import { addTokens, describeTokens, formatCost, formatTokens } from '../src/tokens.js';
import { ClaudeDriver, claudeTokens, parseClaudeLine } from '../src/drivers/claude.js';
import { estimateCostUsd, priceFor } from '../src/pricing.js';
import { validatePlan } from '../src/plan.js';
import { extractJson } from '../src/prompts.js';

describe('validatePlan', () => {
  const t = (id: string, deps: string[] = []) => ({ id, title: id, prompt: 'p', deps });

  it('rejects cycles', () => {
    assert.throws(() => validatePlan({ goal: 'g', tasks: [t('a', ['b']), t('b', ['a'])] }), /cycle: a -> b -> a/);
  });

  it('rejects unknown deps and duplicate ids', () => {
    assert.throws(() => validatePlan({ goal: 'g', tasks: [t('a', ['zz']), t('a')] }), /duplicate[\s\S]*unknown "zz"/);
  });

  it('accepts a DAG', () => {
    validatePlan({ goal: 'g', tasks: [t('a'), t('b', ['a']), t('c', ['a', 'b'])] });
  });
});

describe('claude driver', () => {
  it('parses stream-json lines', () => {
    assert.deepEqual(parseClaudeLine('{"type":"system","subtype":"init","session_id":"s1","model":"m"}'), [
      { kind: 'start', sessionId: 's1', model: 'm' },
    ]);
    assert.deepEqual(
      parseClaudeLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","name":"Edit","input":{"a":1}}]}}'),
      [
        { kind: 'text', text: 'hi' },
        { kind: 'tool', name: 'Edit', input: { a: 1 } },
      ],
    );
    const [r] = parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.25,"session_id":"s1","num_turns":3}');
    assert.deepEqual(r, { kind: 'result', ok: true, text: 'done', costUsd: 0.25, tokens: undefined, sessionId: 's1', turns: 3 });
    assert.equal(parseClaudeLine('{"type":"system","subtype":"hook_started"}').length, 0);
  });

  it('strips write tools and denies them for read-only agents', () => {
    const args = new ClaudeDriver('claude').buildArgs({ prompt: '', cwd: '.', allowedTools: ['Read', 'Edit'], canEdit: false });
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read');
    assert.ok(args[args.indexOf('--disallowedTools') + 1]!.includes('Write'));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  });

  it('isolates agents from personal settings, plugins and MCP servers', () => {
    const args = new ClaudeDriver('claude').buildArgs({ prompt: '', cwd: '.', allowedTools: [], canEdit: true });
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'project,local');
    assert.ok(args.includes('--strict-mcp-config'));
  });
});

describe('extractJson', () => {
  it('handles fences and surrounding prose', () => {
    assert.deepEqual(extractJson('Sure:\n```json\n{"a": 1}\n```\nbye'), { a: 1 });
    assert.deepEqual(extractJson('verdict {"approve": true} end'), { approve: true });
    assert.equal(extractJson('no json'), null);
  });
});

describe('gemini driver', () => {
  const run = (lines: object[], code = 0) => {
    const p = new GeminiStreamParser();
    const events = lines.flatMap((l) => p.feed(JSON.stringify(l)));
    return { events, res: p.finish(code, '') };
  };

  it('builds read-only args for reviewers and auto_edit for workers', () => {
    const d = new GeminiDriver('gemini');
    const base = { prompt: 'p', cwd: '.', allowedTools: [] };
    const worker = d.buildArgs({ ...base, canEdit: true, model: 'gemini-2.5-pro' });
    assert.deepEqual(worker.slice(worker.indexOf('--approval-mode'), worker.indexOf('--approval-mode') + 2), ['--approval-mode', 'auto_edit']);
    assert.ok(worker.includes('gemini-2.5-pro'));
    assert.ok(d.buildArgs({ ...base, canEdit: false }).includes('plan'));
  });

  it('keeps only the text after the last tool call as the answer', () => {
    const { events, res } = run([
      { type: 'init', session_id: 's1', model: 'm' },
      { type: 'message', role: 'user', content: 'do it' },
      { type: 'message', role: 'assistant', content: 'Let me look. ', delta: true },
      { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { path: 'a' } },
      { type: 'tool_result', tool_id: 't1', status: 'success', output: 'hello' },
      { type: 'message', role: 'assistant', content: 'All ', delta: true },
      { type: 'message', role: 'assistant', content: 'done.', delta: true },
      { type: 'result', status: 'success', stats: {} },
    ]);
    assert.deepEqual(events.map((e) => e.kind), ['start', 'text', 'tool', 'tool_result', 'text', 'text']);
    assert.deepEqual(res, { ok: true, text: 'All done.', costUsd: 0, tokens: { input: 0, cached: 0, output: 0 }, costEstimated: true, sessionId: 's1' }, 'no stats: zero tokens, still flagged as an estimate');
  });

  it('reports failure from an error result or a missing result', () => {
    const failed = run([{ type: 'init', session_id: 's' }, { type: 'result', status: 'error', error: { type: 'X', message: 'quota exceeded' } }]);
    assert.equal(failed.res.ok, false);
    assert.match(failed.res.text, /quota exceeded/);
    assert.equal(run([{ type: 'message', role: 'assistant', content: 'x' }], 1).res.ok, false);
    assert.equal(run([{ type: 'result', status: 'success' }], 1).res.ok, false, 'non-zero exit is failure even after a success result');
  });
});

describe('pricing', () => {
  it('picks the longest matching model prefix', () => {
    assert.equal(priceFor('gemini-2.5-flash-lite-preview')?.input, 0.1);
    assert.equal(priceFor('gemini-2.5-flash')?.input, 0.3);
    assert.equal(priceFor('unknown-model'), undefined);
    assert.equal(priceFor('unknown-model', 'gemini-2.5-pro')?.input, 1.25);
  });

  it('prices fresh, cached and output tokens separately', () => {
    // 1M fresh in ($1.25) + 1M cached ($0.125) + 1M out ($10) on gemini-2.5-pro
    const usd = estimateCostUsd([{ model: 'gemini-2.5-pro', input: 1e6, cached: 1e6, output: 1e6 }]);
    assert.ok(Math.abs(usd - 11.375) < 1e-9);
    assert.equal(estimateCostUsd([{ model: 'mystery', input: 1e6, output: 1e6 }]), 0);
  });

  it('turns gemini result stats into a spend estimate', () => {
    const p = new GeminiStreamParser('gemini-2.5-flash');
    p.feed(JSON.stringify({ type: 'init', session_id: 's', model: 'gemini-2.5-flash' }));
    p.feed(JSON.stringify({ type: 'message', role: 'assistant', content: 'ok', delta: true }));
    p.feed(JSON.stringify({ type: 'result', status: 'success', stats: { models: { 'gemini-2.5-flash': { input_tokens: 2_000_000, cached: 1_000_000, input: 1_000_000, output_tokens: 1_000_000 } } } }));
    // 1M fresh @0.30 + 1M cached @0.03 + 1M out @2.50
    assert.ok(Math.abs(p.finish(0, '').costUsd - 2.83) < 1e-9);
  });
});

describe('tokens', () => {
  it('maps Claude usage: cache writes are fresh input, cache reads are cached', () => {
    assert.deepEqual(claudeTokens({ input_tokens: 2, cache_creation_input_tokens: 6356, cache_read_input_tokens: 21442, output_tokens: 4 }), { input: 6358, cached: 21442, output: 4 });
    assert.equal(claudeTokens(undefined), undefined);
    const [r] = parseClaudeLine('{"type":"result","subtype":"success","result":"x","total_cost_usd":0.05,"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":5}}');
    assert.deepEqual((r as { tokens?: unknown }).tokens, { input: 10, cached: 90, output: 5 });
  });

  it('formats counts and marks estimated dollars', () => {
    assert.equal(formatTokens(950), '950');
    assert.equal(formatTokens(12_340), '12.3k');
    assert.equal(formatTokens(4_560_000), '4.56M');
    assert.equal(formatCost(0.1234, true), '~$0.12');
    assert.equal(formatCost(0.1234), '$0.12');
    assert.equal(describeTokens({ input: 1000, cached: 2000, output: 500 }), '3.5k tok (fresh 1k, cached 2k, out 500)');
    assert.equal(describeTokens(undefined), '-');
    assert.deepEqual(addTokens({ input: 1, cached: 2, output: 3 }, undefined), { input: 1, cached: 2, output: 3 });
  });

  it('gemini reports tokens and flags its dollars as estimated', () => {
    const p = new GeminiStreamParser('gemini-2.5-flash');
    p.feed(JSON.stringify({ type: 'init', session_id: 's', model: 'gemini-2.5-flash' }));
    p.feed(JSON.stringify({ type: 'result', status: 'success', stats: { models: { 'gemini-2.5-flash': { input_tokens: 300, cached: 100, input: 200, output_tokens: 50 } } } }));
    const r = p.finish(0, '');
    assert.deepEqual(r.tokens, { input: 200, cached: 100, output: 50 });
    assert.equal(r.costEstimated, true);
  });
});
