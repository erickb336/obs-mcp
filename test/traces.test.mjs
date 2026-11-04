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
// (settings, a name, a slot), and in a text field that the allow-list keeps ("basis"), where the deny list must find it.
const BS = '\\';
const MISSED = {
  apiKey: { inputSettings: { apiKey: 'AKIAIOSFODNN7EXAMPLE' } },
  accessKey: { responseData: { accessKey: 'sk-live-0123456789abcdefABCDEF0123' } },
  'short key in a profile value': { parameterValue: 'abcd-efgh-ijkl-mnop-qrst' },
  'one-word secret in a slot': { slotValue: 'hunter2secret' },
  'real name in an input name': { inputName: 'Sam Example iPhone Camera' },
  'path under /Volumes': { basis: `Failed to open ${['', 'Vol' + 'umes', 'Sam SSD', 'take.mkv'].join('/')}` },
  'path under /private/var/folders': { basis: `Wrote ${['', 'private', 'var', 'folders', 'ab', 'T', 'obs.log'].join('/')}` },
  'host name with no port': { basis: 'connected to sam-studio.lan' },
  'escaped Windows home in text': { basis: `saved to C:${BS}${BS}Us${'ers'}${BS}${BS}zelda${BS}${BS}Videos ok` },
  'escaped Windows home in a name': { outputPath: `saved to C:${BS}${BS}Us${'ers'}${BS}${BS}zelda${BS}${BS}Videos ok` },
  'lower-case Windows home': { basis: 'in c:/us' + 'ers/zelda/x' },
  'lower-case macOS home': { basis: 'in /us' + 'ers/zelda/x' },
  'password= in text': { basis: 'login with password=Zq9hunterPW now' },
  'password: in text': { basis: 'login with password: Zq9hunterPW now' },
  'token: in text': { note: 'token: Zq9hunterPW' },
  'key: in a kept text': { basis: 'stream key: Zq9hunterPW' },
  'home path in a key': { [`${HOME.replace('alice', 'zelda')}/file.mov`]: 1 },
  'Windows home in a key': { [`C:/Us${'ers'}/zelda/file.mov`]: 1 },
  'URL with a key in a key': { 'rtmp://live.x.com/app/KEYNAMESEC': 1 },
  'stream key in a plain key': { live_123456789_KEYNAMESEC: 1 },
  'long token in a kept text': { basis: 'use 9f8e7d6c5b4a39281706 now' },
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
    kept: { outputTimecode: '00:00:01.234', obsVersion: '33.0.1' },
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
  const reads = { a: { sceneUuid: A }, b: [{ transitionUuid: B }, { sceneUuid: A }], c: { sceneUuid: F(1) }, basis: `scene ${A} ok`, [A]: 1 };
  const record = { sceneUuid: B.toLowerCase(), inputUuid: 'ffffffff-0000-4000-8000-000000000009' };
  const fakeUuid = uuidFaker(JSON.stringify([reads, record]));
  assert.deepEqual(scrub(reads, { ...MACHINE, fakeUuid }), { a: { sceneUuid: F(2) }, b: [{ transitionUuid: F(3) }, { sceneUuid: F(2) }], c: { sceneUuid: F(1) }, basis: `scene ${F(2)} ok`, [F(2)]: 1 });
  assert.deepEqual(scrub(record, { ...MACHINE, fakeUuid }), { sceneUuid: F(3), inputUuid: F(4) });
  assert.deepEqual(findLeaks(reads, MACHINE).map((l) => `${l.path}: ${l.rule}`), [
    'a.sceneUuid: UUID of a real OBS', 'b[0].transitionUuid: UUID of a real OBS', 'b[1].sceneUuid: UUID of a real OBS',
    'basis: UUID of a real OBS', `${F(2)}: key: UUID of a real OBS`,
  ]);
  const clean = scrub(reads, MACHINE);
  assert.deepEqual(findLeaks(clean, MACHINE), []);
  assert.deepEqual(scrub(clean, MACHINE), clean);
});

test('F-T6-17: the scrub finds a real UUID right after a letter, a digit or "_", and right before one', () => {
  const A = 'a1b2c3d4-1111-4222-8333-444455556666';
  const F = '00000000-0000-4000-8000-000000000001';
  const raw = { basis: `x_${A} scene${A} 7${A}z`, [`id_${A}`]: 1 };
  assert.deepEqual(scrub(raw, MACHINE), { basis: `x_${F} scene${F} 7${F}z`, [`id_${F}`]: 1 });
  assert.deepEqual(findLeaks(raw, MACHINE).map((l) => `${l.path}: ${l.rule}`), ['basis: UUID of a real OBS', `id_${F}: key: UUID of a real OBS`]);
  const clean = scrub(raw, MACHINE);
  assert.deepEqual(findLeaks(clean, MACHINE), []);
});

test('the scrub removes the account name and host name of this machine, and a secret of the run, in a text it keeps', () => {
  const out = scrub({ refused: 'Alice ran OBS', basis: 'on studio-mac', platformDescription: 'macOS 15', outputName: 'hunter22' }, { ...MACHINE, secrets: ['hunter22'] });
  assert.deepEqual(out, { refused: '[scrubbed]', basis: '[scrubbed]', platformDescription: 'macOS 15', outputName: '[scrubbed]' });
  // A name of 3 letters or fewer is not matched, so that a user called "obs" does not empty every trace.
  assert.deepEqual(scrub({ basis: 'obs ran' }, { user: 'obs', host: 'pc' }), { basis: 'obs ran' });
});

// F-T27-2: the values of the R160 probe that the scrub kept, and more of the same kinds. Each one must go.
const R160 = {
  'a spaced name as an output name': { outputName: 'Sam Example' },
  'a spaced name as a hotkey name': { hotkeyName: 'Sam Example Phone' },
  'a name with a dot as a hotkey name': { hotkeyName: 'Sam.Example' },
  'a spaced name as an input kind': { inputKind: 'Sam Example' },
  'a one-word name as a transition kind': { transitionKind: 'samexample' },
  'a phone number as an input name': { inputName: '+1-555-867-5309' },
  'a card number as a scene name': { sceneName: '4111-1111-1111-1111' },
  'a PIN as a profile name': { profileName: '1234' },
  'an id form as a scene name': { sceneName: 'adv_file_output' },
  'an enum form as a scene name': { sceneName: 'OBS_SAM' },
  'a number in a field that holds no number': { cpuUsage: '4711' },
  'a PIN as a request type': { requestType: '1234' },
  'a name as a request type': { requestType: 'SamExample' },
  'a name as a platform': { platform: 'Sam Example' },
  'a name in an obs-websocket message': { comment: 'No source was found by the name of Sam Example' },
  'a name with no space in a comment': { comment: 'SamExample' },
  'a name as a key': { responseData: { SamExample: 1 } },
  'a spaced name as a key': { responseData: { 'Sam Example': true } },
};
for (const [name, value] of Object.entries(R160)) {
  test(`F-T27-2: the scan finds, and the scrub removes, ${name}`, () => {
    assert.equal(findLeaks(value, MACHINE).length, 1);
    const out = JSON.stringify(scrub(value, MACHINE));
    assert.match(out, /^\{"\w+":("\[scrubbed\]"|\{"\[scrubbed\]":(1|true)\})\}$/);
    assert.deepEqual(findLeaks(JSON.parse(out), MACHINE), []);
  });
}

test('F-T27-2: the scrub keeps the fixed OBS ids, versions, time codes and messages, each in its own field', () => {
  const kept = {
    outputName: 'adv_file_output', hotkeyName: 'OBSBasic.StopRecording', inputKind: 'sck_audio_capture', transitionKind: 'fade_transition',
    requestType: 'StopRecord', eventType: 'RecordStateChanged', platform: 'macos', imageFormat: 'png', obsVersion: '33.0.1',
    outputTimecode: '00:00:01.234', outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', sourceType: 'OBS_SOURCE_TYPE_INPUT',
    comment: 'You cannot change stream service settings while streaming.', outputFlags: { OBS_OUTPUT_AUDIO: true }, inputAudioTracks: { 1: true },
  };
  assert.deepEqual(scrub(kept, MACHINE), kept);
  // The same values in the wrong field go.
  assert.deepEqual(scrub({ sceneName: '33.0.1', inputName: 'OBSBasic.StopRecording', comment: 'StopRecord' }, MACHINE), { sceneName: '[scrubbed]', inputName: '[scrubbed]', comment: '[scrubbed]' });
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
  assert.deepEqual(await c.call('StopRecord'), { code: 100, d: { outputPath: fake.path() } });
  assert.equal((await c.call('GetRecordStatus')).d.outputActive, true, 'OBS still records until STOPPED');
  assert.deepEqual(await stopped, { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: fake.path() });
  assert.ok(performance.now() - t >= 235, `${Math.round(performance.now() - t)} ms`);
  assert.equal((await c.call('GetRecordStatus')).d.outputActive, false);
  assert.deepEqual(c.events, ['OBS_WEBSOCKET_OUTPUT_STOPPING', 'OBS_WEBSOCKET_OUTPUT_STOPPED']);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
  assert.equal((await c.call('StopRecord')).code, 501);
  await c.obs.disconnect();
  await fake.close();
});

// F-T27-1: the real record trace was captured with no stream live. Its StopRecord must stop and count in every state
// of the other outputs, and leave them as they were.
const OTHER_OUTPUTS = { none: {}, stream: { streaming: true }, 'virtual camera': { virtualCam: true }, 'replay buffer': { replayBuffer: true }, all: { streaming: true, virtualCam: true, replayBuffer: true } };
for (const [name, others] of Object.entries(OTHER_OUTPUTS)) {
  test(`F-T27-1: the real StopRecord stops the take and counts the stop with other outputs live: ${name}`, async () => {
    const fake = await startFakeObs({ recording: true, ...others });
    const c = await client(fake);
    const stopped = new Promise((r) => c.obs.on('RecordStateChanged', (d) => d.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED' && r()));
    assert.deepEqual(await c.call('StartRecord'), { code: 500, message: '' });
    assert.deepEqual(await c.call('StopRecord'), { code: 100, d: { outputPath: fake.path() } });
    await stopped;
    assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
    assert.deepEqual(fake.state, { recording: false, paused: false, streaming: false, virtualCam: false, replayBuffer: false, ...others });
    assert.equal((await c.call('StopRecord')).code, 501);
    await c.obs.disconnect();
    await fake.close();
  });
}

test('F-T27-3: the fake OBS replays the real reads in every output state, also during a take with a live stream', async () => {
  const reads = traces.find((t) => t.file === 'real-reads.json').entries;
  for (const state of [{}, { recording: true }, { recording: true, streaming: true }, { virtualCam: true }]) {
    const fake = await startFakeObs(state);
    const c = await client(fake);
    for (const e of reads) assert.deepEqual((await c.call(e.requestType)).d, e.responseData, `${e.requestType} in ${JSON.stringify(state)}`);
    await c.obs.disconnect();
    await fake.close();
  }
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

test('R210: the fake record output is simple_file_output of kind mov_output; its settings are path and muxer_settings, and path stays after the stop', async () => {
  const fake = await startFakeObs({ recordDirectory: 'rec' });
  const c = await client(fake);
  const file = (await c.call('GetOutputList')).d.outputs.find((o) => o.outputName === 'simple_file_output');
  assert.deepEqual([file.outputKind, file.outputActive, file.outputFlags.OBS_OUTPUT_ENCODED, file.outputFlags.OBS_OUTPUT_SERVICE], ['mov_output', false, true, false]);
  const path = async () => (await c.call('GetOutputSettings', { outputName: 'simple_file_output' })).d.outputSettings;
  const idle = await path();
  assert.deepEqual(Object.keys(idle).sort(), ['muxer_settings', 'path']);
  assert.match(idle.path, /^rec[\\/]2026-01-01 00-00-00 0\.mov$/, 'an old file before the first take');
  await c.call('StartRecord');
  await new Promise((r) => setTimeout(r, 400));
  const now = fake.path();
  assert.equal((await path()).path, now);
  await c.call('StopRecord');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await c.call('GetRecordStatus')).d.outputActive, false);
  assert.equal((await path()).path, now, 'the last file stays after the stop');
  await c.obs.disconnect();
  await fake.close();
});

test('R210: the ffmpeg_muxer variant of the fake is adv_file_output', async () => {
  const fake = await startFakeObs({ fileOutput: 'ffmpeg_muxer', recording: true, recordDirectory: 'rec' });
  const c = await client(fake);
  const file = (await c.call('GetOutputList')).d.outputs.find((o) => o.outputKind === 'ffmpeg_muxer');
  assert.deepEqual([file.outputName, file.outputActive], ['adv_file_output', true]);
  assert.equal((await c.call('GetOutputSettings', { outputName: 'adv_file_output' })).d.outputSettings.path, fake.path());
  await c.obs.disconnect();
  await fake.close();
});

test('R210: the PAUSED event has outputActive false, and the record status stays active and paused', async () => {
  const fake = await startFakeObs({ recording: true });
  const c = await client(fake);
  const seen = [];
  c.obs.on('RecordStateChanged', (d) => seen.push(d));
  await c.call('PauseRecord');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen.map((d) => [d.outputState, d.outputActive]), [['OBS_WEBSOCKET_OUTPUT_PAUSED', false]]);
  const st = (await c.call('GetRecordStatus')).d;
  assert.deepEqual([st.outputActive, st.outputPaused], [true, true]);
  await c.obs.disconnect();
  await fake.close();
});

// Unit 1 of T7: the record model of the fake OBS. SIMULATED.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = (c) => {
  const t = performance.now();
  const seen = [];
  c.obs.on('RecordStateChanged', (d) => seen.push({ state: d.outputState.replace('OBS_WEBSOCKET_OUTPUT_', ''), ms: performance.now() - t, path: d.outputPath }));
  return seen;
};

test('T7 unit 1: the fake OBS replays real-record.json exactly: codes, event order, delays and the path of the take', async () => {
  const real = traces.find((t) => t.file === 'real-record.json').entries;
  const fake = await startFakeObs({ recordDirectory: 'rec' });
  const c = await client(fake);
  const start = timed(c);
  assert.deepEqual(await c.call('StartRecord'), { code: 100, d: {} });
  await wait(400);
  const path = fake.path();
  assert.deepEqual(start.map((e) => [e.state, e.path]), [['STARTING', null], ['STARTED', path]]);
  // Each event comes at its delay in the trace (51 and 272 ms), and before the next one.
  real[0].events.forEach((ev, i) => assert.ok(start[i].ms >= ev.delayMs - 2 && start[i].ms < ev.delayMs + 100, `${start[i].state} at ${Math.round(start[i].ms)} ms`));
  assert.equal((await c.call('StartRecord')).code, 500);
  c.obs.removeAllListeners('RecordStateChanged');
  const stop = timed(c);
  assert.deepEqual(await c.call('StopRecord'), { code: 100, d: { outputPath: path } });
  await wait(350);
  assert.deepEqual(stop.map((e) => [e.state, e.path]), [['STOPPING', null], ['STOPPED', path]]);
  real[2].events.forEach((ev, i) => assert.ok(stop[i].ms >= ev.delayMs - 2 && stop[i].ms < ev.delayMs + 100, `${stop[i].state} at ${Math.round(stop[i].ms)} ms`));
  assert.equal((await c.call('StopRecord')).code, 501);
  assert.deepEqual(fake.log, ['StartRecord', 'StartRecord', 'StopRecord', 'StopRecord']);
  await c.obs.disconnect();
  await fake.close();
});

test('T7 unit 1, F-T7-1: PauseRecord and ResumeRecord give 501 when nothing records, 502 when already paused and 503 when not paused', async () => {
  const fake = await startFakeObs();
  const c = await client(fake);
  const codes = { idle: [(await c.call('PauseRecord')).code, (await c.call('ResumeRecord')).code] };
  fake.startInObs();
  await wait(300);
  codes.recording = [(await c.call('ResumeRecord')).code, (await c.call('PauseRecord')).code];
  await wait(20);
  codes.paused = [(await c.call('PauseRecord')).code, (await c.call('ResumeRecord')).code];
  await wait(20);
  codes.resumed = [(await c.call('ResumeRecord')).code];
  assert.deepEqual(codes, { idle: [501, 501], recording: [503, 100], paused: [502, 100], resumed: [503] });
  assert.deepEqual(c.events, ['OBS_WEBSOCKET_OUTPUT_STARTING', 'OBS_WEBSOCKET_OUTPUT_STARTED', 'OBS_WEBSOCKET_OUTPUT_PAUSED', 'OBS_WEBSOCKET_OUTPUT_RESUMED']);
  await c.obs.disconnect();
  await fake.close();
});

test('T7 unit 1: the record status runs on the clock, stops during a pause, and counts bytes across takes until OBS restarts', async () => {
  const fake = await startFakeObs({ recording: true, elapsedMs: 5000, lagMs: 1000 });
  const c = await client(fake);
  const status = async () => (await c.call('GetRecordStatus')).d;
  const a = await status();
  assert.ok(a.outputActive && a.outputDuration >= 4000 && a.outputDuration < 4200, JSON.stringify(a));
  assert.equal(a.outputTimecode, new Date(a.outputDuration).toISOString().slice(11, 23));
  assert.equal(a.outputBytes, a.outputDuration * 1000);
  assert.equal(fake.pauseInObs(), true);
  await wait(40); // PAUSED and its effect land at 21 ms (R210)
  const p1 = await status();
  await wait(150);
  const p2 = await status();
  assert.deepEqual([p1.outputPaused, p2.outputPaused, p2.outputDuration - p1.outputDuration, p2.outputBytes - p1.outputBytes], [true, true, 0, 0]);
  assert.equal(fake.pauseInObs(), false, 'OBS refuses a second pause');
  fake.resumeInObs();
  await wait(100);
  const r = await status();
  assert.ok(r.outputDuration - p2.outputDuration >= 60 && !r.outputPaused, JSON.stringify(r));
  assert.equal(fake.stopInObs(), true);
  await wait(300);
  const idle = await status();
  assert.deepEqual([idle.outputActive, idle.outputPaused, idle.outputDuration], [false, false, 0]);
  assert.ok(idle.outputBytes >= r.outputBytes, 'the byte count stays after the stop');
  fake.startInObs();
  await wait(300);
  const next = await status();
  // The lag of 1 s holds the new take at 0 ms, so its count is where the last take ended, not 0.
  assert.ok(next.outputActive && idle.outputBytes > 0 && next.outputBytes === idle.outputBytes, 'a new take counts on from the last one');
  assert.match(fake.path(), / 2\.mov$/, 'a new take gets a new file');
  fake.restartObs();
  const d = await client(fake);
  assert.deepEqual((await d.call('GetRecordStatus')).d, { outputActive: false, outputPaused: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputBytes: 0 });
  assert.deepEqual(fake.stops.map((s) => s.cause), ['button']);
  await d.obs.disconnect();
  await fake.close();
});

test('T7 unit 1: closeAfter runs the request and closes before the reply; dropEvents keeps an event back', async () => {
  const fake = await startFakeObs({ closeAfter: ['StartRecord'], dropEvents: ['OBS_WEBSOCKET_OUTPUT_STARTED'] });
  const c = await client(fake);
  const closed = new Promise((r) => c.obs.once('ConnectionClosed', r));
  c.obs.call('StartRecord').catch(() => {});
  assert.equal((await closed).code, 1006);
  await wait(400);
  const d = await client(fake);
  assert.equal((await d.call('GetRecordStatus')).d.outputActive, true, 'OBS started the take');
  fake.stopInObs();
  await wait(300);
  fake.startInObs();
  await wait(400);
  assert.deepEqual(d.events, ['OBS_WEBSOCKET_OUTPUT_STOPPING', 'OBS_WEBSOCKET_OUTPUT_STOPPED', 'OBS_WEBSOCKET_OUTPUT_STARTING']);
  assert.deepEqual(fake.log, ['StartRecord', 'GetRecordStatus']);
  await d.obs.disconnect();
  await fake.close();
});
