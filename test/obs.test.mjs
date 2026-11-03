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
