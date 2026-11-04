// T7 repair round 5: the texts of F-T7-67 (K1), F-T7-75, F-T7-77 and F-T7-78. The lock findings are in
// control.test.mjs, and F-T7-76 in take-repair.test.mjs. SIMULATED: fake OBS only, with the scaled limits of
// test/take-app.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clock, newTake, stateLine, step, TEXT } from '../dist/take.js';
import { accept } from './mcp-pair.mjs';
import { FAST, recordRequests, server, until, wait, world } from './take-app.mjs';

const status = async (s) => (await s.call('obs_take_status')).text;
const logs = (s) => s.logs.map((l) => l.data).join('\n');
const done = async (w, ...servers) => {
  for (const s of servers) await s.kill();
  await w.fake.close();
};
const at = Date.UTC(2026, 10, 4, 9, 15, 30);

test('F-T7-75, F-T7-67 K1: a drop and a close with a paused take say that the recording is paused, not that OBS keeps recording', async () => {
  const paused = step({ ...newTake('t', 'normal', 'paused'), pausedAt: at - 5000 }, { type: 'disconnect', at }).take;
  assert.equal(stateLine(paused, undefined, at), `I lost the connection to OBS at ${clock(at)}. The recording was paused then. I reconnect, and I send no recording request. The recording is paused at 00:00:00, for 5 s now. Nothing goes into the file.`);
  assert.equal(TEXT.X14('paused'), 'obs-mcp is closing. The recording stays paused in OBS. I did not stop it.');
  // The same on a server: OBS pauses, then the connection drops.
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'paused-drop-1' });
  w.fake.pauseInObs();
  assert.ok(await until(() => s.app.takes.recording === 'paused'), 'X14 gets the paused state');
  w.fake.down(FAST.goneMs / 2);
  assert.ok(await until(async () => /^I lost the connection to OBS at \d\d:\d\d:\d\d\. The recording was paused then\./.test(await status(s)), 2000));
  assert.doesNotMatch(await status(s), /keeps recording/);
  await done(w, s);
});

test('F-T7-77: a stop when OBS gives no file path shows no dialog: X20 at once, and nothing is sent', async () => {
  const w = await world({ plant: true }); // the path field of the file output is not a usable path
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'nopath-stop-1' });
  const r = await s.call('obs_record_stop');
  assert.equal(r.text, 'I did not stop the recording. OBS gives me no file path for it, so I cannot check that a stop goes to the right recording. To stop it, click Stop Recording in the Controls dock of OBS.');
  assert.equal(s.prompts.length, 1, 'only the start dialog');
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('F-T7-78: X11 at the gone limit says that the connection was lost and that the state of the recording is unknown; with no path it checks no file', async () => {
  const t = { ...newTake('t', 'normal', 'recording'), paths: ['rec/a.mov'] };
  const lost = step(step(t, { type: 'disconnect', at }).take, { type: 'timeout', phase: 'gone', at: at + 60000 }).take;
  assert.equal(TEXT.X11(lost), `I lost the connection to OBS at ${clock(at)}, and OBS has not answered since. I do not know the state of the recording now. I am checking the file that OBS wrote: \`a.mov\`.`);
  const r5 = step({ ...t, paths: [] }, { type: 'restart', reading: { at, conn: 1, ev: 0, active: false, paused: false, duration: 0, bytes: 0 }, same: false, at }).take;
  assert.equal(TEXT.X11(r5), 'The recording stopped while I did not watch it, and nobody asked for it. OBS may show an error dialog. OBS gave me no file path, so I cannot check the file.');
  // On a server: a drop of 3 times the gone limit while OBS goes on recording.
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'gone-x11-1' });
  await wait(300);
  w.fake.down(FAST.goneMs * 3);
  assert.ok(await until(() => /I do not know the state of the recording now/.test(logs(s)), FAST.goneMs * 3));
  assert.doesNotMatch(logs(s), /The recording stopped .*nobody asked for it/);
  await done(w, s);
});

test('CI hang: a test that fails before it closes its fake OBS and its servers does not keep its file running, with no --test-force-exit', async () => {
  const file = fileURLToPath(new URL('./leak/leak.test.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // a run of its own, as npm test starts it
  const child = spawn(process.execPath, ['--test', '--test-reporter=dot', file], { stdio: 'ignore', env });
  const kill = setTimeout(() => child.kill('SIGKILL'), 20000);
  const [code, signal] = await new Promise((r) => child.on('exit', (...a) => r(a)));
  clearTimeout(kill);
  assert.deepEqual([code, signal], [1, null], 'the file ends with its failure, and is not killed after 20 s');
});
