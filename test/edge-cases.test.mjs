// T7 unit 7: the edge cases E1 to E27 of section 5, one test each, on the fake OBS. SIMULATED: no real OBS.
// Limits are scaled down (test/take-app.mjs). Each test also checks the recording requests that reached OBS.
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from '../dist/server.js';
import { Journal } from '../dist/journal.js';
import { newTake, step, TEXT } from '../dist/take.js';
import { connect, obsConfigDir, testEnv } from './helpers.mjs';
import { accept, after, decline, pair } from './mcp-pair.mjs';
import { recordRequests, server, until, wait, world } from './take-app.mjs';

const status = async (s) => (await s.call('obs_take_status')).text;
const take = (w) => {
  const j = new Journal(w.dir, 'x');
  const id = readdirSync(w.dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(5, -6))[0];
  return { id, ...j.load(id), rows: j.read(id).filter((r) => r.t === 'state').map((r) => r.row) };
};
async function recording(opts = {}, fake = {}) {
  const w = await world(fake);
  const s = await server(w, { elicit: accept, ...opts });
  assert.match((await s.call('obs_record_start', { token: 'edge-token-1', ...(opts.test ? { test: true } : {}) })).text, /Recording for /);
  return { w, s };
}
const done = async (w, ...servers) => {
  for (const s of servers) await s.kill();
  await w.fake.close();
};

test('E1: OBS crashes during a take: unplanned_stop and alert X11 at once (level error); with no OBS for 60 s: lost', async () => {
  const { w, s } = await recording();
  w.fake.restartObs(); // the crash ends the recording; OBS comes back with nothing running
  assert.ok(await until(() => s.logs.some((l) => l.level === 'error' && /^The recording stopped at about \d\d:\d\d, and nobody asked for it\./.test(l.data))));
  assert.ok(take(w).take.marks.includes('unplanned_stop'));
  await done(w, s);

  const b = await recording();
  await b.w.fake.close(); // OBS is gone and does not come back
  assert.ok(await until(() => take(b.w).take.marks.includes('lost'), 3000), 'P9: lost after the limit');
  assert.ok(b.s.logs.some((l) => l.level === 'error'));
  assert.deepEqual(recordRequests(b.w.fake), ['StartRecord']);
  await b.s.kill();
});

test('E2: a socket drop while OBS records: the take stays, marked offline, and the reconnect finds the same recording; nothing is sent again', async () => {
  const { w, s } = await recording();
  w.fake.drop();
  assert.ok(await until(() => take(w).rows.includes('O1') && take(w).take.marks.includes('offline')), 'the drop marks the take offline (O1)');
  assert.ok(await until(() => !take(w).take.marks.includes('offline')), 'the reconnect clears the offline mark');
  assert.match(await status(s), /^Recording for /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('E2, F-T7-17: a drop right after StopRecord: stop_uncertain with the text of 7.1, never a second stop; the read after the reconnect ends it (T17)', async () => {
  const { w, s } = await recording({}, { closeAfter: ['StopRecord'] });
  const r = await s.call('obs_record_stop');
  assert.equal(r.text, 'I lost the connection to OBS right after I sent the stop. I will not send it again. I reconnect and read what OBS shows.');
  assert.ok(await until(() => take(w).rows.includes('T17')));
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, s);
});

test('E3: a server restart during a test take: R3, the gap is reported, and reminder W8 goes on the notice channel', async () => {
  const { w, s } = await recording({ test: true });
  await s.kill();
  await wait(700);
  const s2 = await server(w, { elicit: accept });
  const text = await status(s2);
  assert.match(text, /^OBS still records the take that I started \(00:00:0\d, file .*\)\. The watch had a gap from \d\d:\d\d:\d\d to \d\d:\d\d:\d\d\./);
  assert.match(text, /\nA test recording still runs \(/);
  assert.ok(take(w).rows.includes('R3'));
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s2);
});

test('E4: you start a recording in OBS: an external take (T22), notice X15, watched at once; nothing is sent', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await status(s); // the connection is open
  w.fake.startInObs();
  assert.ok(await until(() => s.logs.some((l) => /^OBS started a recording at \d\d:\d\d:\d\d \(file .*\)\. obs-mcp did not start it, and it does not stop it\./.test(l.data))));
  assert.match(await status(s), /OBS is recording \(00:00:0\d, file .*\), but obs-mcp did not start this recording\./);
  assert.equal(take(w).take.kind, 'external');
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, s);
});

test('E5: you stop our take in OBS: T20, stopped_in_obs, reply X12, the file check runs', async () => {
  const { w, s } = await recording();
  w.fake.stopInObs();
  assert.ok(await until(() => take(w).rows.includes('T20')));
  assert.ok(take(w).take.marks.includes('stopped_in_obs'));
  assert.ok(await until(async () => /Take closed: not_checked/.test(await status(s))), 'the file check ran');
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('E6, E11: you pause in OBS; a stop while paused shows W5 and passes the same-recording test', async () => {
  const { w, s } = await recording();
  w.fake.pauseInObs();
  await wait(50);
  assert.match(await status(s), /^The recording is paused at 00:00:0\d, for 0 s now\. Nothing goes into the file\.$/);
  const r = await s.call('obs_record_stop');
  assert.match(s.prompts[1], /^Stop the OBS recording\? It is paused at 00:00:0\d\. File: .*\. Accept to stop\. Decline to keep it paused\.$/);
  assert.match(r.text, /^The recording stopped at .* \(OBS confirmed it\)\./);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, s);
});

test('E7: two clients: a start from the second client while the take runs is refused (X6); its stop gets X16', async () => {
  const { w, s } = await recording();
  const b = await server(w, { elicit: accept, client: 'Cursor' });
  assert.match((await b.call('obs_record_start', { token: 'other-token-1' })).text, /^OBS already records \(started \d\d:\d\d:\d\d, file .*\)\. I did not send a start\./);
  assert.equal((await b.call('obs_record_stop')).text, TEXT.X16('Claude Code'));
  assert.deepEqual(b.prompts, []);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s, b);
});

test('E8: a stop in a client with no elicitation: X1, nothing sent; the stop in OBS is then seen and the file checked', async () => {
  const { w, s } = await recording();
  const plain = await pair(() => createServer(s.app), { name: 'Claude Code' }); // the same process, a client with no dialog
  assert.equal((await plain.call('obs_record_stop')).text, TEXT.X1);
  w.fake.stopInObs();
  assert.ok(await until(() => take(w).rows.includes('T20')));
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await plain.close();
  await done(w, s);
});

test('E9, E27: a start in a client with no elicitation: X2; then Start Recording in OBS opens an external take with no expected sources', async () => {
  const w = await world();
  const s = await server(w);
  assert.equal((await s.call('obs_record_start', { token: 'plain-token-1' })).text, TEXT.X2);
  w.fake.startInObs();
  assert.ok(await until(() => s.logs.some((l) => /I check the file when it ends\. No expected sources\. To name them, run obs_preflight \(in a later version\)\.$/.test(l.data))));
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, s);
});

test('E10: a late 500 to our start after your stop went out: the take is external, the stop stands, nothing more is sent', () => {
  const s = step({ ...newTake('t', 'normal', 'stopping'), paths: ['a.mov'] }, { type: 'reply', request: 'StartRecord', code: 500, at: 1 });
  assert.deepEqual([s.row, s.take.state, s.take.kind, s.send], ['E10', 'stopping', 'external', undefined]);
  // A 500 or another code to our StopRecord is uncertain (T16); a 501 means OBS had stopped (T15).
  assert.equal(step(newTake('t', 'normal', 'stopping'), { type: 'reply', request: 'StopRecord', code: 500, at: 1 }).take.state, 'stop_uncertain');
  assert.deepEqual(step(newTake('t', 'normal', 'stopping'), { type: 'reply', request: 'StopRecord', code: 501, at: 1 }).take.marks, ['stopped_in_obs']);
});

test('E11: you resume between the prompt and your answer: the bound still holds, and the stop goes out once', async () => {
  const w = await world();
  let fake;
  const s = await server(w, {
    elicit: async (msg) => {
      if (/^Stop/.test(msg)) {
        fake.resumeInObs();
        await wait(100);
      }
      return { action: 'accept', content: {} };
    },
  });
  fake = w.fake;
  await s.call('obs_record_start', { token: 'pause-token-1' });
  w.fake.pauseInObs();
  await wait(50);
  assert.match((await s.call('obs_record_stop')).text, /^The recording stopped at /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, s);
});

test('E12: a start with no STARTED in 5 s: start_uncertain (X9), reads each second, and a late read of the start gives recording (T4)', async () => {
  const { s, w } = { w: await world({ dropEvents: ['OBS_WEBSOCKET_OUTPUT_STARTED'] }) };
  const c = await server(w, { elicit: accept });
  const r = await c.call('obs_record_start', { token: 'slow-token-1' });
  assert.match(r.text, /^I sent the start at \d\d:\d\d:\d\d, but OBS did not confirm it in 5 s\. I will not send it again\. OBS may still start\./);
  assert.ok(await until(() => take(w).rows.includes('T4')));
  assert.match(await status(c), /^Recording for /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  void s;
  await done(w, c);
});

test('E13: a record event in the last 2 s refuses the start (X6) before any prompt', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await status(s);
  w.fake.startInObs();
  await wait(350);
  w.fake.stopInObs();
  await wait(300);
  const r = await s.call('obs_record_start', { token: 'race-token-1' });
  assert.match(r.text.split('\n').at(-1), /I did not send a start\./);
  assert.deepEqual(s.prompts, []);
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, s);
});

test('E14: you decline: X4, the state does not change, nothing is sent', async () => {
  const { w, s } = await recording();
  const b = await pair(() => createServer(s.app), { elicit: decline, name: 'Claude Code' });
  assert.match((await b.call('obs_record_stop')).text, /^You declined\. I did not stop the recording\. It still records \(00:00:0\d\)\.$/);
  assert.match(await status(s), /^Recording for /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await b.close();
  await done(w, s);
});

test('E15: no answer in time on a 2025-era client: nothing is sent, and X5 goes on the notice channel', async () => {
  const { w, s } = await recording();
  const slow = await pair(() => createServer(s.app), { elicit: after(2600, accept), name: 'Claude Code' });
  const r = await slow.call('obs_record_stop');
  // The prompt ends at the life of the consent id (120 s, scaled: 2 s), and X5 is the reply too (F-T7-49).
  assert.equal(r.isError, false);
  assert.match(r.text, /^No answer in 2 minutes\. I did not stop the recording\. It still records \(/);
  assert.ok(await until(() => s.logs.some((l) => /^No answer in 2 minutes\. I did not stop the recording\. It still records \(/.test(l.data))));
  await wait(700);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await slow.close();
  await done(w, s);
});

test('E16: a lost reply to our start: start_uncertain, then recording; the client repeats the start with the same token and nothing is sent again', async () => {
  const w = await world({ closeAfter: ['StartRecord'] });
  const s = await server(w, { elicit: accept });
  assert.match((await s.call('obs_record_start', { token: 'lost-token-1' })).text, /OBS did not confirm it in 5 s/);
  assert.ok(await until(() => take(w).rows.includes('T4')));
  assert.match((await s.call('obs_record_start', { token: 'lost-token-1' })).text, /^Recording for /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('E17: end of input during a take: the process exits, OBS keeps recording, the journal keeps the take, nothing is sent', async () => {
  const w = await world();
  const env = testEnv(obsConfigDir(null), w.fake.port, { OBS_MCP_STATE_DIR: w.dir, OBS_MCP_RECORDING_DIR: w.rec });
  const s = await connect(env, { elicit: accept });
  await s.call('obs_record_start', { token: 'eof-token-1' });
  const pid = s.pid();
  await s.close();
  assert.ok(await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }), 'the server process exited');
  assert.equal(w.fake.state.recording, true);
  assert.equal(take(w).take.state, 'recording');
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await w.fake.close();
});

test('E18: OBS stops by itself with no STOPPED event: the watch sees it, unplanned_stop, alert X11 at once', async () => {
  const { w, s } = await recording({}, { dropEvents: ['OBS_WEBSOCKET_OUTPUT_STOPPING', 'OBS_WEBSOCKET_OUTPUT_STOPPED'] });
  w.fake.stopInObs(); // stands for a disk-full stop: the events never come
  assert.ok(await until(() => s.logs.some((l) => l.level === 'error')));
  assert.ok(take(w).take.marks.includes('unplanned_stop'));
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('E19: during a take, obs_read refuses the record requests and sends none of them', async () => {
  const { w, s } = await recording();
  for (const request of ['StopRecord', 'ToggleRecord', 'PauseRecord', 'StopOutput']) assert.equal((await s.call('obs_read', { request })).isError, true, request);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('E20: a forgotten test take: reminders go on, and nothing ever stops it', async () => {
  const { w, s } = await recording({ test: true });
  assert.ok(await until(() => s.logs.filter((l) => /^A test recording still runs/.test(l.data)).length >= 3, 3000));
  assert.equal(w.fake.state.recording, true);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('E21: two MCP servers made by one process share one take, one OBS client and one journal', async () => {
  const { w, s } = await recording();
  const second = await pair(() => createServer(s.app), { name: 'Claude Code' });
  assert.match((await second.call('obs_take_status')).text, /^Recording for /);
  assert.equal(w.fake.connections(), 1);
  await second.close();
  await done(w, s);
});

test('E22: the journal cannot be written: the start is not sent', async () => {
  const w = await world();
  writeFileSync(w.dir, 'a file where the journal folder should be');
  const s = await server(w, { elicit: accept });
  assert.equal((await s.call('obs_record_start', { token: 'disk-token-1' })).text, 'I could not save the take record, so I did not send the start.');
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, s);
});

test('E23, F6: two parallel stop accepts send exactly one StopRecord', async () => {
  const { w, s } = await recording();
  const [a, b] = await Promise.all([s.call('obs_record_stop'), s.call('obs_record_stop')]);
  assert.equal(recordRequests(w.fake).filter((r) => r === 'StopRecord').length, 1);
  assert.ok([a.text, b.text].some((t) => /^The recording stopped at /.test(t)), `${a.text}\n${b.text}`);
  await done(w, s);
});

test('E24: the starting client restarts: its new process takes the take over after 15 s (scaled) and can stop it; another client still gets X16', async () => {
  const { w, s } = await recording();
  await s.kill();
  await wait(700);
  const other = await server(w, { elicit: accept, client: 'Cursor' });
  assert.equal((await other.call('obs_record_stop')).text.split('\n').at(-1), TEXT.X16('Claude Code'));
  const again = await server(w, { elicit: accept });
  assert.match((await again.call('obs_record_stop')).text, /^(OBS still records the take that I started .*\n)?The recording stopped at /);
  assert.equal(new Journal(w.dir, 'x').owner(take(w).id).k, 2);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, other, again);
});

test('E25: two processes see one external take: one owner file; the other process gets X16', async () => {
  const w = await world();
  const a = await server(w, { elicit: accept, client: 'Claude Code' });
  const b = await server(w, { elicit: accept, client: 'Cursor' });
  await status(a);
  await status(b);
  w.fake.startInObs();
  await wait(500);
  assert.equal(readdirSync(w.dir).filter((f) => /\.owner-\d+$/.test(f)).length, 1);
  assert.equal(readdirSync(w.dir).filter((f) => f.endsWith('.jsonl')).length, 1);
  // The process that made the owner file first owns the take; the other gets X16 with no prompt.
  const ownerName = new Journal(w.dir, 'x').owner(take(w).id).client;
  const [owner, other] = ownerName === 'Claude Code' ? [a, b] : [b, a];
  assert.equal((await other.call('obs_record_stop')).text.split('\n').at(-1), TEXT.X16(ownerName, true));
  assert.deepEqual(other.prompts, []);
  assert.match((await owner.call('obs_record_stop')).text.split('\n').at(-1), /^The recording stopped at /);
  assert.deepEqual(recordRequests(w.fake), ['StopRecord']);
  await done(w, a, b);
});

test('E26: the server restarts while a prompt is open: the late answer to the new process stops nothing (X17)', async () => {
  const w = await world({ recording: true, elapsedMs: 3000 });
  const s = await server(w, { era: 'modern', elicit: accept, manual: true });
  const first = await s.client.callTool({ name: 'obs_record_stop', arguments: {} }, { allowInputRequired: true });
  assert.equal(first.resultType, 'input_required');
  await s.kill();
  await wait(700);
  const s2 = await server(w, { era: 'modern', elicit: accept, manual: true });
  const r = await s2.call('obs_record_stop', {}, { inputResponses: { confirm: { action: 'accept', content: {} } }, requestState: first.requestState });
  assert.match(r.text.split('\n').at(-1), /^That confirm expired after 2 minutes, so I did not stop the recording\. It still records \(/);
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, s2);
});

test('E27, F-T7-22: an external take with no obs_preflight names no expected sources and points to obs_preflight of a later version', () => {
  const r = { at: Date.now(), duration: 1000, path: 'rec/a.mov' };
  assert.match(TEXT.X15(r, []), /I check the file when it ends\. No expected sources\. To name them, run obs_preflight \(in a later version\)\.$/);
  assert.match(TEXT.X15(r, ['Mic', 'Guest audio']), /I watch `Mic` and `Guest audio`, and I check the file when it ends\.$/);
});
