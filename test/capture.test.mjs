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
  { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'Display', propertyName: 'display_uuid' } },
  { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'Display', propertyName: 'type' } },
  { requestType: 'StartStream' },
  { requestType: 'ToggleOutput', requestData: { outputName: 'adv_file_output' } },
  { requestType: 'StartRecord' },
  { requestType: 'StopRecord' },
  { requestType: 'GetStreamServiceSettings' },
];

test('the capture sends the plan, refuses the crash rows, a stream start and a record start or stop, and writes a scrubbed trace', async () => {
  const fake = await startFakeObs({ password: PASSWORD, streamKey: 'live_123456789_captureKey' });
  const f = files();
  writeFileSync(f.plan, JSON.stringify(PLAN));
  const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0'], { OBS_WEBSOCKET_PASSWORD: PASSWORD });
  await fake.close();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.log, ['GetVersion', 'GetStreamStatus', 'GetRecordStatus', 'GetStats', 'GetInputPropertiesListPropertyItems', 'GetStreamServiceSettings']);
  assert.equal(fake.crashes(), 0);
  const text = readFileSync(f.out, 'utf8');
  const trace = JSON.parse(text);
  assert.equal(trace.source, 'captured');
  assert.deepEqual(trace.refused.map((x) => `${x.requestType} ${x.requestData?.propertyName ?? ''}: ${x.refused}`), [
    'GetInputPropertiesListPropertyItems application: a list request on "application" crashed OBS 33.0.1 (T4).',
    'GetInputPropertiesListPropertyItems display_uuid: a list request on "display_uuid" crashed OBS 33.0.1 (T4).',
    'StartStream : it can start a stream or stop a recording, so the capture never sends it.',
    'ToggleOutput : it can start a stream or stop a recording, so the capture never sends it.',
    'StartRecord : it starts or stops a recording; give --allow-record to send it.',
    'StopRecord : it starts or stops a recording; give --allow-record to send it.',
  ]);
  // The fake's stream settings hold a server URL with a key, a user name and the password: the scrub took them out.
  assert.deepEqual(trace.entries.find((e) => e.requestType === 'GetStreamServiceSettings').responseData.streamServiceSettings, {
    server: '[scrubbed]', protocol: 'RTMP', key: '[scrubbed]', use_auth: true, username: '[scrubbed]', password: '[scrubbed]',
  });
  for (const secret of [PASSWORD, 'live_123456789_captureKey', 'someone']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(findLeaks(trace), []);
  assert.match(r.stderr, /6 requests recorded, 6 refused, written to .* after the scrub\./);
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
  assert.ok(take[2].events[1].delayMs >= 1000, `STOPPED after ${take[2].events[1].delayMs} ms`);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
});

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
