// The property test of the settings allow-list: a unique secret in every string inside the settings of every fake
// OBS reply, at any depth and in nested arrays, never reaches the model. It drives the server over stdio, as a client does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { startFakeObs } from './fake-obs.mjs';
import { connect, obsConfigDir, sampleParams, testEnv } from './helpers.mjs';

const CATALOGUE = JSON.parse(readFileSync(new URL('../dist/catalogue.json', import.meta.url), 'utf8'));
const SETTINGS_READS = ['GetInputSettings', 'GetInputDefaultSettings', 'GetOutputSettings', 'GetSourceFilter', 'GetSourceFilterList',
  'GetSourceFilterDefaultSettings', 'GetStreamServiceSettings', 'GetCurrentSceneTransition', 'GetPersistentData'];

test('a secret planted in any string of any settings never appears in a reply', async () => {
  const fake = await startFakeObs({ plant: true });
  const s = await connect(testEnv(obsConfigDir({ server_enabled: true, server_port: fake.port, auth_required: false }), fake.port));
  for (const e of CATALOGUE) await s.call('obs_read', { request: e.request, params: sampleParams(e) });
  await s.call('obs_read', { request: 'GetInputSettings', params: { inputName: 'Display' } });
  await s.call('obs_read', { request: 'GetInputDefaultSettings', params: { inputKind: 'screen_capture' } });
  await s.call('obs_read', { request: 'GetSourceFilterDefaultSettings', params: { filterKind: 'scale_filter' } });
  await s.call('obs_read', { request: 'GetPersistentData', params: { realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL', slotName: 'blob' } });
  await s.close();
  await fake.close();
  for (const r of SETTINGS_READS) assert.ok(fake.log.includes(r), `${r} reached the fake OBS`);
  assert.ok(fake.planted.length > 200, `${fake.planted.length} secrets planted`);
  const all = s.replies.join('\n');
  assert.match(all, /"volume":0\.5/, 'numbers inside settings still pass');
  const leaked = fake.planted.filter((p) => all.includes(p));
  assert.deepEqual(leaked, [], `${leaked.length} of ${fake.planted.length} planted secrets reached the model`);
});
