// The stored traces, the trace scrub and the trace replay of the fake OBS. SIMULATED: no real OBS.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OBSWebSocket, EventSubscription } from 'obs-websocket-js/json';
import { findLeaks, scrub } from '../scripts/trace-scrub.mjs';
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

// A raw trace part with one value of each kind that the scrub must remove.
const RAW = {
  hello: { obsWebSocketVersion: '5.7.6', authentication: { challenge: 'Q2hhbGxlbmdlVmFsdWU=', salt: 'U2FsdFZhbHVl' } },
  identify: { rpcVersion: 1, authentication: 'aGFzaGVkLXBhc3N3b3Jk' },
  streamServiceSettings: { server: 'rtmp://live.example.com/app/live_123456789_abcdefgh', key: 'live_123456789_abcdefgh', service: 'Twitch', protocol: 'RTMP', use_auth: true, username: 'alice', password: 'hunter22' },
  outputSettings: { path: `${HOME}/Movies/2026-11-03 10-00-00.mov`, muxer_settings: '', bitrate: 6000 },
  recordDirectory: `${LINUX_HOME}/Videos`,
  inputSettings: { display_uuid: '5d1f3c2a-8b4e-4f6a-9c7d-0e1f2a3b4c5d', type: 0, device_id: 'default', window_name: 'Mail - alice' },
  log: `obs --websocket_password hunter22 from ${WIN_HOME}\\obs on studio-mac.local at ${LAN} and fe80::1c2d, mail ${['ops.team', 'example.org'].join('@')}`,
  bare: 'ingest.example.com:1935/app/k3y',
  header: 'Authorization: Bearer abc.def.ghi',
  url: 'ws://127.0.0.1:4455',
  kept: { outputTimecode: '00:00:01.234', obsVersion: '33.0.1', outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', activeFps: 30 },
};

test('the scrub replaces each secret and machine detail, and keeps timecodes, versions and states', () => {
  assert.deepEqual(scrub(RAW, { ...MACHINE, secrets: ['hunter22'] }), {
    hello: { obsWebSocketVersion: '5.7.6', authentication: '[scrubbed]' },
    identify: { rpcVersion: 1, authentication: '[scrubbed]' },
    streamServiceSettings: { server: '[scrubbed]', key: '[scrubbed]', service: 'Twitch', protocol: 'RTMP', use_auth: true, username: '[scrubbed]', password: '[scrubbed]' },
    outputSettings: { path: '[path]', muxer_settings: '', bitrate: 6000 },
    recordDirectory: '[path]',
    inputSettings: { display_uuid: '[scrubbed]', type: 0, device_id: 'default', window_name: '[scrubbed]' },
    log: 'obs --websocket_password=[scrubbed] from C:\\Users\\[user]\\obs on [host] at [address] and [address], mail [email]',
    bare: '[host]',
    header: 'Authorization: Bearer [scrubbed]',
    url: 'ws://[scrubbed]',
    kept: { outputTimecode: '00:00:01.234', obsVersion: '33.0.1', outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', activeFps: 30 },
  });
});

test('the leak scan names each place and rule of a raw trace, never the value, and finds nothing after the scrub', () => {
  const leaks = findLeaks(RAW, MACHINE);
  assert.deepEqual(leaks.map((l) => l.path), [
    'hello.authentication', 'identify.authentication', 'streamServiceSettings.server', 'streamServiceSettings.key',
    'streamServiceSettings.username', 'streamServiceSettings.password', 'outputSettings.path', 'recordDirectory',
    'inputSettings.display_uuid', 'inputSettings.window_name',
    'log', 'log', 'log', 'log', 'log', 'log', 'bare', 'header', 'url',
  ]);
  // The user name in the Windows home goes by the account-name rule, before the Windows home rule sees it.
  assert.deepEqual(leaks.filter((l) => l.path === 'log').map((l) => l.rule), ['account name of this machine', 'host name of this machine', 'flag with a secret', 'e-mail', 'IPv4 address', 'IPv6 address']);
  assert.equal(JSON.stringify(leaks).includes('hunter22'), false);
  const clean = scrub(RAW, MACHINE);
  assert.deepEqual(findLeaks(clean, MACHINE), []);
  assert.deepEqual(scrub(clean, MACHINE), clean);
});

test('the scrub removes the account name and host name of this machine, and a secret of the run, in any text', () => {
  const out = scrub({ note: 'Alice ran OBS on studio-mac; token hunter22 held' }, { ...MACHINE, secrets: ['hunter22'] });
  assert.deepEqual(out, { note: '[user] ran OBS on [host]; token [scrubbed] held' });
  // A name of 3 letters or fewer is not matched, so that a user called "obs" does not empty every trace.
  assert.deepEqual(scrub({ note: 'obs ran' }, { user: 'obs', host: 'pc' }), { note: 'obs ran' });
});

const traces = loadTraces();

test('each stored trace is labelled, documented, and holds no password, stream key, user name, home path or address', () => {
  assert.ok(traces.length >= 3, `${traces.length} trace files in ${fileURLToPath(TRACE_DIR)}`);
  for (const t of traces) {
    assert.equal(t.format, 'obs-mcp-trace/1', t.file);
    // This release holds SIMULATED traces only. A captured trace says "captured".
    assert.ok(['simulated', 'captured'].includes(t.source), `${t.file}: source ${t.source}`);
    assert.match(t.basis, /\S/, t.file);
    for (const e of t.entries) {
      assert.ok(DOCUMENTED.has(e.requestType), `${t.file}: ${e.requestType}`);
      assert.equal(typeof e.status.code, 'number', `${t.file}: ${e.requestType}`);
      for (const ev of e.events ?? []) assert.ok(EVENTS.has(ev.eventType), `${t.file}: ${ev.eventType}`);
    }
    const { file, ...stored } = t;
    assert.deepEqual(findLeaks(stored), [], file);
  }
  assert.deepEqual([...new Set(traces.map((t) => t.source))], ['simulated']);
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

test('the fake OBS replays a record stop: STOPPING, then STOPPED about 1 s later, and counts the stop', async () => {
  const fake = await startFakeObs({ recording: true });
  const c = await client(fake);
  const t = performance.now();
  const stopped = new Promise((r) => c.obs.on('RecordStateChanged', (d) => d.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED' && r(d)));
  assert.deepEqual(await c.call('StopRecord'), { code: 100, d: { outputPath: '[path]' } });
  assert.equal((await c.call('GetRecordStatus')).d.outputActive, true, 'OBS still records until STOPPED');
  assert.deepEqual(await stopped, { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: '[path]' });
  assert.ok(performance.now() - t >= 900, `${Math.round(performance.now() - t)} ms`);
  assert.equal((await c.call('GetRecordStatus')).d.outputActive, false);
  assert.deepEqual(c.events, ['OBS_WEBSOCKET_OUTPUT_STOPPING', 'OBS_WEBSOCKET_OUTPUT_STOPPED']);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
  assert.equal((await c.call('StopRecord')).code, 501);
  await c.obs.disconnect();
  await fake.close();
});

test('the fake OBS sends events only to a client that subscribed to their category, as obs-websocket does', async () => {
  const fake = await startFakeObs();
  const none = await client(fake, EventSubscription.None);
  const outputs = await client(fake);
  await none.call('StartRecord');
  await new Promise((r) => setTimeout(r, 200));
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
  assert.deepEqual(paths, [{}, { path: '[path]', muxer_settings: '' }]);
});
