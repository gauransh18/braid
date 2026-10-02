import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');

describe('the guided start screen (a repository with no runs yet)', () => {
  it('hides only the header\'s own buttons, never the plan screen\'s Start run', () => {
    // The plan screen has an `.actions` row of its own (Back, Start run). A rule for `.actions` alone also matched it, and
    // the guided start could not start a run: the button was there but display:none.
    const rules = html.split('\n').filter((l) => l.includes('body.start-mode') && /\.actions\s*>/.test(l));
    assert.ok(rules.length > 0, 'the rule that tidies the header exists');
    for (const rule of rules) {
      for (const selector of rule.split('{')[0]!.split(',').filter((s) => /\.actions/.test(s))) {
        assert.match(selector, /header\.top\s+\.actions/, `scoped to the header: ${selector.trim()}`);
      }
    }
    assert.match(html, /data-a="start">Start run<\/button>/, 'the plan screen still has its Start run button');
  });

  it('shows the agent the server says a run will use, not a guess', () => {
    assert.match(html, /plan\.driver \|\| effectiveAgent/);
    assert.match(html, /effectiveAgent = st\.agent/);
    assert.doesNotMatch(html, /plan\.driver \|\| defaults\.driver \|\| 'claude';\s*\n\s*const model/, 'no longer falls straight back to claude');
  });
});
