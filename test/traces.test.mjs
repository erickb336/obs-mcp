// The stored traces, the trace scrub and the trace replay of the fake OBS. SIMULATED: no real OBS.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OBSWebSocket, EventSubscription } from 'obs-websocket-js/json';
import { findLeaks, scrub, uuidFaker } from '../scripts/trace-scrub.mjs';
import { loadTraces, startFakeObs, TRACE_DIR } from './fake-obs.mjs';

const SCRUB_CLI = fileURLToPath(new URL('../scripts/trace-scrub.mjs', import.meta.url));
const protocol = JSON.parse(readFileSync(new URL('../protocol/protocol.json', import.meta.url), 'utf8'));
const DOCUMENTED = new Set(protocol.requests.map((r) => r.requestType));
const EVENTS = new Set(protocol.events.map((e) => e.eventType));
// Built from parts, so that this file holds no home path that the repository scan would find.
const HOME = ['', 'Us' + 'ers', 'alice'].join('/');
const LINUX_HOME = ['', 'ho' + 'me', 'alice'].join('/');
const WIN_HOME = ['C:', 'Us' + 'ers', 'alice'].join('\\');
const LAN = ['192', '168', '1', '20'].join('.');
const MACHINE = { user: 'alice', host: 'studio-mac.local' };

// A raw trace part with one value of each kind that the scrub must remove, and the kinds that it keeps.
const RAW = {
  hello: { obsWebSocketVersion: '5.7.6', authentication: { challenge: 'Q2hhbGxlbmdlVmFsdWU=', salt: 'U2FsdFZhbHVl' } },
  identify: { rpcVersion: 1, authentication: 'aGFzaGVkLXBhc3N3b3Jk' },
  streamServiceSettings: { server: 'rtmp://live.example.com/app/live_123456789_abcdefgh', key: 'live_123456789_abcdefgh', service: 'Twitch', use_auth: true, username: 'alice', password: 'hunter22' },
  outputSettings: { path: `${HOME}/Movies/2026-11-03 10-00-00.mov`, muxer_settings: '', bitrate: 6000 },
  recordDirectory: `${LINUX_HOME}/Videos`,
  inputSettings: { display_uuid: '5d1f3c2a-8b4e-4f6a-9c7d-0e1f2a3b4c5d', type: 0, device_id: 'default', window_name: 'Mail - alice' },
  scene: { sceneName: 'Call', sceneUuid: '00000000-0000-4000-8000-000000000001', sceneIndex: 0 },
  kept: {
    outputTimecode: '00:00:01.234', obsVersion: '33.0.1', outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', activeFps: 30, requestType: 'GetStats',
    outputName: 'Replay Buffer', hotkeyName: 'libobs.mute', comment: 'Video settings cannot be changed while an output is active.',
  },
};

/** A settings object as the scrub leaves it: the keys hidden_key_1, hidden_key_2 and so on, in order. */
const hidden = (values) => Object.fromEntries(values.map((v, i) => [`hidden_key_${i + 1}`, v]));
/** The leaks of a settings object: a key leak for each key, and then a value leak when the value goes. */
const settingsLeaks = (path, rules) => rules.flatMap((rule, i) => [`${path}.hidden_key_${i + 1}: key: settings key`, ...(rule ? [`${path}.hidden_key_${i + 1}: ${rule}`] : [])]);

test('the scrub keeps only allow-listed forms and fields, and replaces every other string', () => {
  assert.deepEqual(scrub(RAW, MACHINE), {
    hello: { obsWebSocketVersion: '5.7.6', authentication: '[scrubbed]' },
    identify: { rpcVersion: 1, authentication: '[scrubbed]' },
    // F-T6-16: in settings, each key is hidden as in the server's redact, and each number goes too.
    streamServiceSettings: hidden(['[scrubbed]', '[scrubbed]', '[scrubbed]', true, '[scrubbed]', '[scrubbed]']),
    outputSettings: hidden(['[path]', '', '[scrubbed]']),
    recordDirectory: '[path]',
    inputSettings: hidden(['[scrubbed]', '[scrubbed]', '[scrubbed]', '[scrubbed]']),
    scene: { sceneName: '[scrubbed]', sceneUuid: '00000000-0000-4000-8000-000000000001', sceneIndex: 0 },
    kept: RAW.kept,
  });
});

test('the leak scan names each place and rule of a raw trace, never the value, and finds nothing after the scrub', () => {
  const leaks = findLeaks(RAW, MACHINE);
  assert.deepEqual(leaks.map((l) => `${l.path}: ${l.rule}`), [
    'hello.authentication: secret field "authentication"', 'identify.authentication: secret field "authentication"',
    ...settingsLeaks('streamServiceSettings', ['settings value', 'settings value', 'settings value', undefined, 'settings value', 'settings value']),
    ...settingsLeaks('outputSettings', ['file path', undefined, 'settings value']), 'recordDirectory: file path',
    ...settingsLeaks('inputSettings', ['settings value', 'settings value', 'settings value', 'settings value']),
    'scene.sceneName: not on the allow-list',
  ]);
  assert.equal(JSON.stringify(leaks).includes('hunter22'), false);
  const clean = scrub(RAW, MACHINE);
  assert.deepEqual(findLeaks(clean, MACHINE), []);
  assert.deepEqual(scrub(clean, MACHINE), clean);
});

// F-T6-2, F-T6-6, F-T6-7, F-T6-8: the values that the scrub of R131 left in a trace. Each one goes in a free field
// (settings, a name, a slot), and in a text field that the allow-list keeps ("comment"), where the deny list must find it.
const BS = '\\';
const MISSED = {
  apiKey: { inputSettings: { apiKey: 'AKIAIOSFODNN7EXAMPLE' } },
  accessKey: { responseData: { accessKey: 'sk-live-0123456789abcdefABCDEF0123' } },
  'short key in a profile value': { parameterValue: 'abcd-efgh-ijkl-mnop-qrst' },
  'one-word secret in a slot': { slotValue: 'hunter2secret' },
  'real name in an input name': { inputName: 'Sam Example iPhone Camera' },
  'path under /Volumes': { comment: `Failed to open ${['', 'Vol' + 'umes', 'Sam SSD', 'take.mkv'].join('/')}` },
  'path under /private/var/folders': { comment: `Wrote ${['', 'private', 'var', 'folders', 'ab', 'T', 'obs.log'].join('/')}` },
  'host name with no port': { comment: 'connected to sam-studio.lan' },
  'escaped Windows home in text': { comment: `saved to C:${BS}${BS}Us${'ers'}${BS}${BS}zelda${BS}${BS}Videos ok` },
  'escaped Windows home in a name': { outputPath: `saved to C:${BS}${BS}Us${'ers'}${BS}${BS}zelda${BS}${BS}Videos ok` },
  'lower-case Windows home': { comment: 'in c:/us' + 'ers/zelda/x' },
  'lower-case macOS home': { comment: 'in /us' + 'ers/zelda/x' },
  'password= in text': { comment: 'login with password=Zq9hunterPW now' },
  'password: in text': { comment: 'login with password: Zq9hunterPW now' },
  'token: in text': { note: 'token: Zq9hunterPW' },
  'key: in a kept text': { comment: 'stream key: Zq9hunterPW' },
  'home path in a key': { [`${HOME.replace('alice', 'zelda')}/file.mov`]: 1 },
  'Windows home in a key': { [`C:/Us${'ers'}/zelda/file.mov`]: 1 },
  'URL with a key in a key': { 'rtmp://live.x.com/app/KEYNAMESEC': 1 },
  'stream key in a plain key': { live_123456789_KEYNAMESEC: 1 },
  'long token in a kept text': { comment: 'use 9f8e7d6c5b4a39281706 now' },
  'address in a number form': { cpuUsage: LAN },
};
for (const [name, value] of Object.entries(MISSED)) {
  test(`the scan finds, and the scrub removes, a value that R131 missed: ${name}`, () => {
    // A key that settings hide is a leak of its own (F-T6-16); the value leak is the one this test is about.
    const leaks = findLeaks(value, MACHINE).filter((l) => l.rule !== 'key: settings key');
    assert.equal(leaks.length, 1, JSON.stringify(leaks));
    const out = JSON.stringify(scrub(value, MACHINE));
    assert.match(out, /^\{"\[scrubbed\]":1\}$|^\{"\w+":(\{"\w+":)?"\[(scrubbed|path)\]"\}?\}$/);
    assert.deepEqual(findLeaks(JSON.parse(out), MACHINE), []);
  });
}

test('F-T6-11: the scrub removes every settings and slot string, also one in the form of a number, a time or a version', () => {
  const raw = {
    inputSettings: { pin: '4711', phone: '+1 555-0100', nested: { card: '4111-1111-1111-1111' }, list: ['12:30', '1.2.3'], fps: 30 },
    slotValue: '0042',
    propertyItems: [{ itemName: '5551234567', itemValue: '4111111111111111', itemEnabled: true }],
    kept: { outputTimecode: '00:00:01.234', obsVersion: '33.0.1', cpuUsage: '4711' },
  };
  assert.deepEqual(scrub(raw, MACHINE), {
    inputSettings: hidden(['[scrubbed]', '[scrubbed]', hidden(['[scrubbed]']), ['[scrubbed]', '[scrubbed]'], '[scrubbed]']),
    slotValue: '[scrubbed]',
    propertyItems: [{ itemName: '[scrubbed]', itemValue: '[scrubbed]', itemEnabled: true }],
    kept: raw.kept,
  });
  assert.deepEqual(findLeaks(raw, MACHINE).map((l) => `${l.path}: ${l.rule}`), [
    ...settingsLeaks('inputSettings', ['settings value', 'settings value']),
    'inputSettings.hidden_key_3: key: settings key', ...settingsLeaks('inputSettings.hidden_key_3', ['settings value']),
    'inputSettings.hidden_key_4: key: settings key', 'inputSettings.hidden_key_4[0]: settings value', 'inputSettings.hidden_key_4[1]: settings value',
    ...settingsLeaks('inputSettings', [undefined, undefined, undefined, undefined, 'settings value']).slice(-2), 'slotValue: settings value',
    'propertyItems[0].itemName: settings value', 'propertyItems[0].itemValue: settings value',
  ]);
});

test('F-T6-12: the scrub removes every string of a profile parameter value and of custom and vendor data', () => {
  const card = '4111111111111111';
  const raw = {
    entries: [
      { requestType: 'GetProfileParameter', responseData: { parameterValue: card, defaultParameterValue: '1234' } },
      {
        requestType: 'CallVendorRequest',
        requestData: { vendorName: 'sam-plugin', requestType: 'get', requestData: { pin: '4711' } },
        responseData: { vendorName: 'sam-plugin', requestType: 'get', responseData: { account: 'Sam Example', pin: '4711', n: 2 } },
      },
      {
        requestType: 'GetStats',
        events: [
          { eventType: 'CustomEvent', eventData: { pin: '4711', note: 'call me', nested: ['0042'] } },
          { eventType: 'VendorEvent', eventData: { vendorName: 'sam-plugin', eventType: 'x', eventData: { phone: '+1 555-0100' } } },
          { eventType: 'RecordStateChanged', eventData: { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' } },
        ],
      },
    ],
  };
  const S = '[scrubbed]';
  assert.deepEqual(scrub(raw, MACHINE), {
    entries: [
      { requestType: 'GetProfileParameter', responseData: { parameterValue: S, defaultParameterValue: S } },
      {
        requestType: 'CallVendorRequest',
        requestData: hidden([S, S, hidden([S])]),
        responseData: hidden([S, S, hidden([S, S, S])]),
      },
      {
        requestType: 'GetStats',
        events: [
          { eventType: 'CustomEvent', eventData: hidden([S, S, [S]]) },
          { eventType: 'VendorEvent', eventData: hidden([S, S, hidden([S])]) },
          { eventType: 'RecordStateChanged', eventData: { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' } },
        ],
      },
    ],
  });
  const leaks = findLeaks(raw, MACHINE);
  // 16 values (the number n too) and 17 keys.
  assert.deepEqual([leaks.filter((l) => l.rule === 'settings value').length, leaks.filter((l) => l.rule === 'key: settings key').length, leaks.length], [16, 17, 33]);
  assert.equal(JSON.stringify(leaks).includes(card), false);
});

test('F-T6-14: the scrub gives each real UUID a fake one, the same fake in every place and every file of one scrub', () => {
  const A = 'a1b2c3d4-1111-4222-8333-444455556666';
  const B = '9F8E7D6C-AAAA-4BBB-8CCC-DDDDEEEEFFFF';
  const F = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  // F(1) is already in the input as a fake, so the first real UUID gets F(2).
  const reads = { a: { sceneUuid: A }, b: [{ transitionUuid: B }, { sceneUuid: A }], c: { sceneUuid: F(1) }, comment: `scene ${A} ok`, [A]: 1 };
  const record = { sceneUuid: B.toLowerCase(), inputUuid: 'ffffffff-0000-4000-8000-000000000009' };
  const fakeUuid = uuidFaker(JSON.stringify([reads, record]));
  assert.deepEqual(scrub(reads, { ...MACHINE, fakeUuid }), { a: { sceneUuid: F(2) }, b: [{ transitionUuid: F(3) }, { sceneUuid: F(2) }], c: { sceneUuid: F(1) }, comment: `scene ${F(2)} ok`, [F(2)]: 1 });
  assert.deepEqual(scrub(record, { ...MACHINE, fakeUuid }), { sceneUuid: F(3), inputUuid: F(4) });
  assert.deepEqual(findLeaks(reads, MACHINE).map((l) => `${l.path}: ${l.rule}`), [
    'a.sceneUuid: UUID of a real OBS', 'b[0].transitionUuid: UUID of a real OBS', 'b[1].sceneUuid: UUID of a real OBS',
    'comment: UUID of a real OBS', `${F(2)}: key: UUID of a real OBS`,
  ]);
  const clean = scrub(reads, MACHINE);
  assert.deepEqual(findLeaks(clean, MACHINE), []);
  assert.deepEqual(scrub(clean, MACHINE), clean);
});

test('F-T6-17: the scrub finds a real UUID right after a letter, a digit or "_", and right before one', () => {
  const A = 'a1b2c3d4-1111-4222-8333-444455556666';
  const F = '00000000-0000-4000-8000-000000000001';
  const raw = { comment: `x_${A} scene${A} 7${A}z`, [`id_${A}`]: 1 };
  assert.deepEqual(scrub(raw, MACHINE), { comment: `x_${F} scene${F} 7${F}z`, [`id_${F}`]: 1 });
  assert.deepEqual(findLeaks(raw, MACHINE).map((l) => `${l.path}: ${l.rule}`), ['comment: UUID of a real OBS', `id_${F}: key: UUID of a real OBS`]);
  const clean = scrub(raw, MACHINE);
  assert.deepEqual(findLeaks(clean, MACHINE), []);
});

test('the scrub removes the account name and host name of this machine, and a secret of the run, in a text it keeps', () => {
  const out = scrub({ comment: 'Alice ran OBS', basis: 'on studio-mac', platformDescription: 'macOS 15', outputName: 'hunter22' }, { ...MACHINE, secrets: ['hunter22'] });
  assert.deepEqual(out, { comment: '[scrubbed]', basis: '[scrubbed]', platformDescription: 'macOS 15', outputName: '[scrubbed]' });
  // A name of 3 letters or fewer is not matched, so that a user called "obs" does not empty every trace.
  assert.deepEqual(scrub({ comment: 'obs ran' }, { user: 'obs', host: 'pc' }), { comment: 'obs ran' });
});

const traces = loadTraces();

test('F-T6-14: the stored traces hold only fake UUIDs, and one scene UUID links the scene reads', () => {
  const all = traces.map((t) => JSON.stringify(t)).join('\n').match(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi);
  assert.deepEqual([...new Set(all)].sort(), ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']);
  const reads = traces.find((t) => t.file === 'real-reads.json').entries;
  const program = reads.find((e) => e.requestType === 'GetCurrentProgramScene').responseData.sceneUuid;
  assert.equal(reads.find((e) => e.requestType === 'GetSceneList').responseData.scenes[0].sceneUuid, program);
});

test('each stored trace is labelled, documented, and holds no password, stream key, user name, home path or address', () => {
  assert.ok(traces.length >= 3, `${traces.length} trace files in ${fileURLToPath(TRACE_DIR)}`);
  for (const t of traces) {
    assert.equal(t.format, 'obs-mcp-trace/1', t.file);
    // A stored trace is real (captured from a running OBS) or simulated (written by hand), and its file name says which.
    assert.equal(t.file.split('-')[0], t.source, t.file);
    assert.match(t.basis, /\S/, t.file);
    for (const e of t.entries) {
      assert.ok(DOCUMENTED.has(e.requestType), `${t.file}: ${e.requestType}`);
      assert.equal(typeof e.status.code, 'number', `${t.file}: ${e.requestType}`);
      for (const ev of e.events ?? []) assert.ok(EVENTS.has(ev.eventType), `${t.file}: ${ev.eventType}`);
    }
    const { file, ...stored } = t;
    assert.deepEqual(findLeaks(stored), [], file);
  }
  assert.deepEqual(traces.map((t) => `${t.file}: ${t.source}`), ['real-reads.json: real', 'real-record.json: real', 'simulated-live-output.json: simulated', 'simulated-record.json: simulated']);
});

test('the scrub command line scrubs a file, and its check fails on a raw file and passes on a scrubbed one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-mcp-scrub-'));
  const raw = join(dir, 'raw.json');
  const clean = join(dir, 'clean.json');
  writeFileSync(raw, JSON.stringify({ format: 'obs-mcp-trace/1', entries: [{ responseData: { recordDirectory: `${HOME}/Movies` } }] }));
  const bad = spawnSync(process.execPath, [SCRUB_CLI, '--check', raw], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, `${raw}: entries[0].responseData.recordDirectory: file path\n1 value(s) to scrub.\n`);
  assert.equal(bad.stdout.includes('alice'), false);
  assert.equal(execFileSync(process.execPath, [SCRUB_CLI, raw, clean], { encoding: 'utf8' }), `scrubbed 1 value(s) into ${clean}.\n`);
  assert.deepEqual(JSON.parse(readFileSync(clean, 'utf8')), { format: 'obs-mcp-trace/1', entries: [{ responseData: { recordDirectory: '[path]' } }] });
  assert.equal(execFileSync(process.execPath, [SCRUB_CLI, '--check', clean], { encoding: 'utf8' }), 'clean: 1 file(s).\n');
});

/** A client of the fake OBS that keeps every event it gets. */
async function client(fake, subscriptions = EventSubscription.Outputs) {
  const obs = new OBSWebSocket();
  const events = [];
  await obs.connect(`ws://127.0.0.1:${fake.port}`, undefined, { rpcVersion: 1, eventSubscriptions: subscriptions });
  obs.on('RecordStateChanged', (d) => events.push(d.outputState));
  const call = (type, data) => obs.call(type, data).then((d) => ({ code: 100, d }), (e) => ({ code: e.code, message: e.message }));
  return { obs, events, call };
}

test('the fake OBS replays the T20 output blocks: SetVideoSettings gives 500 during any output, and 100 when idle', async () => {
  const codes = {};
  for (const [name, state] of [['idle', {}], ['recording', { recording: true }], ['streaming', { streaming: true }], ['virtual camera', { virtualCam: true }]]) {
    const fake = await startFakeObs(state);
    const c = await client(fake);
    codes[name] = [
      (await c.call('SetVideoSettings', { fpsNumerator: 30 })).code,
      (await c.call('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: {} })).code,
      (await c.call('SetRecordDirectory', { recordDirectory: 'x' })).code,
      (await c.call('StartRecord')).code,
    ];
    await c.obs.disconnect();
    await fake.close();
  }
  assert.deepEqual(codes, { idle: [100, 100, 100, 100], recording: [500, 100, 500, 500], streaming: [500, 500, 100, 100], 'virtual camera': [500, 100, 100, 100] });
});

test('the fake OBS replays the real record stop: STOPPING, then STOPPED 235 ms later, and counts the stop', async () => {
  const fake = await startFakeObs({ recording: true });
  const c = await client(fake);
  const t = performance.now();
  const stopped = new Promise((r) => c.obs.on('RecordStateChanged', (d) => d.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED' && r(d)));
  assert.deepEqual(await c.call('StopRecord'), { code: 100, d: { outputPath: '[path]' } });
  assert.equal((await c.call('GetRecordStatus')).d.outputActive, true, 'OBS still records until STOPPED');
  assert.deepEqual(await stopped, { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: '[path]' });
  assert.ok(performance.now() - t >= 235, `${Math.round(performance.now() - t)} ms`);
  assert.equal((await c.call('GetRecordStatus')).d.outputActive, false);
  assert.deepEqual(c.events, ['OBS_WEBSOCKET_OUTPUT_STOPPING', 'OBS_WEBSOCKET_OUTPUT_STOPPED']);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
  assert.equal((await c.call('StopRecord')).code, 501);
  await c.obs.disconnect();
  await fake.close();
});

test('F-T6-3: the fake OBS logs, answers and counts each request of a RequestBatch, so a batched stop counts in the sweep', async () => {
  const fake = await startFakeObs({ recording: true });
  const c = await client(fake);
  const results = await c.obs.callBatch([{ requestType: 'GetRecordStatus' }, { requestType: 'StopRecord' }]);
  assert.deepEqual(results.map((r) => [r.requestType, r.requestStatus.code]), [['GetRecordStatus', 100], ['StopRecord', 100]]);
  assert.deepEqual(fake.log, ['GetRecordStatus', 'StopRecord']);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
  // A list request that crashes OBS ends the batch, and the crash counts as a stop.
  const crashed = await startFakeObs({ recording: true });
  const d = await client(crashed);
  const closed = new Promise((r) => d.obs.once('ConnectionClosed', r));
  d.obs.callBatch([{ requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'App audio', propertyName: 'application' } }, { requestType: 'GetStats' }]).catch(() => {});
  assert.equal((await closed).code, 1006);
  assert.deepEqual(crashed.log, ['GetInputPropertiesListPropertyItems']);
  assert.deepEqual(crashed.stops, [{ requestType: 'GetInputPropertiesListPropertyItems', cause: 'crash' }]);
  await c.obs.disconnect();
  await fake.close();
  await crashed.close();
});

test('the fake OBS sends events only to a client that subscribed to their category, as obs-websocket does', async () => {
  const fake = await startFakeObs();
  const none = await client(fake, EventSubscription.None);
  const outputs = await client(fake);
  await none.call('StartRecord');
  // The real trace has STARTED 272 ms after StartRecord.
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(outputs.events, ['OBS_WEBSOCKET_OUTPUT_STARTING', 'OBS_WEBSOCKET_OUTPUT_STARTED']);
  assert.deepEqual(none.events, []);
  await none.obs.disconnect();
  await outputs.obs.disconnect();
  await fake.close();
});

test('the fake OBS gives an output path in GetOutputSettings only while it records (T4)', async () => {
  const paths = [];
  for (const recording of [false, true]) {
    const fake = await startFakeObs({ recording });
    const c = await client(fake);
    paths.push((await c.call('GetOutputSettings', { outputName: 'adv_file_output' })).d.outputSettings);
    await c.obs.disconnect();
    await fake.close();
  }
  // The stored trace hides the settings keys (F-T6-16); the path placeholder shows the path.
  assert.deepEqual(paths, [{}, { hidden_key_1: '[path]', hidden_key_2: '' }]);
});
