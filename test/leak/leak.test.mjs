// A test file for the cleanup test (take-repair5.test.mjs), not part of the suite (npm test runs test/*.test.mjs only): its one test fails before it closes
// its fake OBS, its in-process server and its server process. SIMULATED: fake OBS only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, obsConfigDir, testEnv } from '../helpers.mjs';
import { accept } from '../mcp-pair.mjs';
import { server, world } from '../take-app.mjs';

test('fails with a fake OBS, a server and a server process open', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'leak-token-1' });
  await connect(testEnv(obsConfigDir(null), w.fake.port), { elicit: accept });
  assert.equal('open', 'closed');
});
