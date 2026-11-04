// The capture script, against the fake OBS only. SIMULATED: no real OBS.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OBSWebSocket } from 'obs-websocket-js/json';
import { findLeaks } from '../scripts/trace-scrub.mjs';
import { startFakeObs } from './fake-obs.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/capture-traces.mjs', import.meta.url));
const PASSWORD = 'capture-test-password-W3q8';

function run(args, env = {}) {
  return new Promise((resolve) => {
    const base = { ...process.env, ...env };
    if (!('OBS_WEBSOCKET_PASSWORD' in env)) delete base.OBS_WEBSOCKET_PASSWORD;
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: base, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stderr }));
  });
}
const files = () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-mcp-capture-'));
  return { plan: join(dir, 'plan.json'), out: join(dir, 'trace.json') };
};

const PLAN = [
  { requestType: 'GetStats' },
  { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'App audio', propertyName: 'application' } },
  { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'App audio', propertyName: 'Application' } },
  { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'Display', propertyName: 'display_uuid' } },
  { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'Display', propertyName: 'type' } },
  { requestType: 'StartStream' },
  { requestType: 'ToggleOutput', requestData: { outputName: 'adv_file_output' } },
  // F-T6-1: requests that R41 refuses for a crash (obs-studio #14105) or for plugin code.
  { requestType: 'OpenInputPropertiesDialog', requestData: { inputName: 'Display' } },
  { requestType: 'PressInputPropertiesButton', requestData: { inputName: 'Display', propertyName: 'reactivate_capture' } },
  { requestType: 'CallVendorRequest', requestData: { vendorName: 'x', requestType: 'stop' } },
  { requestType: 'SetOutputSettings', requestData: { outputName: 'adv_file_output', outputSettings: {} } },
  { requestType: 'GetProfileParameter', requestData: { parameterCategory: 'Twitch', parameterName: 'RefreshToken' } },
  { requestType: 'StartRecord' },
  { requestType: 'StopRecord' },
  { requestType: 'GetStreamServiceSettings' },
];
const GUARD_READS = ['GetRecordStatus', 'GetStreamStatus', 'GetOutputList', 'GetInputList'];
const NO_ROW = (kind, property) => `no cleared row for (macos, OBS 33.0.1, ${kind}, ${property}). A list request can crash OBS, so only rows tested on real OBS run.`;
const NOT_A_READ = (cls) => `it is in the class ${cls}. The capture sends what obs_read runs, and a record start or stop with --allow-record.`;

test('the capture sends only what obs_read runs, with its guards, and writes a scrubbed trace', async () => {
  const fake = await startFakeObs({ password: PASSWORD, streamKey: 'live_123456789_captureKey' });
  const f = files();
  writeFileSync(f.plan, JSON.stringify(PLAN));
  const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0'], { OBS_WEBSOCKET_PASSWORD: PASSWORD });
  await fake.close();
  assert.equal(r.code, 0, r.stderr);
  // Before each list request, the server's guard reads the outputs and the inputs (F-T6-9).
  assert.deepEqual(fake.log, ['GetVersion', 'GetStreamStatus', 'GetRecordStatus', 'GetStats', ...GUARD_READS, ...GUARD_READS, ...GUARD_READS, ...GUARD_READS, 'GetInputPropertiesListPropertyItems', 'GetStreamServiceSettings']);
  assert.deepEqual(fake.sent.find((s) => s.requestType === 'GetInputPropertiesListPropertyItems').requestData, { inputUuid: 'uuid-Display', propertyName: 'type' });
  assert.equal(fake.crashes(), 0);
  const text = readFileSync(f.out, 'utf8');
  const trace = JSON.parse(text);
  assert.equal(trace.source, 'captured');
  assert.deepEqual(trace.refused.map((x) => `${x.requestType}: ${x.refused}`), [
    `GetInputPropertiesListPropertyItems: ${NO_ROW('sck_audio_capture', 'application')}`,
    `GetInputPropertiesListPropertyItems: ${NO_ROW('sck_audio_capture', 'Application')}`,
    `GetInputPropertiesListPropertyItems: ${NO_ROW('screen_capture', 'display_uuid')}`,
    `StartStream: ${NOT_A_READ('guarded')}`,
    `ToggleOutput: ${NOT_A_READ('guarded')}`,
    `OpenInputPropertiesDialog: ${NOT_A_READ('change')}`,
    `PressInputPropertiesButton: ${NOT_A_READ('change')}`,
    `CallVendorRequest: ${NOT_A_READ('guarded')}`,
    `SetOutputSettings: ${NOT_A_READ('change')}`,
    'GetProfileParameter: it is not on the list of safe profile parameters, because a profile can hold tokens and stream keys.',
    'StartRecord: it starts or stops a recording; give --allow-record to send it.',
    'StopRecord: it starts or stops a recording; give --allow-record to send it.',
  ]);
  // The fake's stream settings hold a server URL with a key, a user name and the password: the scrub took them out.
  // The keys of settings are hidden too (F-T6-16): server, protocol, key, use_auth, username, password.
  assert.deepEqual(trace.entries.find((e) => e.requestType === 'GetStreamServiceSettings').responseData.streamServiceSettings, {
    hidden_key_1: '[scrubbed]', hidden_key_2: '[scrubbed]', hidden_key_3: '[scrubbed]', hidden_key_4: true, hidden_key_5: '[scrubbed]', hidden_key_6: '[scrubbed]',
  });
  for (const secret of [PASSWORD, 'live_123456789_captureKey', 'someone']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(findLeaks(trace), []);
  assert.match(r.stderr, /6 requests recorded, 12 refused, written to .* after the scrub\./);
  assert.equal(r.stderr.includes(PASSWORD), false);

  // The fake OBS replays the captured trace: the captured GetStats reply comes back.
  const replay = await startFakeObs({ traces: [trace] });
  const obs = new OBSWebSocket();
  await obs.connect(`ws://127.0.0.1:${replay.port}`);
  assert.deepEqual(await obs.call('GetStats'), trace.entries.find((e) => e.requestType === 'GetStats').responseData);
  await obs.disconnect();
  await replay.close();
});

test('with --allow-record, the capture records a take with its events and its effect on the record state', async () => {
  const fake = await startFakeObs();
  const f = files();
  writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'GetRecordStatus' }, { requestType: 'StopRecord' }]));
  const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--allow-record']);
  await fake.close();
  assert.equal(r.code, 0, r.stderr);
  const take = JSON.parse(readFileSync(f.out, 'utf8')).entries.slice(3);
  assert.deepEqual(take.map((e) => [e.requestType, e.when.recording, e.events?.map((ev) => ev.eventData.outputState.replace('OBS_WEBSOCKET_OUTPUT_', '')), e.effect]), [
    ['StartRecord', false, ['STARTING', 'STARTED'], { recording: true }],
    ['GetRecordStatus', true, undefined, undefined],
    ['StopRecord', true, ['STOPPING', 'STOPPED'], { recording: false }],
  ]);
  // The stored real trace (real-record.json) has STOPPED 235 ms after StopRecord.
  assert.ok(take[2].events[1].delayMs >= 235, `STOPPED after ${take[2].events[1].delayMs} ms`);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
});

test('F-T6-1: during a take that --allow-record started, the capture still refuses each request that obs_read refuses, and a list request', async () => {
  const fake = await startFakeObs();
  const f = files();
  writeFileSync(f.plan, JSON.stringify([
    { requestType: 'StartRecord' },
    { requestType: 'OpenInputPropertiesDialog', requestData: { inputName: 'Display' } },
    { requestType: 'CallVendorRequest', requestData: { vendorName: 'x', requestType: 'stop' } },
    { requestType: 'TriggerHotkeyByName', requestData: { hotkeyName: 'OBSBasic.StopRecording' } },
    { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'Display', propertyName: 'type' } },
    { requestType: 'StopRecord' },
  ]));
  const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--allow-record']);
  await fake.close();
  assert.equal(r.code, 0, r.stderr);
  // Before its own StartRecord (twice) and StopRecord, the capture reads GetRecordStatus again (F-T6-19).
  assert.deepEqual(fake.log, ['GetVersion', 'GetStreamStatus', 'GetRecordStatus', 'GetRecordStatus', 'GetRecordStatus', 'StartRecord', ...GUARD_READS, 'GetRecordStatus', 'StopRecord']);
  assert.deepEqual(JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`), [
    `OpenInputPropertiesDialog: ${NOT_A_READ('change')}`,
    `CallVendorRequest: ${NOT_A_READ('guarded')}`,
    `TriggerHotkeyByName: ${NOT_A_READ('guarded')}`,
    'GetInputPropertiesListPropertyItems: a recording is active, and a list request can crash OBS.',
  ]);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
  assert.equal(fake.crashes(), 0);
});

// F-T6-19: a take that the user starts is never stopped by the capture, whenever the user starts it. The user is a
// second client of the fake OBS. Each plan asks for every record request; ToggleRecord is never sent.
const until = async (ok) => {
  const deadline = Date.now() + 10000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('the fake OBS did not reach the state in 10 s');
    await new Promise((r) => setTimeout(r, 5));
  }
};
/** A fake OBS with a second client, the user. Both close after the test, also when it fails. */
const userAndFake = async (t) => {
  const fake = await startFakeObs();
  const user = new OBSWebSocket();
  await user.connect(`ws://127.0.0.1:${fake.port}`);
  t.after(async () => {
    await user.disconnect();
    await fake.close();
  });
  return { fake, user };
};
const NOT_OWN = 'the active recording is not a take that the capture started, or that is not certain: the capture stops only its own take.';
const NOT_IDLE = 'a recording is active, or its state is not known: the capture starts a take only when no recording is active.';
const TAKE_PLAN = [{ requestType: 'GetStats' }, { requestType: 'GetStats' }, { requestType: 'StopRecord' }, { requestType: 'ToggleRecord' }, { requestType: 'StartRecord' }, { requestType: 'StopRecord' }];
for (const [moment, ready] of [
  // The R154 reproduction: the user starts a take just after the capture's first GetRecordStatus has its reply.
  ['just after the first record status read', (log) => log.includes('GetRecordStatus')],
  ['between two plan steps', (log) => log.includes('GetStats')],
  ['while the capture checks a StopRecord', (log) => log.filter((x) => x === 'GetRecordStatus').length >= 2],
  ['while the capture checks a StartRecord', (log) => log.filter((x) => x === 'GetRecordStatus').length >= 3],
]) {
  test(`F-T6-19: a user take started ${moment} is never stopped, and ToggleRecord is never sent`, async (t) => {
    const { fake, user } = await userAndFake(t);
    const f = files();
    writeFileSync(f.plan, JSON.stringify(TAKE_PLAN));
    const capture = run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '400', '--allow-record']);
    await until(() => ready(fake.log));
    await user.call('StartRecord');
    const r = await capture;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.state.recording, true);
    assert.deepEqual(fake.stops, []);
    assert.equal(fake.log.includes('ToggleRecord'), false);
    // The user's StartRecord is the only one that OBS got.
    assert.equal(fake.log.filter((x) => x === 'StartRecord').length, 1);
    const refused = JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`);
    assert.deepEqual(refused.filter((x) => !x.startsWith('ToggleRecord')).slice(-2), [`StartRecord: ${NOT_IDLE}`, `StopRecord: ${NOT_OWN}`]);
    assert.deepEqual(refused.find((x) => x.startsWith('ToggleRecord')), `ToggleRecord: ${NOT_A_READ('guarded')}`);
  });
}

test('F-T6-19: when the user stops the capture\'s take and starts a new one, the capture does not stop the new take', async (t) => {
  const { fake, user } = await userAndFake(t);
  const f = files();
  writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'GetStats' }, { requestType: 'StopRecord' }]));
  const capture = run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '1500', '--allow-record']);
  await until(() => fake.log.includes('GetStats'));
  await user.call('StopRecord');
  await until(() => !fake.state.recording);
  await user.call('StartRecord');
  await until(() => fake.state.recording);
  const r = await capture;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.recording, true);
  // The one stop is the user's own stop of the capture's take.
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
  assert.equal(fake.log.filter((x) => x === 'StopRecord').length, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`), [`StopRecord: ${NOT_OWN}`]);
});

// F-T6-4 and F-T6-9: a crash of OBS or a request with no reply ends the capture with the reason, and the partial trace is written.
for (const [name, options, reason] of [
  ['OBS closes the connection', { crashOn: 'GetSceneList' }, 'OBS closed the connection (1006) while GetSceneList was in flight.'],
  ['OBS gives no reply', { silentOn: ['GetSceneList'] }, 'OBS gave no reply to GetSceneList in 300 ms.'],
]) {
  test(`when ${name} during the capture, it stops with the reason and writes the scrubbed partial trace`, async () => {
    const fake = await startFakeObs(options);
    const f = files();
    writeFileSync(f.plan, JSON.stringify([{ requestType: 'GetStats' }, { requestType: 'GetSceneList' }, { requestType: 'GetVideoSettings' }]));
    const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--timeout-ms', '300']);
    await fake.close();
    assert.equal(r.code, 5, r.stderr);
    assert.equal(r.stderr, `capture-traces: stopped: ${reason} The partial trace (4 requests) is written to ${f.out} after the scrub.\n`);
    const trace = JSON.parse(readFileSync(f.out, 'utf8'));
    assert.equal(trace.incomplete, `The capture stopped: ${reason}`);
    assert.deepEqual(trace.entries.map((e) => e.requestType), ['GetVersion', 'GetStreamStatus', 'GetRecordStatus', 'GetStats']);
    assert.deepEqual(findLeaks(trace), []);
  });
}

for (const [name, state] of [['a recording', { recording: true }], ['a stream', { streaming: true }]]) {
  test(`during ${name}, the capture sends nothing after the two status reads and writes no file`, async () => {
    const fake = await startFakeObs(state);
    const f = files();
    const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--settle-ms', '0', '--allow-record']);
    await fake.close();
    assert.equal(r.code, 3);
    assert.match(r.stderr, /a stream or a recording is active, or its state is not known\. The capture sends nothing during an output, and wrote no file\./);
    assert.deepEqual(fake.log, ['GetVersion', 'GetStreamStatus', 'GetRecordStatus']);
    assert.equal(existsSync(f.out), false);
    assert.deepEqual(fake.stops, []);
  });
}

test('a password argument, a stray argument or a non-loopback URL is refused before any connection, and not echoed', async () => {
  const fake = await startFakeObs();
  const f = files();
  const url = `ws://127.0.0.1:${fake.port}`;
  const runs = [
    await run(['--url', url, '--out', f.out, '--password', PASSWORD]),
    await run(['--url', url, '--out', f.out, PASSWORD]),
    await run(['--url', 'ws://192.0.2.10:4455', '--out', f.out]),
  ];
  await fake.close();
  assert.deepEqual(runs.map((r) => r.code), [2, 2, 2]);
  assert.match(runs[0].stderr, /never from an argument/);
  assert.match(runs[1].stderr, /unknown argument/);
  assert.match(runs[2].stderr, /loopback address/);
  assert.equal(runs.some((r) => r.stderr.includes(PASSWORD)), false);
  assert.equal(fake.connections(), 0);
});
