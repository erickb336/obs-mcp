// A15, the stop-rule sweep: the server never stops a recording unless the user asks. SIMULATED: fake OBS.
// During a take, each of the 147 documented requests goes through the server, and so do the list rows that close
// real OBS with 1006. A crash counts as a stop. The first test shows that the fake OBS sees a stop when one happens,
// so the 0 of the second test means something. At 0.1 this proves the routing of obs_read only.
// F-T27-1: both tests run during a take alone and during a take with a live stream, because the real record trace was
// captured with no stream.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connectionTarget, Obs } from '../dist/obs.js';
import { startFakeObs } from './fake-obs.mjs';
import { connect, obsConfigDir, sampleParams, testEnv } from './helpers.mjs';

const CATALOGUE = JSON.parse(readFileSync(new URL('../dist/catalogue.json', import.meta.url), 'utf8'));
const CLASS = Object.fromEntries(CATALOGUE.map((e) => [e.request, e.class]));
// The values that make a request harmful during a take: the record output, the stop hotkey, and a list row that crashes OBS.
const HARMFUL = { outputName: 'simple_file_output', hotkeyName: 'OBSBasic.StopRecording', inputName: 'App audio', propertyName: 'application' };
const paramsFor = (e) => Object.fromEntries(Object.entries(sampleParams(e)).map(([k, v]) => [k, HARMFUL[k] ?? v]));
const UNCLEARED_ROWS = [
  { inputName: 'App audio', propertyName: 'application' },
  { inputName: 'Display', propertyName: 'display_uuid' },
];
const TAKES = { 'a take': { recording: true }, 'a take with a live stream': { recording: true, streaming: true } };

for (const [take, outputs] of Object.entries(TAKES)) {
  test(`sent straight to the fake OBS during ${take}, 6 of the 147 requests stop the recording, a crash included`, async () => {
    assert.equal(CATALOGUE.length, 147);
    const stopping = [];
    for (const e of CATALOGUE) {
      const fake = await startFakeObs(outputs);
      const obs = new Obs(() => connectionTarget(obsConfigDir(null), testEnv('', fake.port)), { connectMs: 2000, callMs: 2000 });
      await obs.call(e.request, paramsFor(e)).catch(() => {});
      await obs.close();
      await fake.close();
      if (fake.stops.length) stopping.push(`${e.request} (${fake.stops.map((s) => s.cause).join()})`);
    }
    assert.deepEqual(stopping.sort(), ['GetInputPropertiesListPropertyItems (crash)', 'StopOutput (request)', 'StopRecord (request)', 'ToggleOutput (request)', 'ToggleRecord (request)', 'TriggerHotkeyByName (request)']);
  });

  test(`A15: during ${take}, the 147 requests and the uncleared list rows through the server give 0 stops and 0 crashes`, async () => {
    const fake = await startFakeObs(outputs);
    const s = await connect(testEnv(obsConfigDir(null), fake.port));
    let refused = 0;
    for (const e of CATALOGUE) refused += (await s.call('obs_read', { request: e.request, params: paramsFor(e) })).isError;
    for (const params of UNCLEARED_ROWS) {
      const r = await s.call('obs_read', { request: 'GetInputPropertiesListPropertyItems', params });
      assert.match(r.json.refused, /a recording is active, and a list request can crash OBS\. It was not sent\.$/);
    }
    const status = await s.call('obs_status');
    const alive = (() => { try { return process.kill(s.pid(), 0); } catch { return false; } })();
    await s.close();
    await fake.close();
    console.log(`A15 sweep during ${take}: ${CATALOGUE.length} requests and ${UNCLEARED_ROWS.length} uncleared list rows, ${refused + UNCLEARED_ROWS.length} refused; stops ${fake.stops.length}, crashes ${fake.crashes()}`);
    assert.deepEqual(fake.stops, []);
    assert.equal(fake.crashes(), 0);
    assert.deepEqual([fake.state.recording, fake.state.streaming], [true, !!outputs.streaming]);
    assert.equal(alive, true, 'the server process still runs');
    assert.equal(status.json.connected, true);
    assert.equal(status.json.recording.active, true);
    // Only reads reached OBS, and the one guarded read that is safe during a take.
    assert.deepEqual([...new Set(fake.log.filter((n) => CLASS[n] !== 'read'))], ['GetStreamServiceSettings']);
  });
}
