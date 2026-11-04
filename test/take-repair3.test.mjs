// T7 repair round 3: one test for each finding F-T7-36 to F-T7-53 of the round 2 re-checks of PR 9, with the facts of
// the R210 probe of a real OBS 33.0.1 (the record output is simple_file_output of kind mov_output). SIMULATED: fake OBS
// only, with the scaled limits of test/take-app.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../dist/journal.js';
import { audioTools } from '../dist/platform.js';
import { newTake, TEST_MARK, TEXT } from '../dist/take.js';
import { closedPort } from './helpers.mjs';
import { SKIP } from './fixtures.mjs';
import { accept, after } from './mcp-pair.mjs';
import { FAST, recordRequests, server, tmp, until, wait, world } from './take-app.mjs';

const status = async (s) => (await s.call('obs_take_status')).text;
const last = (text) => text.split('\n').at(-1);
const done = async (w, ...servers) => {
  for (const s of servers) await s.kill();
  await w.fake.close();
};
const takeFile = (w) => join(w.dir, readdirSync(w.dir).find((f) => f.endsWith('.jsonl')));
const takeOf = (w) => {
  const j = new Journal(w.dir, 'x');
  const id = basename(takeFile(w)).slice(5, -6);
  return j.load(id).take;
};
const logs = (s) => s.logs.map((l) => l.data).join('\n');
const UNIX = process.platform !== 'win32' && process.getuid?.() !== 0;

// ---- F-T7-36, F-T7-44 (and the R210 facts): the record output of any kind

for (const kind of ['mov_output', 'mp4_output', 'ffmpeg_muxer']) {
  test(`F-T7-36, F-T7-44: an approved stop of a take on a ${kind} record output sends StopRecord exactly once`, async () => {
    const w = await world({ fileOutput: kind });
    const s = await server(w, { elicit: accept });
    assert.match(last((await s.call('obs_record_start', { token: `kind-token-${kind}` })).text), /^Recording for /);
    const file = basename(w.fake.path());
    const stop = await s.call('obs_record_stop');
    assert.match(s.prompts.at(-1), new RegExp(`File: \`${file.replace(/[.]/g, '\\.')}\``), 'the prompt names the file');
    assert.match(last(stop.text), /^The recording stopped at .* \(OBS confirmed it\)\./);
    assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
    assert.equal(s.prompts.filter((p) => /recording changed while you decided/.test(p)).length, 0, 'no W6');
    await done(w, s);
  });
}

test('R210: a PAUSED event with outputActive false keeps the take paused, not stopped', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'paused-event-1' });
  w.fake.pauseInObs();
  await wait(100);
  assert.match(last(await status(s)), /^The recording is paused at /);
  assert.equal(takeOf(w).state, 'paused');
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('R210: on a reconnect, a mov_output take stays attached, and a stop then sends StopRecord once', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'reconnect-mov-1' });
  w.fake.drop();
  await wait(400);
  assert.match(last(await status(s)), /^Recording for /);
  assert.equal(takeOf(w).state, 'recording', 'not closed by T24');
  assert.notEqual(takeOf(w).row, 'T24');
  assert.match(last((await s.call('obs_record_stop')).text), /^The recording stopped at /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, s);
});

test('R210: on a server restart, a mov_output take stays attached (R3), and a stop then sends StopRecord once', async () => {
  const w = await world();
  const a = await server(w, { elicit: accept });
  await a.call('obs_record_start', { token: 'restart-mov-1' });
  await a.kill();
  await wait(FAST.staleMs + 100);
  const b = await server(w, { elicit: accept });
  const text = await status(b);
  assert.match(text, /^OBS still records the take that I started/);
  assert.match(last(text), /^Recording for /);
  assert.deepEqual([takeOf(w).state, takeOf(w).row], ['recording', 'R3']);
  assert.match(last((await b.call('obs_record_stop')).text), /^The recording stopped at /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, b);
});

// ---- F-T7-37: the gone limit of a drop ends with the reconnect

test('F-T7-37: a second drop does not end the take at the gone limit of the first drop', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'two-drops-1' });
  const t0 = Date.now();
  w.fake.drop();
  await wait(250);
  assert.match(last(await status(s)), /^Recording for /, 'reconnected');
  await wait(t0 + 500 - Date.now());
  w.fake.down(700); // the old gone limit (goneMs after the first drop) falls in this second drop
  await wait(t0 + 1500 - Date.now());
  assert.equal(w.fake.state.recording, true);
  assert.equal(takeOf(w).marks.includes('lost'), false);
  assert.doesNotMatch(logs(s), /nobody asked for it/, 'no X11');
  assert.match(last(await status(s)), /^Recording for /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

// ---- F-T7-38, F-T7-41: a file error of the journal

test('F-T7-38: a journal write error does not leave the take in checking, and a later start works', { skip: !UNIX }, async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'readonly-1' });
  const file = takeFile(w);
  chmodSync(file, 0o444);
  w.fake.stopInObs();
  assert.ok(await until(async () => /^Take closed/.test(last(await status(s))), 5000), await status(s));
  assert.match(logs(s), /I could not write the take record on this computer \(EACCES\)\./);
  chmodSync(file, 0o600);
  await wait(FAST.raceMs + 100); // P14: no start in the 2 s after a record event
  assert.match(last((await s.call('obs_record_start', { token: 'readonly-2' })).text), /^Recording for /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StartRecord']);
  await done(w, s);
});

test('F-T7-41: a journal error on a stop gives its code only, no folder, and sends no StopRecord', { skip: !UNIX }, async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'readonly-stop-1' });
  chmodSync(takeFile(w), 0o444);
  const stop = await s.call('obs_record_stop');
  chmodSync(takeFile(w), 0o600);
  assert.equal(last(stop.text), 'I could not write the take record on this computer (EACCES). So I did not send the stop.');
  assert.equal(stop.text.includes(w.dir), false);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('F-T7-41: a journal error at a takeover gives its code only, no folder', { skip: !UNIX }, async () => {
  const w = await world();
  const a = await server(w, { elicit: accept });
  await a.call('obs_record_start', { token: 'readonly-resume-1' });
  await a.kill();
  await wait(FAST.staleMs + 100);
  chmodSync(w.dir, 0o500);
  const b = await server(w, { elicit: accept });
  const r = await b.call('obs_take_status');
  chmodSync(w.dir, 0o700);
  assert.match(r.text, /I could not write the take record on this computer \(EACCES\)\./);
  assert.equal(r.text.includes(w.dir) || logs(b).includes(w.dir), false);
  await done(w, b);
});

// ---- F-T7-39: the journal changes only its own files

test('F-T7-39: in a folder that holds other files, the journal keeps their mode and removes only its own old temp files', { skip: !UNIX }, () => {
  const dir = tmp('shared');
  chmodSync(dir, 0o755);
  const old = new Date(Date.now() - 40 * 864e5);
  for (const f of ['draft-notes.tmp', 'take-ab12.beat.123.tmp', 'start-1.claim.0a1b2c3d.tmp']) {
    writeFileSync(join(dir, f), 'x');
    utimesSync(join(dir, f), old, old);
  }
  const j = new Journal(dir, 'Claude Code');
  j.prune();
  assert.equal(j.claim('t1', () => false), true);
  assert.equal(statSync(dir).mode & 0o777, 0o755, 'the mode of a folder that was there stays');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), ['draft-notes.tmp']);
  const fresh = join(tmp('fresh'), 'takes');
  new Journal(fresh, 'Claude Code').claim('t1', () => false);
  assert.equal(statSync(fresh).mode & 0o777, 0o700, 'a folder that the journal makes is for this user only');
});

// ---- F-T7-40, F-T7-47: a long path from OBS

test('F-T7-40, F-T7-47: a path of almost 4,096 bytes fits the journal, and the stop sends StopRecord once', async () => {
  const w = await world();
  w.fake.options.recordDirectory = join(w.rec, ...Array.from({ length: 30 }, () => 'd'.repeat(130)));
  assert.ok(Buffer.byteLength(w.fake.options.recordDirectory) > 3900 && Buffer.byteLength(w.fake.options.recordDirectory) < 4060);
  const s = await server(w, { elicit: accept });
  assert.match(last((await s.call('obs_record_start', { token: 'long-path-1' })).text), /^Recording for /);
  assert.equal(takeOf(w).state, 'recording', 'the STARTED state line is on disk');
  const stop = await s.call('obs_record_stop');
  assert.match(last(stop.text), /^The recording stopped at /);
  assert.doesNotMatch(stop.text, /journal/);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, s);
});

test('F-T7-40, F-T7-47: a path over 4,096 bytes counts as no path, and no reply gives a journal error', async () => {
  const w = await world();
  w.fake.options.recordDirectory = join(w.rec, ...Array.from({ length: 40 }, () => 'd'.repeat(130)));
  const s = await server(w, { elicit: async (_m, n) => (n === 1 ? { action: 'accept', content: {} } : { action: 'decline' }) });
  assert.match(last((await s.call('obs_record_start', { token: 'long-path-2' })).text), /^Recording for .* File: `unknown`\.$/);
  assert.equal(takeOf(w).state, 'recording');
  const stop = await s.call('obs_record_stop');
  assert.doesNotMatch(stop.text, /journal/);
  assert.match(s.prompts[1], /File: `unknown`/);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord'], 'with no path, the same-recording test fails to the safe side');
  await done(w, s);
});

// ---- F-T7-42: a damaged state line

test('F-T7-42: a damaged state line is skipped: the last good line gives the take, and status and start work', async () => {
  const w = await world();
  mkdirSync(w.dir, { recursive: true });
  const j = new Journal(w.dir, 'Claude Code');
  j.own('t1', 1);
  j.append('t1', { t: 'open', v: 1, id: 't1', kind: 'normal', client: 'Claude Code', pid: 1 });
  j.state('t1', { ...newTake('t1', 'normal', 'closed'), result: 'not_checked', row: 'T24' });
  appendFileSync(join(w.dir, 'take-t1.jsonl'), `${JSON.stringify({ t: 'state', state: 'stop_held', marks: 5, paths: 7, k: 1 })}\n`);
  j.beat('t1');
  assert.deepEqual([j.load('t1').take.state, j.openTakes()], ['closed', []]);
  const s = await server(w, { elicit: accept });
  const r = await s.call('obs_take_status');
  assert.equal(r.isError, false);
  assert.match(last(r.text), /^Take closed: not_checked\./);
  assert.match(last((await s.call('obs_record_start', { token: 'damaged-1' })).text), /^Recording for /);
  await done(w, s);
});

// ---- F-T7-43, F-T7-45: a client restart

test('F-T7-43: a client that restarts before the old beat is stale takes the take over with no tool call', async () => {
  const w = await world();
  const a = await server(w, { elicit: accept });
  await a.call('obs_record_start', { token: 'quick-restart-1' });
  await a.kill();
  const b = await server(w, { elicit: accept }); // at once: the old beat is fresh
  assert.ok(await until(() => /OBS still records the take that I started/.test(logs(b)), FAST.staleMs * 4), 'the takeover ran with no tool call');
  w.fake.stopInObs();
  assert.ok(await until(() => /was stopped in OBS|nobody asked/.test(logs(b)) || takeOf(w).state !== 'recording', 3000));
  assert.notEqual(takeOf(w).state, 'recording', 'the new process watches the take');
  await done(w, b);
});

test('F-T7-45: the restart notice of a paused take says that it is paused, not that OBS records', async () => {
  const w = await world();
  const a = await server(w, { elicit: accept });
  await a.call('obs_record_start', { token: 'paused-restart-1' });
  w.fake.pauseInObs();
  await wait(100);
  await a.kill();
  await wait(FAST.staleMs + 100);
  const b = await server(w, { elicit: accept });
  const text = await status(b);
  assert.match(text, /^The take that I started is still paused in OBS \(00:00:0\d, file `[^`]+\.mov`\)\. The watch had a gap from /);
  assert.doesNotMatch(text, /still records/);
  await done(w, b);
});

// ---- F-T7-46: OBS unreachable

test('F-T7-46: obs_take_status with OBS unreachable says so, and does not say that OBS is not recording', async () => {
  const w = await world();
  await w.fake.close();
  const s = await server({ ...w, fake: { ...w.fake, port: await closedPort() } });
  const text = await status(s);
  assert.match(text, /^I cannot reach OBS, so I do not know if it records now\. /);
  assert.doesNotMatch(text, /OBS is not recording/);
  await s.kill();
});

// ---- F-T7-48: no elicitation while OBS records

test('F-T7-48: a client with no elicitation gets X6, not "click Start Recording", while OBS records', async () => {
  const w = await world();
  const s = await server(w);
  await status(s);
  w.fake.startInObs();
  await wait(400);
  const text = last((await s.call('obs_record_start', { token: 'no-elicit-1' })).text);
  assert.match(text, /^OBS already records \(started .*\)\. I did not send a start\. obs-mcp did not start this recording\.$/);
  assert.notEqual(text, TEXT.X2);
  assert.equal(last((await s.call('obs_record_start', { token: 'no-elicit-2' })).text).startsWith('OBS already records'), true);
  w.fake.stopInObs();
  await until(() => !w.fake.state.recording);
  await wait(2500);
  assert.equal(last((await s.call('obs_record_start', { token: 'no-elicit-3' })).text), TEXT.X2, 'idle: X2');
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, s);
});

// ---- F-T7-49: no answer on the legacy era

test('F-T7-49: an unanswered stop prompt on the legacy era gives X5, not an SDK error, and sends nothing', async () => {
  const w = await world();
  const s = await server(w, { elicit: async (_m, n) => (n === 1 ? { action: 'accept', content: {} } : after(FAST.consentMs + 1000, accept)()) });
  await s.call('obs_record_start', { token: 'legacy-expire-1' });
  const stop = await s.call('obs_record_stop');
  assert.equal(stop.isError, false);
  assert.match(stop.text, /^No answer in 2 minutes\. I did not stop the recording\. It still records \(00:00:0\d\)\.$/);
  await wait(1200);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  assert.doesNotMatch(await status(s), /No answer/, 'the notice came once');
  await done(w, s);
});

test('F-T7-49: an unanswered start prompt on the legacy era gives a plain text, and sends nothing', async () => {
  const w = await world();
  const s = await server(w, { elicit: after(FAST.consentMs + 1000, accept) });
  const start = await s.call('obs_record_start', { token: 'legacy-expire-2' });
  assert.deepEqual([start.text, start.isError], ['No answer in 2 minutes. I did not start a recording. Ask me again to start it.', false]);
  await wait(1200);
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, s);
});

// ---- F-T7-50: a start during stop_uncertain

test('F-T7-50: a start while a stop is not confirmed points to the stop in OBS (T18), not "ask again"', async () => {
  const w = await world({ silentOn: ['StopRecord'] });
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'stuck-stop-1' });
  await s.call('obs_record_stop');
  await wait(300);
  const prompts = s.prompts.length;
  const text = last((await s.call('obs_record_start', { token: 'stuck-stop-2' })).text);
  assert.match(text, /^OBS still records \(00:00:0\d\)\. I will not send a second stop\. In OBS, click Stop Recording in the Controls dock\. I did not send a start\.$/);
  assert.equal(s.prompts.length, prompts, 'no start prompt');
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, s);
});

// ---- F-T7-51: the old take of T24, T19 and R4

test('F-T7-51: T24 names the old file and says that it is not checked, before X15', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'old-file-1' });
  const old = basename(w.fake.path());
  w.fake.down(800); // shorter than goneMs
  w.fake.stopInObs();
  await wait(400);
  w.fake.startInObs();
  await wait(1200);
  const text = await status(s);
  const lines = text.split('\n');
  const closed = lines.findIndex((l) => l.startsWith('Take closed: not_checked. The take that I followed ended while I could not reach OBS'));
  assert.ok(closed >= 0, text);
  assert.ok(lines[closed].includes(`I did not check its file \`${old}\`. To check it, run obs_verify_file with this file name.`), lines[closed]);
  assert.ok(lines.findIndex((l) => l.startsWith('OBS started a recording')) > closed, 'X15 after the closed line');
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('F-T7-51: T19 and R4 say what happened to the stop and to the old file', async () => {
  const take = (row) => ({ ...newTake('t', 'normal', 'closed'), result: 'not_checked', row, stopAt: new Date(2026, 0, 1, 10, 0, 0).getTime(), paths: ['/rec/a.mov'] });
  const { stateLine } = await import('../dist/take.js');
  assert.equal(stateLine(take('T19'), undefined, 0), 'Take closed: not_checked. The recording that I stopped at 10:00:00 has ended, and OBS records a new one now. I sent the stop once. I did not check its file `a.mov`. To check it, run obs_verify_file with this file name.');
  assert.equal(stateLine(take('R4'), undefined, 0), 'Take closed: not_checked. The take that I followed ended while obs-mcp was not running, and OBS records a new one now. I did not check its file `a.mov`. To check it, run obs_verify_file with this file name.');
  assert.equal(stateLine({ ...take('R4'), paths: [] }, undefined, 0).endsWith('I do not know the name of its file, so I did not check it.'), true);
});

// ---- F-T7-52: the closed line of a warning or a failure

const media = (path, sound) => {
  const lavfi = (spec) => ['-f', 'lavfi', '-i', spec];
  execFileSync(audioTools().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...lavfi('testsrc=size=64x64:rate=2:d=3'), ...lavfi(`aevalsrc=${sound}*sin(440*2*PI*t):s=48000:d=3`), '-map', '0', '-map', '1', '-c:v', 'mpeg4', '-c:a', 'aac', path]);
};
const closedLine = async (make, sources = []) => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  s.app.takes.lastSources = sources;
  await s.call('obs_record_start', { token: `closed-line-${Math.random()}` });
  make(w.fake.path());
  await s.call('obs_record_stop');
  await until(async () => /^Take closed/.test(last(await status(s))), 15000);
  const line = last(await status(s));
  const name = basename(w.fake.path());
  await done(w, s);
  return { line, name };
};

test('F-T7-52: a failed file check names the failed check and the tool that gives the reason', { skip: SKIP }, async () => {
  const { line, name } = await closedLine((p) => writeFileSync(p, 'not a movie'));
  assert.equal(line, `Take closed: failed. 0 of 1 file checks passed. No expected sources were named. Failed: The file is readable and complete. For the reason and the timecodes, run obs_verify_file with the file name \`${name}\`.`);
});

test('F-T7-52: a missing expected source names its check, with the name as a code span', { skip: SKIP }, async () => {
  const { line, name } = await closedLine((p) => media(p, 0.3), [{ name: 'Mic "2"', kind: 'any', track: 2 }]);
  assert.match(line, /^Take closed: failed\. File length 00:00:03\. 0 of 1 expected sources had sound in the file\. Failed: Source `Mic "2"` \(any\) has sound on track 2\. For the reason/);
  assert.ok(line.endsWith(`run obs_verify_file with the file name \`${name}\`.`));
});

test('F-T7-52: a warning names the check with the warning', { skip: SKIP }, async () => {
  const { line } = await closedLine((p) => media(p, 0));
  assert.match(line, /^Take closed: (verified_with_warnings\. .* Warning: .+\. For the reason and the timecodes, run obs_verify_file with the file name `[^`]+`\.|failed\. .* Failed: .+)$/);
});

// ---- F-T7-53: W8 of a test take

test('F-T7-53: a test take says the test mark at the start, and W8 comes first only after the first reminder time', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  const start = (await s.call('obs_record_start', { token: 'w8-order-1', test: true })).text;
  assert.equal(start.includes('A test recording still runs'), false, 'no W8 at 0 s');
  assert.ok(start.endsWith(TEST_MARK), start);
  await wait(FAST.reminderFirstMs + 200);
  for (let i = 0; i < 3; i++) {
    const lines = (await status(s)).split('\n');
    assert.match(lines[0], /^A test recording still runs \(00:00:0\d\)\./, 'W8 first, each time');
    assert.equal(lines.filter((l) => l.startsWith('A test recording still runs')).length, 1);
    assert.match(lines[1], /^Recording for /);
    assert.equal(lines[1].includes(TEST_MARK), false);
  }
  await done(w, s);
});
