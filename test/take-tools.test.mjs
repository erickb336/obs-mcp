// T7 unit 6: the take tools, the notice channel, the owner rule and the restart rows R1 to R8, on the fake OBS.
// SIMULATED: no real OBS. Limits are scaled down (test/take-app.mjs).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Journal } from '../dist/journal.js';
import { newTake, TEXT } from '../dist/take.js';
import { connect, obsConfigDir, testEnv } from './helpers.mjs';
import { accept } from './mcp-pair.mjs';
import { recordRequests, server, until, wait, world } from './take-app.mjs';

const status = async (s) => (await s.call('obs_take_status')).text;

for (const era of ['legacy', 'modern']) {
  describe(`a full take on the ${era} era`, () => {
    test('start and stop with consent: one StartRecord, one StopRecord, each reply at the confirmed event, then the file check', async () => {
      const w = await world();
      const s = await server(w, { era, elicit: accept });
      const started = await s.call('obs_record_start', { token: 'take-token-1' });
      assert.match(started.text, /^Recording for 00:00:0\d \(OBS confirmed it\)\. File: \d{4}-\d\d-\d\d \d\d-\d\d-\d\d 1\.mov\.$/);
      assert.match(s.prompts[0], /^Start recording in OBS\? Scene: .*\. Expected sources: none\. To name them, run obs_preflight \(in a later version\)\. The file goes to .*\. Everyone in the recording should know about it and agree\. Accept to start\. Decline to cancel\.$/);
      assert.match(await status(s), /^Recording for /);
      const stopped = await s.call('obs_record_stop');
      assert.match(s.prompts[1], /^Stop the OBS recording\? It has run 00:00:0\d\. File: .* 1\.mov\. OBS then finishes the file\./);
      assert.match(stopped.text, /^The recording stopped at \d\d:\d\d:\d\d \(OBS confirmed it\)\. I am checking the file .* 1\.mov\.$/);
      assert.ok(await until(async () => /^Take closed: /.test(await status(s))));
      // The fake writes no media file, so the check cannot read one: not_checked, with the file name only (F-T7-25).
      assert.match(await status(s), /^Take closed: not_checked\. I could not check the file \d{4}-\d\d-\d\d \d\d-\d\d-\d\d 1\.mov\. obs_verify_file with this file name gives the reason\.$/);
      assert.equal((await status(s)).includes(w.rec), false, 'no folder path');
      assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
      await s.kill();
      await w.fake.close();
    });
  });
}

test('over stdio, from dist/cli.js: a start and a stop with consent, and the journal in OBS_MCP_STATE_DIR', async () => {
  const w = await world();
  const env = testEnv(obsConfigDir(null), w.fake.port, { OBS_MCP_STATE_DIR: w.dir, OBS_MCP_RECORDING_DIR: w.rec });
  const s = await connect(env, { elicit: accept });
  assert.match((await s.call('obs_record_start', { token: 'stdio-token-1' })).text, /^Recording for .* \(OBS confirmed it\)\./);
  assert.match((await s.call('obs_record_stop')).text, /^The recording stopped at .* \(OBS confirmed it\)\./);
  await s.close();
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  assert.equal(readdirSync(w.dir).filter((f) => f.endsWith('.jsonl')).length, 1);
  await w.fake.close();
});

test('O3: the same start token returns the take and sends nothing', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'take-token-1' });
  const again = await s.call('obs_record_start', { token: 'take-token-1' });
  assert.match(again.text, /^Recording for /);
  assert.equal(s.prompts.length, 1);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await s.kill();
  await w.fake.close();
});

test('G25, G26: a client with no elicitation gets X2 for a start and X1 for a stop, and nothing is sent', async () => {
  const w = await world({ recording: true });
  const s = await server(w);
  assert.equal((await s.call('obs_record_start', { token: 'take-token-1' })).text.split('\n').at(-1), TEXT.X2);
  assert.equal((await s.call('obs_record_stop')).text.split('\n').at(-1), TEXT.X1);
  assert.deepEqual(recordRequests(w.fake), []);
  await s.kill();
  await w.fake.close();
});

test('O6, G29: a stop from another client gets X16 with no prompt, and nothing is sent', async () => {
  const w = await world();
  const a = await server(w, { elicit: accept, client: 'Claude Code' });
  const b = await server(w, { elicit: accept, client: 'Cursor' });
  await a.call('obs_record_start', { token: 'take-token-1' });
  const r = await b.call('obs_record_stop');
  assert.equal(r.text.split('\n').at(-1), TEXT.X16('Claude Code'));
  assert.equal(b.prompts.length, 0);
  assert.match(await status(b), /^Recording for |^OBS is recording/);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await a.kill();
  await b.kill();
  await w.fake.close();
});

test('F2, O4, F-T7-21: a test take sends reminder W8 on the notice channel, and each tool reply holds it once; nothing stops it', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'test-token-1', test: true });
  assert.match(s.prompts[0], /^Start a test recording in OBS\?/);
  assert.ok(await until(() => s.logs.length >= 2, 2000), 'a reminder at 300 ms, then each 500 ms');
  assert.deepEqual(s.logs.slice(0, 2).map((l) => [l.level, l.data.slice(0, 31)]), [['warning', 'A test recording still runs (00'], ['warning', 'A test recording still runs (00']]);
  const w8 = (lines) => lines.filter((l) => /^A test recording still runs/.test(l)).length;
  const r = (await s.call('obs_take_status')).text.split('\n');
  assert.match(r[0], /^A test recording still runs/, 'the waiting notice comes first');
  assert.equal(w8(r), 1, `one reminder in the reply, after ${s.logs.length} notices:\n${r.join('\n')}`);
  assert.ok(r.some((l) => /This is a test recording\. obs-mcp does not stop it by itself\./.test(l)));
  const next = (await s.call('obs_take_status')).text.split('\n');
  assert.equal(w8(next), 1, 'a reply with no waiting notice repeats the reminder once');
  assert.match(next.at(-1), /^A test recording still runs/);
  await wait(400);
  assert.equal(w.fake.state.recording, true);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await s.kill();
  await w.fake.close();
});

test('F9: a full take with planted secrets leaves no planted secret in the journal, outside the path and name fields', async () => {
  const w = await world({ plant: true });
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'plant-token-1' });
  w.fake.pauseInObs();
  await wait(100);
  w.fake.resumeInObs();
  await wait(100);
  // With plant on, the path field of the file output has a planted key, so the same-recording test cannot pass
  // (check 3 fails to the safe side) and a stop request would only ask again. The take stops in OBS (T20).
  const asked = await s.call('obs_record_stop');
  assert.match(asked.text, /The recording changed while you decided, so I did not stop it\.|reached the maximum|rounds/i, asked.text);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  w.fake.stopInObs();
  await wait(400);
  await s.kill();
  // A restart, then the file check runs again (R8).
  const s2 = await server(w, { elicit: accept });
  await wait(700);
  await s2.call('obs_take_status');
  assert.ok(await until(async () => /^Take closed/.test(await status(s2))), await status(s2));
  const text = readdirSync(w.dir).map((f) => readFileSync(join(w.dir, f), 'utf8')).join('\n');
  const found = w.fake.planted.filter((p) => text.includes(p.secret));
  assert.ok(w.fake.planted.length > 10, `${w.fake.planted.length} secrets were on the wire`);
  assert.deepEqual(found.filter((p) => !['path', 'outputPath', 'inputName'].includes(p.field)), []);
  for (const banned of ['sample-stream-key', 'rtmp://', 'password']) assert.equal(text.includes(banned), false, banned);
  await s2.kill();
  await w.fake.close();
});

// ---- The restart rows. A journal from a process that died (its beat is old) and OBS in a given state.

async function journalOf(w, state, extra = {}) {
  const j = new Journal(w.dir, 'Claude Code');
  j.own('t1', 1);
  j.append('t1', { t: 'open', v: 1, id: 't1', kind: extra.kind ?? 'normal', client: 'Claude Code', pid: 1 });
  j.append('t1', { t: 'intent', what: 'start', at: Date.now() - 4000, token: 'ab' });
  const path = w.fake.path();
  j.state('t1', { ...newTake('t1', extra.kind ?? 'normal', state), intentAt: Date.now() - 4000, startedAt: Date.now() - 3000, startBytes: 0, paths: path ? [path] : [], ...extra });
  writeFileSync(join(w.dir, 'take-t1.beat'), JSON.stringify({ at: Date.now() - 60000 }));
}

const ROWS = [
  ['R1', 'starting', { recording: true, elapsedMs: 3000 }, /^OBS is recording \(00:00:0\d, file .*\), but obs-mcp did not start this recording\./],
  ['R2', 'start_uncertain', {}, /^Take closed: not_started\. OBS shows no recording, so the start did not happen\.$/],
  ['R3', 'recording', { recording: true, elapsedMs: 3000 }, /^Recording for 00:00:0\d \(OBS confirmed it\)\./],
  ['R4', 'paused', { recording: true, elapsedMs: 60000 }, /^OBS is recording/, 'the old take closes not_checked, and a new external take opens'],
  ['R5', 'recording', {}, /^The recording stopped at about \d\d:\d\d, and nobody asked for it\./],
  ['R6', 'stopping', { recording: true, elapsedMs: 3000 }, /^I sent the stop at .*, but OBS did not confirm it in 15 s\./],
  ['R7', 'external', { recording: true, elapsedMs: 3000 }, /^OBS is recording \(00:00:0\d/],
  ['R8', 'checking', {}, /^(OBS shows no recording now|Take closed)/],
];
describe('T7 unit 6: after a crash of the server, the restart rows R1 to R8 run, and no recording request goes out', () => {
  for (const [row, state, obs, want, note] of ROWS) {
    test(`${row}: journal ${state}, OBS ${obs.recording ? 'records' : 'idle'}${note ? `: ${note}` : ''}`, async () => {
      const w = await world(obs);
      await journalOf(w, state, state === 'external' ? { kind: 'external' } : state === 'stopping' ? { stopAt: Date.now() - 2000 } : {});
      const s = await server(w, { elicit: accept });
      const text = await status(s);
      assert.ok(text.split('\n').some((l) => want.test(l)), text);
      const j = new Journal(w.dir, 'x');
      assert.ok(j.read('t1').some((r) => r.t === 'state' && r.row === row), `the journal has row ${row}`);
      if (row === 'R4') assert.equal(j.load('t1').take.result, 'not_checked');
      assert.deepEqual(recordRequests(w.fake), []);
      await s.kill();
      await w.fake.close();
    });
  }
});

test('unit 6 (design test): OBS crashes on StartRecord after the intent; a restart reads the journal, ends the take not_started, and sends nothing', async () => {
  const w = await world({ crashOn: 'StartRecord' });
  const s = await server(w, { elicit: accept });
  const r = await s.call('obs_record_start', { token: 'crash-token-1' });
  assert.match(r.text, /^I lost the connection to OBS at .*I sent the start at .*, but OBS did not confirm it in 5 s\./);
  await s.kill();
  const j = new Journal(w.dir, 'x');
  const id = readdirSync(w.dir).find((f) => f.endsWith('.jsonl')).slice(5, -6);
  assert.deepEqual(j.read(id).filter((x) => ['intent', 'sent'].includes(x.t)).map((x) => x.t), ['intent', 'sent'], 'the intent is on disk before the send');
  await wait(700); // the beat of the dead process gets old (staleMs 600)
  w.fake.log.length = 0;
  const s2 = await server(w, { elicit: accept });
  assert.match(await status(s2), /^Take closed: not_started\./);
  assert.equal(j.load(id).take.row, 'R2');
  assert.deepEqual(recordRequests(w.fake), []);
  await s2.kill();
  await w.fake.close();
});
