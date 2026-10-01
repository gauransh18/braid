import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// The desktop app asks its sidecar to quit and kills it when GRACE (desktop/src-tauri/src/sidecar.rs) has passed. The
// sidecar gives a run's wind-down its own budget (src/cli.ts) before it saves, kills what is left and exits. If the
// app's wait is the shorter of the two, a slow Stop is cut off by SIGKILL in the middle of the save and the run is
// left "running" with a dead process. The two numbers live in different languages, so this reads both.
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

describe('the desktop app and its sidecar', () => {
  it('lets the sidecar finish stopping a run before the app kills it', () => {
    const grace = Number(/pub const GRACE: Duration = Duration::from_secs\((\d+)\)/.exec(read('desktop/src-tauri/src/sidecar.rs'))?.[1]);
    const budget = Number(/stopActiveRun\((\d[\d_]*)\)/.exec(read('src/cli.ts'))?.[1]?.replace(/_/g, '')) / 1000;
    assert.ok(Number.isFinite(grace) && Number.isFinite(budget), 'both numbers are found');
    assert.ok(grace >= budget + 3, `the app waits ${grace} s but the sidecar may take ${budget} s to stop a run and save it; it needs a few seconds more`);
  });
});
