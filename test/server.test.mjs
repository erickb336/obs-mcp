// The server over stdio, driven by the official SDK client, against the fake OBS. SIMULATED: no real OBS.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, describe, test } from 'node:test';
import { getEncoding } from 'js-tiktoken';
import { OBSWebSocket } from 'obs-websocket-js/json';
import { DISPLAY_UUID, startFakeObs, PRIVATE_REQUESTS } from './fake-obs.mjs';
import { closedPort, connect, obsConfigDir, sampleParams, testEnv } from './helpers.mjs';

const CATALOGUE = JSON.parse(readFileSync(new URL('../dist/catalogue.json', import.meta.url), 'utf8'));
const CLASS = Object.fromEntries(CATALOGUE.map((e) => [e.request, e.class]));
const PASSWORD = 'fake-obs-password-7Qx2';

for (const era of ['legacy', 'modern']) {
  describe(`tools on the ${era} protocol era`, () => {
    test('tools/list has the 3 tools, all read-only, within 1,200 tokens', async () => {
      // Method: compact JSON of the tools array, tokens by cl100k_base through js-tiktoken 1.0.21.
      // cl100k_base is an approximation: it is not the tokenizer of any Claude model.
      const s = await connect(testEnv(obsConfigDir(null), await closedPort()), { era });
      const { tools } = await s.client.listTools();
      const version = s.client.getNegotiatedProtocolVersion();
      await s.close();
      if (era === 'modern') assert.equal(version, '2026-07-28');
      else assert.notEqual(version, '2026-07-28');
      assert.deepEqual(tools.map((t) => t.name).sort(), ['obs_find', 'obs_read', 'obs_status']);
      assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
      const tokens = getEncoding('cl100k_base').encode(JSON.stringify(tools)).length;
      console.log(`tools/list (${era}, protocol ${version}): ${Buffer.byteLength(JSON.stringify(tools))} bytes, ${tokens} cl100k_base tokens`);
      assert.ok(tokens <= 1200, `${tokens} tokens`);
    });
  });
}

test('obs_status with OBS closed says so plainly, and what to do', async () => {
  const s = await connect(testEnv(obsConfigDir({ server_enabled: true, server_port: 1, auth_required: false }), await closedPort()));
  const r = await s.call('obs_status');
  await s.close();
  assert.equal(r.json.connected, false);
  assert.match(r.json.problem, /^No answer from OBS on 127\.0\.0\.1:\d+\. OBS is closed, its WebSocket server is off, or it uses another port\.$/);
  assert.match(r.json.next, /Tools, WebSocket Server Settings/);
});

describe('against the fake OBS', () => {
  let fake, s, dir;
  before(async () => {
    fake = await startFakeObs({ password: PASSWORD, streamKey: 'live_fakestreamkey_123' });
    dir = obsConfigDir({ server_enabled: true, server_port: fake.port, auth_required: true, server_password: PASSWORD });
    s = await connect(testEnv(dir, fake.port));
  });
  after(async () => {
    await s.close();
    await fake.close();
  });

  test('obs_status reads versions and reports the 4 live requests with no catalogue row', async () => {
    const r = await s.call('obs_status');
    assert.equal(r.json.connected, true);
    assert.equal(r.json.obs.obsVersion, '33.0.1');
    assert.equal(r.json.password_from, 'obs-websocket settings file');
    assert.deepEqual(r.json.live_requests_with_no_catalogue_row, PRIVATE_REQUESTS);
  });

  test('obs_find returns exact names, effect and whether obs_read runs each', async () => {
    const r = await s.call('obs_find', { query: 'stop recording', limit: 3 });
    const stop = r.json.find((e) => e.request === 'StopRecord');
    assert.deepEqual({ effect: stop.effect, in_0_0: stop.in_0_0 }, { effect: 'guarded', in_0_0: 'refused in 0.0; route from 0.1: workflow' });
  });

  test('every read request runs, and no read sends a change or guarded request', async () => {
    fake.log.length = 0;
    const reads = CATALOGUE.filter((e) => e.class === 'read');
    for (const e of reads) {
      const r = await s.call('obs_read', { request: e.request, params: sampleParams(e) });
      assert.equal(r.isError, false, `${e.request}: ${r.text}`);
    }
    const sent = new Set(fake.log);
    assert.deepEqual(reads.map((e) => e.request).filter((n) => !sent.has(n)), []);
    assert.deepEqual(fake.log.filter((n) => CLASS[n] !== 'read'), []);
  });

  test('every change and guarded request is refused and never sent, except the three guarded reads', async () => {
    fake.log.length = 0;
    const others = CATALOGUE.filter((e) => e.class !== 'read' && !['GetInputPropertiesListPropertyItems', 'GetStreamServiceSettings', 'GetProfileParameter'].includes(e.request));
    assert.equal(others.length, 87);
    for (const e of others) {
      const r = await s.call('obs_read', { request: e.request, params: sampleParams(e) });
      assert.equal(r.isError, true, e.request);
      assert.match(r.json.refused, /It was not sent\.$/);
    }
    assert.deepEqual(fake.log.filter((n) => CLASS[n] !== 'read'), []);
  });

  test('the 4 undocumented private-settings requests are refused and never sent', async () => {
    fake.log.length = 0;
    for (const name of PRIVATE_REQUESTS) {
      const r = await s.call('obs_read', { request: name, params: { sourceName: 'x' } });
      assert.equal(r.isError, true);
      assert.match(r.json.refused, new RegExp(`^${name} is not in the catalogue`));
    }
    assert.deepEqual(fake.log, []);
  });

  test('the cleared list row runs, after GetRecordStatus and the input kind are read', async () => {
    fake.log.length = 0;
    const r = await s.call('obs_read', { request: 'GetInputPropertiesListPropertyItems', params: { inputName: 'Display', propertyName: 'type' } });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.data.propertyItems, [{ itemName: 'Display', itemValue: 0, itemEnabled: true }]);
    assert.deepEqual(fake.log, ['GetRecordStatus', 'GetInputSettings', 'GetInputPropertiesListPropertyItems']);
  });

  test('an uncleared list row is refused and not sent, so the fake OBS does not crash', async () => {
    fake.log.length = 0;
    const r = await s.call('obs_read', { request: 'GetInputPropertiesListPropertyItems', params: { inputName: 'App audio', propertyName: 'application' } });
    assert.equal(r.isError, true);
    assert.match(r.json.refused, /no cleared row for \(macos, OBS 33\.0\.1, sck_audio_capture, application\)/);
    assert.deepEqual(fake.log, ['GetRecordStatus', 'GetInputSettings']);
    assert.equal((await s.call('obs_status')).json.connected, true);
  });

  test('F-T12-9: GetStreamServiceSettings hides the server, key, user name and password, and passes the protocol', async () => {
    const r = await s.call('obs_read', { request: 'GetStreamServiceSettings' });
    const h = (length) => ({ hidden: 'text', length });
    assert.deepEqual(r.json.data, {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: h('live.example.com:1935/app/live_fakestreamkey_123'.length), protocol: 'RTMP', key: h(22), use_auth: true, username: h(7), password: h(PASSWORD.length) },
    });
  });

  test('F-T12-1: a list request with both inputName and inputUuid is refused, so an uncleared input never reaches OBS', async () => {
    fake.log.length = 0;
    // inputUuid names the cleared Display, inputName the uncleared App audio. OBS resolves the name first.
    const r = await s.call('obs_read', { request: 'GetInputPropertiesListPropertyItems', params: { inputName: 'App audio', inputUuid: 'uuid-Display', propertyName: 'type' } });
    assert.equal(r.isError, true, r.text);
    assert.match(r.json.refused, /give inputName or inputUuid, not both/);
    assert.equal(fake.log.includes('GetInputPropertiesListPropertyItems'), false);
    const byUuid = await s.call('obs_read', { request: 'GetInputPropertiesListPropertyItems', params: { inputUuid: 'uuid-Display', propertyName: 'type' } });
    assert.equal(byUuid.isError, false, byUuid.text);
  });

  test('F-T12-3: GetProfileParameter runs only on an allowed (category, name) pair; a token pair is refused and not sent', async () => {
    fake.log.length = 0;
    const ok = await s.call('obs_read', { request: 'GetProfileParameter', params: { parameterCategory: 'Video', parameterName: 'BaseCX' } });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.json.data.parameterValue, '1920');
    for (const [parameterCategory, parameterName] of [['Twitch', 'RefreshToken'], ['AdvOut', 'FFURL'], ['YouTube', 'Token']]) {
      const r = await s.call('obs_read', { request: 'GetProfileParameter', params: { parameterCategory, parameterName } });
      assert.equal(r.isError, true, r.text);
      assert.match(r.json.refused, new RegExp(`^GetProfileParameter: \\(${parameterCategory}, ${parameterName}\\) is not on the list of safe profile parameters`));
    }
    assert.deepEqual(fake.log, ['GetProfileParameter']);
  });

  test('F-T12-4: settings strings reach the model only as type and length; numbers, booleans and allow-listed values pass', async () => {
    for (const [request, params, field] of [
      ['GetInputSettings', { inputName: 'Display' }, 'inputSettings'],
      ['GetOutputSettings', { outputName: 'adv_stream' }, 'outputSettings'],
      ['GetSourceFilter', { sourceName: 'Display', filterName: 'Stream' }, 'filterSettings'],
    ]) {
      const r = await s.call('obs_read', { request, params });
      assert.equal(r.isError, false, r.text);
      const { server, headers, show_cursor, volume, unset } = r.json.data[field];
      assert.deepEqual({ server, headers, show_cursor, volume, unset }, {
        server: { hidden: 'text', length: 'rtmp://live.example.com/app/live_fakestreamkey_123'.length },
        headers: [{ hidden: 'text', length: 'Authorization: Bearer live_fakestreamkey_123'.length }, [{ hidden: 'text', length: 6 }, { hidden: 'text', length: 22 }]],
        show_cursor: true, volume: 0.5, unset: null,
      });
      assert.equal(r.text.includes('live_fakestreamkey_123'), false);
    }
    const display = await s.call('obs_read', { request: 'GetInputSettings', params: { inputName: 'Display' } });
    assert.equal(display.json.data.inputSettings.display_uuid, DISPLAY_UUID);
  });

  test('F-T12-5: GetPersistentData hides a text value and passes a number', async () => {
    const realm = 'OBS_WEBSOCKET_DATA_REALM_GLOBAL';
    const text = await s.call('obs_read', { request: 'GetPersistentData', params: { realm, slotName: 'auth' } });
    assert.equal(text.isError, false, text.text);
    assert.deepEqual(text.json.data.slotValue, { hidden: 'text', length: 'sample-refresh-token'.length });
    assert.equal(text.text.includes('sample-refresh-token'), false);
    const num = await s.call('obs_read', { request: 'GetPersistentData', params: { realm, slotName: 'count' } });
    assert.equal(num.json.data.slotValue, 3);
  });

  test('F-T12-7: obs_find and obs_read with Object.prototype names give a normal result', async () => {
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const f = await s.call('obs_find', { query: word });
      assert.equal(f.isError, false, `${word}: ${f.text}`);
      assert.ok(Array.isArray(f.json), `${word}: ${f.text}`);
      const r = await s.call('obs_read', { request: word });
      assert.match(r.json?.refused ?? r.text, new RegExp(`^${word} is not in the catalogue`), `${word}: ${r.text}`);
    }
  });

  test('GetSourceScreenshot saves the image to a server-owned file and sends no image data', async () => {
    const r = await s.call('obs_read', { request: 'GetSourceScreenshot', params: { sourceName: 'Display', imageFormat: 'png' } });
    assert.equal(r.isError, false, r.text);
    assert.ok(existsSync(r.json.data.file));
    assert.ok(dirname(r.json.data.file).startsWith(tmpdir()));
    assert.match(dirname(r.json.data.file), /obs-mcp-screenshots-/);
    assert.equal(readFileSync(r.json.data.file, 'utf8'), 'not really a png');
    assert.doesNotMatch(r.text, /base64|data:image/);
  });

  test('a wrong field is refused with the correct field list', async () => {
    const r = await s.call('obs_read', { request: 'GetInputVolume', params: { name: 'Mic' } });
    assert.equal(r.isError, true);
    assert.match(r.json.refused, /unknown fields: name/);
    assert.deepEqual(r.json.fields, ['inputName?: String', 'inputUuid?: String']);
  });

  test('a wrong name returns the 3 nearest requests', async () => {
    const r = await s.call('obs_read', { request: 'GetScenes' });
    assert.match(r.json.refused, /^GetScenes is not in the catalogue/);
    assert.equal(r.json.nearest.length, 3);
    assert.ok(r.json.nearest.includes('GetSceneList'), r.text);
  });
});

test('during an active recording, the list request is refused even on the cleared row', async () => {
  const fake = await startFakeObs({ recording: true });
  const s = await connect(testEnv(obsConfigDir(null), fake.port));
  const r = await s.call('obs_read', { request: 'GetInputPropertiesListPropertyItems', params: { inputName: 'Display', propertyName: 'type' } });
  await s.close();
  await fake.close();
  assert.match(r.json.refused, /a recording is active/);
  assert.deepEqual(fake.log, ['GetVersion', 'GetRecordStatus']);
});

test('the fake OBS closes with 1006 on an uncleared list row', async () => {
  const fake = await startFakeObs();
  const obs = new OBSWebSocket();
  await obs.connect(`ws://127.0.0.1:${fake.port}`);
  const closed = new Promise((r) => obs.once('ConnectionClosed', (e) => r(e.code)));
  obs.call('GetInputPropertiesListPropertyItems', { inputName: 'App audio', propertyName: 'application' }).catch(() => {});
  assert.equal(await closed, 1006);
  await fake.close();
});

test('a close with 1006 during a read is reported as a possible crash', async () => {
  const fake = await startFakeObs({ crashOn: 'GetStats' });
  const s = await connect(testEnv(obsConfigDir(null), fake.port));
  const r = await s.call('obs_read', { request: 'GetStats' });
  await s.close();
  await fake.close();
  assert.equal(r.json.refused, 'OBS closed the connection with code 1006 (abnormal close). OBS may have crashed.');
});

test('a wrong password gives a plain authentication message', async () => {
  const fake = await startFakeObs({ password: PASSWORD });
  const s = await connect(testEnv(obsConfigDir(null), fake.port, { OBS_WEBSOCKET_PASSWORD: 'wrong-password' }));
  const r = await s.call('obs_status');
  await s.close();
  await fake.close();
  assert.match(r.json.problem, /^OBS refused the password \(authentication failed\)/);
  assert.equal(r.json.password_from, 'environment variable OBS_WEBSOCKET_PASSWORD');
});
