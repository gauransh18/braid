import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DriverRegistry } from '../src/drivers/driver.js';
import { MockDriver } from '../src/drivers/mock.js';
import { RunManager } from '../src/runs.js';

const manager = () =>
  new RunManager(
    '/nowhere',
    () => new DriverRegistry().register(new MockDriver(undefined, 'claude')).register(new MockDriver(undefined, 'codex')).register(new MockDriver(undefined, 'gemini')).register(new MockDriver(undefined, 'nim')),
  );

describe('which agent a run uses when the plan names none', () => {
  it('is the default agent from Settings', () => {
    const m = manager();
    m.applySettings({ defaults: { driver: 'codex', disabled: [] } });
    assert.equal(m.effectiveDriver(), 'codex');
  });

  it('skips agents that are switched off: someone who only uses NIM gets NIM, not Claude', () => {
    const m = manager();
    // Switching off Claude, Codex and Gemini leaves no default chosen, which is how the page used to end up saying "claude".
    m.applySettings({ defaults: { disabled: ['claude', 'codex', 'gemini'] } });
    assert.equal(m.effectiveDriver(), 'nim');
  });

  it('does not use a default that has been switched off', () => {
    const m = manager();
    m.applySettings({ defaults: { driver: 'claude', disabled: ['claude'] } });
    assert.equal(m.effectiveDriver(), 'codex');
  });
});
