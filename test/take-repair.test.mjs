// T7 repair round 1: one test for each finding F-T7-2 to F-T7-26 of the reviews and QA of PR 9 (F-T7-1 is in
// traces.test.mjs). SIMULATED: fake OBS only, with the scaled limits of test/take-app.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../dist/journal.js';
import { audioTools } from '../dist/platform.js';
import { clock, fileName, journalReading, newTake, stateLine, step, TEXT } from '../dist/take.js';
import { startFakeObs } from './fake-obs.mjs';
import { SKIP } from './fixtures.mjs';
import { accept, decline } from './mcp-pair.mjs';
import { FAST, recordRequests, server, until, wait, world } from './take-app.mjs';

const status = async (s) => (await s.call('obs_take_status')).text;
const last = (text) => text.split('\n').at(-1);
const takeOf = (w) => {
  const j = new Journal(w.dir, 'x');
  const id = readdirSync(w.dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(5, -6))[0];
  return { id, ...j.load(id), recs: j.read(id) };
};
const owners = (w) => readdirSync(w.dir).filter((f) => /\.owner-\d+$/.test(f)).sort();
const done = async (w, ...servers) => {
  for (const s of servers) await s.kill();
  await w.fake.close();
};
/** SIMULATED: the fake writes no file, so ffmpeg makes a 3 s file with sound on track 1 at the path of the take. */
const media = (path) => {
  const lavfi = (spec) => ['-f', 'lavfi', '-i', spec];
  execFileSync(audioTools().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...lavfi('testsrc=size=64x64:rate=2:d=3'), ...lavfi('aevalsrc=0.3*sin(440*2*PI*t):s=48000:d=3'), '-map', '0', '-map', '1', '-c:v', 'mpeg4', '-c:a', 'aac', path]);
};
/** A take that a dead process of client left in the journal; no beat file, so its owner file gives the age. */
function deadTake(w, state, { client = 'Claude Code', ageMs = 60000, kind = 'normal' } = {}) {
  const j = new Journal(w.dir, client);
  j.own('t1', 1);
  j.append('t1', { t: 'open', v: 1, id: 't1', kind, client, pid: 1 });
  const path = w.fake.path();
  j.state('t1', { ...newTake('t1', kind, state), intentAt: Date.now() - 4000, startedAt: Date.now() - 3000, startBytes: 0, paths: path ? [path] : [] });
  const old = new Date(Date.now() - ageMs);
  utimesSync(join(w.dir, 'take-t1.owner-1'), old, old);
}

test('F-T7-5, F-T7-8: after 200 file splits the state line stays short, a consented stop goes out once, and the status is true', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'split-token-1' });
  const conn = s.app.obs.connection;
  const dir = `/Volumes/Media/Recordings/${'Interview series '.repeat(4)}`;
  for (let i = 1; i <= 200; i++) s.app.obs.emit({ type: 'RecordFileChanged', data: { newOutputPath: `${dir}/2026-11-03 15-30-50 part ${String(i).padStart(3, '0')}.mov` }, conn });
  assert.match((await s.call('obs_record_stop')).text, /^The recording stopped at \d\d:\d\d:\d\d \(OBS confirmed it\)\. I am checking the file 2026-11-03 15-30-50 part 200\.mov\.$/);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  const lines = readFileSync(join(w.dir, `take-${takeOf(w).id}.jsonl`), 'utf8').trim().split('\n');
  assert.ok(Math.max(...lines.map((l) => Buffer.byteLength(l))) < 4096);
  assert.deepEqual(takeOf(w).take.paths.map((p) => basename(p)), [basename(w.fake.path()), '2026-11-03 15-30-50 part 200.mov'], 'the start path and the newest one');
  await done(w, s);
});

test('F-T7-4, F-T7-10: the owner beats in starting and start_uncertain, so a new process of the same client does not take over a live take', async () => {
  const w = await world({ silentOn: ['StartRecord'] });
  const a = await server(w, { elicit: accept });
  const started = a.call('obs_record_start', { token: 'beat-token-1' });
  await wait(900); // starting, past the stale limit (600 ms scaled)
  const b = await server(w, { elicit: accept });
  await status(b);
  assert.deepEqual(owners(w).map((f) => f.replace(/^take-\w+\./, '')), ['owner-1'], 'no takeover in starting');
  assert.match(last((await started).text), /^I sent the start at .*, but OBS did not confirm it in 5 s\./);
  await wait(700); // start_uncertain, past the stale limit again
  await status(b);
  assert.deepEqual(owners(w).map((f) => f.replace(/^take-\w+\./, '')), ['owner-1'], 'no takeover in start_uncertain');
  assert.match(last((await b.call('obs_record_stop')).text), /^I did not stop the recording\. Claude Code started it/);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, a, b);
});

test('F-T7-2, F-T7-9: the open take of a dead process of another client, which OBS no longer records, blocks no start and gives no false text', async () => {
  const w = await world();
  const a = await server(w, { elicit: accept, client: 'Claude Desktop' });
  await a.call('obs_record_start', { token: 'orphan-token-1' });
  await a.kill();
  w.fake.stopInObs();
  await wait(1300); // OBS stopped, and the beat of the dead owner is old (600 ms scaled)
  const b = await server(w, { elicit: accept, client: 'Cursor' });
  assert.equal(await status(b), 'OBS is not recording.');
  assert.equal((await b.call('obs_record_stop')).text, 'OBS is not recording.');
  assert.match((await b.call('obs_record_start', { token: 'orphan-token-2' })).text, /^Recording for 00:00:0\d \(OBS confirmed it\)\./);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StartRecord']);
  await done(w, b);
});

test('F-T7-2: a dead owner of another client whose recording still runs keeps its take: X16 names that client', async () => {
  const w = await world();
  const a = await server(w, { elicit: accept, client: 'Claude Desktop' });
  await a.call('obs_record_start', { token: 'orphan-token-3' });
  await a.kill();
  await wait(800);
  const b = await server(w, { elicit: accept, client: 'Cursor' });
  assert.equal((await b.call('obs_record_stop')).text, TEXT.X16('Claude Desktop'));
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, b);
});

test('F-T7-11, F-T7-13, F-T7-24: two processes accept a start at the same moment: one StartRecord, and the other gets a true text', async () => {
  for (let round = 0; round < 5; round++) {
    const w = await world();
    const a = await server(w, { era: 'modern', elicit: accept, manual: true, client: 'Claude Code' });
    const b = await server(w, { era: 'modern', elicit: accept, manual: true, client: 'Cursor' });
    const ask = (s, token) => s.client.callTool({ name: 'obs_record_start', arguments: { token } }, { allowInputRequired: true });
    const answer = (first) => ({ inputResponses: { confirm: { action: 'accept', content: {} } }, requestState: first.requestState });
    const [fa, fb] = [await ask(a, `race-a-${round}`), await ask(b, `race-b-${round}`)];
    const replies = await Promise.all([a.call('obs_record_start', { token: `race-a-${round}` }, answer(fa)), b.call('obs_record_start', { token: `race-b-${round}` }, answer(fb))]);
    assert.deepEqual(recordRequests(w.fake), ['StartRecord'], `round ${round}`);
    const texts = replies.map((r) => last(r.text)).sort();
    assert.equal(texts.filter((t) => /^Recording for /.test(t)).length, 1, texts.join('\n'));
    const loser = texts.find((t) => !/^Recording for /.test(t));
    assert.ok([TEXT.X7b].includes(loser) || /I did not send a start\./.test(loser), loser);
    await done(w, a, b);
  }
});

test('F-T7-24: a start claim that another process just made: X7b, and no StartRecord', async () => {
  const w = await world();
  new Journal(w.dir, 'Cursor').claim('other-take', () => false); // the other process claimed, and writes its take now
  const s = await server(w, { elicit: accept });
  assert.equal((await s.call('obs_record_start', { token: 'claim-token-1' })).text, 'Another obs-mcp process is starting a recording now. I did not send a start. Ask again in a few seconds.');
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, s);
});

test('F-T7-7, F-T7-18: the server start prunes closed takes past 30 days and old claims, before any take closes', async () => {
  const w = await world();
  const j = new Journal(w.dir, 'Seeder');
  const old = Date.now() - 40 * 864e5;
  j.own('old1', 1);
  j.append('old1', { t: 'open', v: 1, id: 'old1', kind: 'normal', client: 'Seeder', pid: 1 });
  j.state('old1', { ...newTake('old1', 'normal', 'closed'), result: 'verified' }, old);
  j.claim('old1', () => false);
  j.claim('new1', () => false);
  utimesSync(join(w.dir, 'start-1.claim'), new Date(old), new Date(old));
  const s = await server(w, { elicit: accept });
  assert.deepEqual(readdirSync(w.dir).sort(), ['start-2.claim']);
  await done(w, s);
});

test('F-T7-12, F-T7-26: file, source and client names show no control or bidi character, no Markdown mark, and at most 120 characters', () => {
  assert.equal(fileName('rec/a\u202Eb[c](d)<e>`f`.mov'), 'a\\u{202E}b\\[c\\](d)\\<e\\>\\`f\\`.mov');
  const long = fileName(`rec/${'x'.repeat(300)}.mov`);
  assert.equal([...long].length, 120);
  assert.match(long, /^x{80}…x{35}\.mov$/);
  const evil = `rec/a\u202E\u2066\nb[l](https://x.example/y)<img src=x>\`c\`${'z'.repeat(300)}.mov`;
  const r = { at: Date.now(), conn: 1, ev: 0, active: true, paused: false, duration: 1000, bytes: 1, path: evil };
  const t = { ...newTake('t', 'normal', 'recording'), paths: [evil], endedAt: Date.now() };
  const texts = [
    TEXT.W1('Scene [x](https://e)\u202E', ['Mic\u2066 (track 1)'], '/Movies/<b>'), TEXT.W3(r), TEXT.W4(r), TEXT.W5(r), TEXT.W6(r), TEXT.X6(r), TEXT.X11(t),
    TEXT.X15(r, ['Mic [x](https://e)', 'Guest\u202E']), TEXT.X16('Client\u202E [x](https://e)'), TEXT.X16('Client <b>', true), TEXT.X18(r), stateLine(t, r, Date.now()),
  ];
  for (const text of texts) {
    assert.doesNotMatch(text, /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/, text);
    assert.doesNotMatch(text, /(^|[^\\])[[\]<>`]/, text);
    assert.ok(!text.includes('z'.repeat(121)), 'a long name is cut');
  }
});

test('F-T7-3: a take of a dead process waits while OBS is unreachable at the server start, and its restart row runs when OBS answers', async () => {
  const w = await world();
  deadTake(w, 'recording');
  const port = w.fake.port;
  await w.fake.close();
  const s = await server(w, { elicit: accept });
  await status(s); // OBS closed: the takeover is done, and R5 waits for a read
  assert.equal(takeOf(w).take.state, 'recording');
  w.fake = await startFakeObs({ port, recordDirectory: w.rec });
  assert.ok(await until(() => takeOf(w).recs.some((r) => r.row === 'R5'), 3000), 'R5 runs when OBS answers');
  assert.ok(await until(() => s.logs.some((l) => l.level === 'error' && /^The recording stopped at about \d\d:\d\d, and nobody asked for it\./.test(l.data))));
  assert.ok(await until(async () => /^Take closed: not_checked\./.test(await status(s))));
  assert.match(last((await s.call('obs_record_start', { token: 'after-token-1' })).text), /^Recording for /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('F-T7-6: the journal keeps outputBytes before the take, the baseline of check 2 after a restart', async () => {
  const w = await world();
  w.fake.startInObs();
  await wait(300);
  w.fake.stopInObs();
  await wait(1200); // an earlier recording raised the byte count
  const s = await server(w, { elicit: accept });
  const before = (await s.app.takes.read()).bytes;
  assert.ok(before > 0);
  await s.call('obs_record_start', { token: 'bytes-token-1' });
  const t = takeOf(w).take;
  assert.equal(t.startBytes, before);
  assert.equal(journalReading(t).bytes, before);
  await done(w, s);
});

test('F-T7-14: the recording changes while you decide (stop and start in OBS): W6 for the new recording, and an accept stops it', async () => {
  const w = await world();
  let n = 0;
  const s = await server(w, {
    elicit: async () => {
      if (++n === 2) {
        w.fake.stopInObs();
        await wait(1200);
        w.fake.startInObs();
        await wait(300);
      }
      return { action: 'accept', content: {} };
    },
  });
  await s.call('obs_record_start', { token: 'changed-token-1' });
  const r = await s.call('obs_record_stop');
  assert.match(s.prompts[2] ?? '', /^The recording changed while you decided, so I did not stop it\. Now OBS shows: running 00:00:0\d, file .* 2\.mov\. This is not the recording you saw\. Stop this recording\? Accept to stop\. Decline to keep recording\.$/);
  assert.match(last(r.text), /^The recording stopped at \d\d:\d\d:\d\d \(OBS confirmed it\)\. I am checking the file .* 2\.mov\.$/);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  assert.equal(w.fake.state.recording, false);
  await done(w, s);
});

test('F-T7-15: X6 says that obs-mcp started the recording when it did; within 2 s of a stop, the text says what happened', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'x6-token-1' });
  const r = await s.app.takes.read();
  assert.equal(last((await s.call('obs_record_start', { token: 'x6-token-2' })).text), `OBS already records (started ${clock(r.at - r.duration)}, file ${basename(w.fake.path())}). I did not send a start. obs-mcp started this recording.`);
  await s.call('obs_record_stop');
  assert.ok(await until(async () => /^Take closed/.test(await status(s)), 1500));
  assert.equal(last((await s.call('obs_record_start', { token: 'x6-token-3' })).text), 'OBS started or stopped a recording in the last 2 s. I did not send a start. Ask again in a few seconds.');
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, s);
});

test('F-T7-16: X10 names the time of the drop, also in a later reply', async () => {
  const at = Date.UTC(2026, 10, 3, 14, 20, 1);
  const t = step({ ...newTake('t', 'normal', 'recording'), paths: ['rec/a.mov'] }, { type: 'disconnect', at }).take;
  assert.equal(t.offlineAt, at);
  assert.match(stateLine(t, undefined, at + 65000), new RegExp(`^I lost the connection to OBS at ${clock(at)}\\. OBS keeps recording on its own\\.`));
  const again = step(t, { type: 'disconnect', at: at + 5000 }).take;
  assert.equal(again.offlineAt, at, 'a second drop keeps the first time');
  // Through the server: OBS goes away, and a reply 1 s later still names the time of the drop.
  const w = await world();
  const s = await server(w, { elicit: accept, limits: { ...FAST, goneMs: 10000 } });
  await s.call('obs_record_start', { token: 'drop-token-1' });
  await w.fake.close();
  assert.ok(await until(() => takeOf(w).take.marks.includes('offline')));
  const dropAt = takeOf(w).take.offlineAt;
  await wait(1100);
  assert.match(await status(s), new RegExp(`^I lost the connection to OBS at ${clock(dropAt)}\\.`));
  await s.kill();
});

test('F-T7-16: the offline mark ends at the reconnect, not at the next watch read', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept, limits: { ...FAST, beatMs: 5000 } });
  await s.call('obs_record_start', { token: 'drop-token-2' });
  w.fake.drop();
  assert.ok(await until(() => takeOf(w).take.marks.includes('offline')));
  assert.ok(await until(() => !takeOf(w).take.marks.includes('offline'), 1500), 'cleared within 1.5 s, while the watch reads each 5 s');
  await done(w, s);
});

test('F-T7-19: O3, W8, X18 and the R3 gap give the values of now', async () => {
  // O3: the same token later gives the time now.
  let w = await world();
  let s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'fresh-token-1' });
  await wait(1200);
  assert.match((await s.call('obs_record_start', { token: 'fresh-token-1' })).text, /^Recording for 00:00:01 /);
  await done(w, s);

  // W8: the reminder reads OBS, while the watch reads only each 5 s.
  w = await world();
  s = await server(w, { elicit: accept, limits: { ...FAST, beatMs: 5000, reminderFirstMs: 2200, reminderMs: 60000 } });
  await s.call('obs_record_start', { token: 'fresh-token-2', test: true });
  assert.ok(await until(() => s.logs.some((l) => /^A test recording still runs/.test(l.data)), 4000));
  assert.match(s.logs.find((l) => /^A test recording still runs/.test(l.data)).data, /^A test recording still runs \(00:00:02\)\./);
  await done(w, s);

  // X18 after an event: the file of the recording that started.
  w = await world({ silentOn: ['StartRecord'] });
  s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'fresh-token-3' });
  assert.match((await s.call('obs_record_stop')).text, /^OBS has not started the recording\. I hold your stop for 30 s\./);
  w.fake.startInObs();
  assert.ok(await until(() => s.logs.some((l) => /^A recording started in OBS after you asked me to stop/.test(l.data))));
  const x18 = s.logs.find((l) => /^A recording started/.test(l.data)).data;
  assert.ok(x18.includes(`, file ${basename(w.fake.path())}). I did not stop it.`), x18);
  await done(w, s);

  // R3: with no beat file, the gap starts at the old owner file, not at the takeover.
  w = await world({ recording: true, elapsedMs: 3000 });
  deadTake(w, 'recording', { ageMs: 60000 });
  const from = clock(statSync(join(w.dir, 'take-t1.owner-1')).mtimeMs);
  s = await server(w, { elicit: accept });
  assert.match(await status(s), new RegExp(`^OBS still records the take that I started \\(00:00:0\\d, file .*\\)\\. The watch had a gap from ${from} to \\d\\d:\\d\\d:\\d\\d\\.`));
  await done(w, s);
});

test('F-T7-20: X16 for an external take says that it started outside obs-mcp, and the stop tool says who can stop it', async () => {
  assert.equal(TEXT.X16('Claude Code', true), 'I did not stop the recording. It started outside obs-mcp. Claude Code follows it, and in this version only that client can stop it. Ask there, or click Stop Recording in the Controls dock of OBS.');
  assert.equal(TEXT.X16('Claude Code'), 'I did not stop the recording. Claude Code started it, and in this version only that client can stop it. Ask there, or click Stop Recording in the Controls dock of OBS.');
  const w = await world();
  const s = await server(w);
  const { tools } = await s.client.listTools();
  assert.equal(tools.find((t) => t.name === 'obs_record_stop').description, 'Stop the OBS recording after the user confirms in a dialog. Only the client that started it, or first saw it, can stop it. Then the file check runs.');
  await done(w, s);
});

test('F-T7-23: a decline on a paused take says that it is still paused', async () => {
  const w = await world();
  let n = 0;
  const s = await server(w, { elicit: async () => (++n === 1 ? accept() : decline()) });
  await s.call('obs_record_start', { token: 'paused-token-1' });
  w.fake.pauseInObs();
  await wait(50);
  assert.match((await s.call('obs_record_stop')).text, /^You declined\. I did not stop the recording\. It is still paused \(00:00:0\d\)\.$/);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('F-T7-25: the closed line gives the length of the file and the expected sources with sound, and no folder path', { skip: SKIP }, async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  s.app.takes.lastSources = [{ name: 'Mic', kind: 'any', track: 1 }];
  await s.call('obs_record_start', { token: 'summary-token-1' });
  media(w.fake.path());
  await s.call('obs_record_stop');
  assert.ok(await until(async () => /^Take closed/.test(await status(s)), 15000));
  assert.match(await status(s), /^Take closed: verified(_with_warnings)?\. 00:00:03, 1 of 1 expected sources had sound in the file\.$/);
  assert.equal((await status(s)).includes(w.rec), false);
  await done(w, s);
});

test('F-T7-25: with no expected sources, the closed line counts the file checks', { skip: SKIP }, async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'summary-token-2' });
  media(w.fake.path());
  await s.call('obs_record_stop');
  assert.ok(await until(async () => /^Take closed/.test(await status(s)), 15000));
  assert.match(await status(s), /^Take closed: verified(_with_warnings)?\. 00:00:03, \d of \d file checks passed\. No expected sources were named\.$/);
  await done(w, s);
});
