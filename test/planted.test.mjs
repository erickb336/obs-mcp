// The property test of the redaction: the fake OBS plants a unique secret in every string value and every free-form
// key of every reply, at any depth (see plantReply in fake-obs.mjs). A secret may reach the model only in a field of
// the literal list below: names, kinds, UUIDs, states and folders, which the design lets through. The list is written
// out here, not taken from the server, so that a field the server misses fails the test.
// It drives the server over stdio, as a client does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OBSWebSocket } from 'obs-websocket-js/json';
import { startFakeObs } from './fake-obs.mjs';
import { connect, obsConfigDir, sampleParams, testEnv } from './helpers.mjs';

const CATALOGUE = JSON.parse(readFileSync(new URL('../dist/catalogue.json', import.meta.url), 'utf8'));
const SETTINGS_READS = ['GetInputSettings', 'GetInputDefaultSettings', 'GetOutputSettings', 'GetSourceFilter', 'GetSourceFilterList',
  'GetSourceFilterDefaultSettings', 'GetStreamServiceSettings', 'GetCurrentSceneTransition', 'GetPersistentData'];

const MAY_PASS = new Set([
  // Names and UUIDs of scenes, inputs, sources, filters, outputs, transitions, profiles and scene collections.
  'sceneName', 'sceneUuid', 'currentProgramSceneName', 'currentProgramSceneUuid', 'currentPreviewSceneName', 'currentPreviewSceneUuid',
  'inputName', 'inputUuid', 'sourceName', 'sourceUuid', 'filterName', 'outputName', 'transitionName', 'transitionUuid',
  'currentSceneTransitionName', 'currentSceneTransitionUuid', 'currentProfileName', 'currentSceneCollectionName',
  'desktop1', 'desktop2', 'mic1', 'mic2', 'mic3', 'mic4',
  // Kinds and states.
  'inputKind', 'unversionedInputKind', 'filterKind', 'outputKind', 'transitionKind', 'currentSceneTransitionKind', 'streamServiceType',
  'inputDeinterlaceMode', 'inputDeinterlaceFieldOrder', 'monitorType', 'mediaState', 'sceneItemBlendMode', 'outputTimecode',
  // Folders and files that OBS writes to.
  'recordDirectory', 'savedReplayPath',
]);

test('F-T12-41: a secret planted in any string or key of any reply reaches the model only in a field that may pass', async () => {
  const fake = await startFakeObs({ plant: true });
  const s = await connect(testEnv(obsConfigDir({ server_enabled: true, server_port: fake.port, auth_required: false }), fake.port));
  await s.call('obs_status');
  for (const e of CATALOGUE) await s.call('obs_read', { request: e.request, params: sampleParams(e) });
  await s.call('obs_read', { request: 'GetInputSettings', params: { inputName: 'Display' } });
  await s.call('obs_read', { request: 'GetInputDefaultSettings', params: { inputKind: 'screen_capture' } });
  await s.call('obs_read', { request: 'GetSourceFilterDefaultSettings', params: { filterKind: 'scale_filter' } });
  await s.call('obs_read', { request: 'GetPersistentData', params: { realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL', slotName: 'blob' } });
  await s.close();
  await fake.close();
  for (const r of SETTINGS_READS) assert.ok(fake.log.includes(r), `${r} reached the fake OBS`);
  assert.ok(fake.planted.length > 400, `${fake.planted.length} secrets planted`);
  const inSettings = fake.planted.filter((p) => ['inputSettings', 'filterSettings', 'slotValue'].includes(p.field));
  assert.ok(inSettings.length > 100, `${inSettings.length} secrets planted inside settings, keys and values`);
  const all = s.replies.join('\n');
  assert.match(all, /:0\.5[,}]/, 'numbers inside settings still pass');
  const seen = fake.planted.filter((p) => all.includes(p.secret));
  assert.ok(seen.some((p) => p.field === 'sceneName'), 'a name passes, so the scan can see a planted secret');
  const leaked = seen.filter((p) => !MAY_PASS.has(p.field)).map((p) => p.field);
  assert.deepEqual([...new Set(leaked)], [], `${leaked.length} of ${fake.planted.length} planted secrets reached the model`);
});

test('F-T12-41: in a raw reply, the planted keys and values of a slot value are there, so the scan above can see a leak', async () => {
  const fake = await startFakeObs({ plant: true });
  const ws = new OBSWebSocket();
  await ws.connect(`ws://127.0.0.1:${fake.port}`);
  const raw = JSON.stringify(await ws.call('GetPersistentData', { realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL', slotName: 'blob' }));
  await ws.disconnect();
  await fake.close();
  const seen = fake.planted.filter((p) => raw.includes(`"${p.secret}":`));
  assert.ok(seen.length > 20, `${seen.length} planted keys in the raw reply`);
  assert.deepEqual([...new Set(seen.map((p) => p.field))], ['slotValue']);
  assert.equal(MAY_PASS.has('slotValue'), false);
});
