// The OBS connection in-process, with short limits, against the fake OBS. SIMULATED: no real OBS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionTarget, Obs } from '../dist/obs.js';
import { startFakeObs } from './fake-obs.mjs';
import { obsConfigDir, testEnv } from './helpers.mjs';

const LIMITS = { connectMs: 300, callMs: 300 };
const obsFor = (fake) => new Obs(() => connectionTarget(obsConfigDir(null), testEnv('', fake.port)), LIMITS);

test('F-T12-20: a program that accepts the connection and never answers GetVersion fails the connection in time', async () => {
  const fake = await startFakeObs({ silentOn: ['GetVersion'] });
  const obs = obsFor(fake);
  const t = performance.now();
  await assert.rejects(obs.connect(), { message: `No reply from OBS on 127.0.0.1:${fake.port} in 300 ms. The program on that port accepted the connection, then did not answer.` });
  assert.ok(performance.now() - t < 2000);
  await obs.close();
  await fake.close();
});

test('F-T12-30: a request with no reply fails after the request limit, and the connection stays usable', async () => {
  const fake = await startFakeObs({ silentOn: ['GetStats'] });
  const obs = obsFor(fake);
  await assert.rejects(obs.call('GetStats'), { message: 'No reply from OBS to GetStats in 300 ms.' });
  assert.equal((await obs.call('GetRecordStatus')).outputActive, false);
  assert.equal(fake.connections(), 1);
  await obs.close();
  await fake.close();
});

test('F-T12-30: after OBS closes the connection, the next call opens a new one', async () => {
  const fake = await startFakeObs({ crashOn: 'GetStats' });
  const obs = obsFor(fake);
  await obs.connect();
  await assert.rejects(obs.call('GetStats'), { message: 'OBS closed the connection with code 1006 (abnormal close). OBS may have crashed.' });
  assert.equal((await obs.call('GetRecordStatus')).outputActive, false);
  assert.equal(fake.connections(), 2);
  assert.deepEqual(fake.log, ['GetVersion', 'GetStats', 'GetVersion', 'GetRecordStatus']);
  await obs.close();
  await fake.close();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('T7 unit 2: a drop and a reconnect raise the connection number by 1, each read and event carries its number, and the reconnect sends no request', async () => {
  const fake = await startFakeObs({ recording: true });
  const obs = new Obs(() => connectionTarget(obsConfigDir(null), testEnv('', fake.port)), { ...LIMITS, reconnectMs: [50, 100] });
  const events = [];
  obs.onEvent((e) => events.push(`${e.type}${e.data.outputState ? ` ${e.data.outputState.replace('OBS_WEBSOCKET_OUTPUT_', '')}` : ''} #${e.conn}`));
  obs.keepConnected(true);
  await wait(150);
  assert.equal(obs.connection, 1);
  const a = await obs.read('GetRecordStatus');
  assert.deepEqual([a.conn, a.data.outputActive], [1, true]);
  fake.log.length = 0;
  fake.restartObs(); // the socket drops; the fake still listens, as an OBS that opened again
  await wait(20);
  assert.equal(obs.connected, false);
  // A recording request on the old connection never goes out, and opens no connection.
  await assert.rejects(obs.callOn(1, 'StopRecord'), { message: 'The connection to OBS changed before StopRecord, so it was not sent.' });
  await wait(200);
  assert.equal(obs.connection, 2);
  assert.deepEqual(fake.log, ['GetVersion'], 'the reconnect sends only GetVersion');
  await assert.rejects(obs.callOn(1, 'StopRecord'), { message: 'The connection to OBS changed before StopRecord, so it was not sent.' });
  const b = await obs.read('GetRecordStatus');
  assert.deepEqual([b.conn, b.data.outputActive], [2, false]);
  fake.startInObs();
  await wait(350);
  assert.deepEqual(events, ['closed #1', 'RecordStateChanged STARTING #2', 'RecordStateChanged STARTED #2']);
  assert.deepEqual(fake.log, ['GetVersion', 'GetRecordStatus']);
  await obs.close();
  await fake.close();
});

test('T7 unit 2: with OBS gone, the reconnect waits grow and go on until OBS answers', async () => {
  const fake = await startFakeObs();
  const port = fake.port;
  const obs = new Obs(() => connectionTarget(obsConfigDir(null), testEnv('', port)), { ...LIMITS, reconnectMs: [30, 60, 120] });
  obs.keepConnected(true);
  await wait(80);
  assert.equal(obs.connection, 1);
  await fake.close();
  await wait(400);
  assert.equal(obs.connected, false);
  const back = await startFakeObs({ port });
  await wait(300);
  assert.equal(obs.connection, 2, 'it reconnects to the OBS that opened again');
  assert.deepEqual(back.log, ['GetVersion']);
  obs.keepConnected(false);
  await obs.close();
  await back.close();
});
