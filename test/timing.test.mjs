// The timing loop runs on the fake OBS and times each request it sends. SIMULATED: no real OBS.
// The release numbers come from a longer run (see the README).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/timing-loop.mjs', import.meta.url));

test('F-T6-5: on the fake OBS, the median added time per request is under the 20 ms target of R41', () => {
  const r = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--count', '20', '--warmup', '2'], { encoding: 'utf8' }));
  assert.equal(r.target, 'fake OBS (SIMULATED), in the same process as the timing client, on 127.0.0.1');
  assert.equal(r.requests, 20);
  assert.equal(r.requests_that_reached_the_fake, 2 * 22 + 1);
  for (const k of ['added_ms', 'through_server_ms', 'direct_ms']) assert.ok(r[k].median > 0 && r[k].p95 >= r[k].median, `${k}: ${JSON.stringify(r[k])}`);
  assert.ok(r.added_ms.median < 20, `median added ${r.added_ms.median} ms`);
  assert.equal(r.pass, true);
});

test('F-T6-10: a bad option or a closed port ends the timing loop with a one-line reason and exit 1', async () => {
  // A port that was free a moment ago, and that nothing listens on now.
  const port = await new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  const cases = [
    [['--count', '0'], 'timing-loop: --count must be a whole number of 1 or more.'],
    [['--count', 'abc'], 'timing-loop: --count must be a whole number of 1 or more.'],
    [['--warmup=-1'], 'timing-loop: --warmup must be a whole number of 0 or more.'],
    [['--url', 'ws://192.0.2.10:4455'], 'timing-loop: the URL must be ws://127.0.0.1:<port>: the server connects to loopback only.'],
    [['--url', 'not a url'], 'timing-loop: the URL must be ws://127.0.0.1:<port>: the server connects to loopback only.'],
    [['--speed', '9'], 'timing-loop: unknown argument. Options: --url, --count, --warmup.'],
  ];
  for (const [args, message] of cases) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    assert.deepEqual([r.status, r.stderr], [1, `${message}\n`], args.join(' '));
  }
  const closed = spawnSync(process.execPath, [SCRIPT, '--url', `ws://127.0.0.1:${port}`], { encoding: 'utf8' });
  assert.equal(closed.status, 1);
  assert.match(closed.stderr, new RegExp(`^timing-loop: no connection to OBS on 127\\.0\\.0\\.1:${port}: .+\\n$`));
});
