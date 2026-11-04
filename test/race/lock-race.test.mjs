// G32: the lock race. n processes take the controller lock of one OBS endpoint at the same moment, 40 rounds each, and
// exactly one controls each time. npm test runs this file after the other tests, alone, so that its hundreds of
// process starts do not slow the timing tests of the other files. SIMULATED: no OBS.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tracked } from '../cleanup.mjs';

const CHILD = fileURLToPath(new URL('../lock-child.mjs', import.meta.url));
const endpoint = () => `ws://127.0.0.1:${1 + Math.floor(Math.random() * 65535)}/race-${process.pid}-${Math.random()}`;

/** n lock children of one endpoint take the lock at the same moment. Returns their answers. */
async function race(n, ep) {
  const kids = Array.from({ length: n }, () => spawn(process.execPath, [CHILD, ep], { stdio: ['pipe', 'pipe', 'inherit'] }));
  const kill = tracked(() => kids.forEach((k) => k.kill()));
  const lines = kids.map((k) => createInterface({ input: k.stdout })[Symbol.asyncIterator]());
  for (const l of lines) assert.equal((await l.next()).value, 'ready');
  for (const k of kids) k.stdin.write('go\n');
  const answers = await Promise.all(lines.map(async (l) => (await l.next()).value));
  await Promise.all(kids.map((k) => new Promise((r) => (k.once('exit', r), k.stdin.end()))));
  await kill();
  return answers;
}

for (const n of [2, 3, 8]) {
  test(`F-T7-63, F-T7-68, F-T7-71, F-T7-72: ${n} processes take the lock of one OBS at the same moment, 40 rounds: exactly one controls each time`, async () => {
    const ep = endpoint();
    const bad = [];
    for (let round = 1; round <= 40; round++) {
      const answers = await race(n, ep);
      if (answers.filter((a) => a === 'controls').length !== 1 || answers.filter((a) => a === 'reads').length !== n - 1) bad.push(`round ${round}: ${answers.join(',')}`);
    }
    assert.deepEqual(bad, []);
  });
}
