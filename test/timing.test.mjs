// The timing loop runs on the fake OBS and times each request it sends. SIMULATED: no real OBS.
// The release numbers come from a longer run (see the README); this test checks that the loop works.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/timing-loop.mjs', import.meta.url));

test('the timing loop times 20 rounds on the fake OBS, and each timed request reached it', () => {
  const r = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--count', '20', '--warmup', '2'], { encoding: 'utf8' }));
  assert.equal(r.target, 'fake OBS (SIMULATED), in the same process as the timing client, on 127.0.0.1');
  assert.equal(r.requests, 20);
  assert.equal(r.requests_that_reached_the_fake, 2 * 22 + 1);
  for (const k of ['added_ms', 'through_server_ms', 'direct_ms']) assert.ok(r[k].median > 0 && r[k].p95 >= r[k].median, `${k}: ${JSON.stringify(r[k])}`);
  assert.equal(r.pass, r.added_ms.median < 20);
});
