import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClaudeDriver, parseClaudeLine } from '../src/drivers/claude.js';
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
    assert.deepEqual(r, { kind: 'result', ok: true, text: 'done', costUsd: 0.25, sessionId: 's1', turns: 3 });
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
