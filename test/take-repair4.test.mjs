// T7 repair round 4: one test for each finding F-T7-54 to F-T7-67 of the round 3 re-checks of PR 9, with the one
// controller rule (G32). F-T7-54 and F-T7-61 are in journal.test.mjs, F-T7-58 and F-T7-63 in control.test.mjs, F-T7-64
// and F-T7-57 in traces.test.mjs, F-T7-55 also in take-tools.test.mjs (F9). SIMULATED: fake OBS only, with the scaled
// limits of test/take-app.mjs.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../dist/journal.js';
import { clock, newTake, stateLine, step, TEXT } from '../dist/take.js';
import { accept } from './mcp-pair.mjs';
import { FAST, recordRequests, server, until, wait, world } from './take-app.mjs';

const status = async (s) => (await s.call('obs_take_status')).text;
const last = (text) => text.split('\n').at(-1);
const logs = (s) => s.logs.map((l) => l.data).join('\n');
const done = async (w, ...servers) => {
  for (const s of servers) await s.kill();
  await w.fake.close();
};
const takes = (w) => {
  const j = new Journal(w.dir);
  return (existsSync(w.dir) ? readdirSync(w.dir) : []).filter((f) => f.endsWith('.jsonl')).map((f) => j.load(f.slice(5, -6)).take);
};
const R = (o = {}) => ({ at: Date.UTC(2026, 10, 3, 14, 30, 0), conn: 1, ev: 0, active: true, paused: false, duration: 60000, bytes: 9, path: 'rec/a.mov', ...o });

test('F-T7-59: a drop longer than the gone limit loses the take, and the reconnect re-attaches it to the same recording (R3); a stop then sends once', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'gone-token-1' });
  w.fake.down(FAST.goneMs + 800);
  assert.ok(await until(() => /I do not know the state of the recording now/.test(logs(s)), FAST.goneMs + 600), 'X11 at the gone limit (F-T7-78)');
  assert.ok(takes(w)[0].marks.includes('lost'));
  assert.ok(await until(() => /OBS still records the take that I started/.test(logs(s)), 3000), 'R3 at the reconnect');
  assert.deepEqual([takes(w)[0].state, takes(w)[0].row, takes(w)[0].marks], ['recording', 'R3', []]);
  assert.match(last(await status(s)), /^Recording for /);
  assert.match(last((await s.call('obs_record_stop')).text), /^The recording stopped at /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, s);
});

test('F-T7-59: after the gone limit, a reconnect to another recording does not re-attach the lost take', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'gone-token-2' });
  const first = w.fake.path();
  w.fake.down(FAST.goneMs + 800);
  w.fake.stopInObs();
  await wait(400);
  w.fake.startInObs();
  assert.ok(await until(() => takes(w).length === 2, FAST.goneMs + 3000), 'the new recording gets its own take');
  const [old, now] = [takes(w).find((t) => t.paths[0] === first), takes(w).find((t) => t.paths[0] !== first)];
  assert.equal(old.marks.includes('lost'), true);
  assert.notEqual(old.state, 'recording');
  assert.deepEqual([now.kind, now.state], ['external', 'external']);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('F-T7-65: an external take does not follow a new recording after a reconnect: T24, and the new recording gets its own take', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await status(s);
  w.fake.startInObs();
  assert.ok(await until(() => takes(w).length === 1));
  await wait(200);
  const first = w.fake.path();
  w.fake.down(900); // the new recording runs before the reconnect (STOPPED at 235 ms, STARTED at 272 ms after the click)
  w.fake.stopInObs();
  await wait(300);
  w.fake.startInObs();
  assert.ok(await until(() => takes(w).length === 2, 3000), 'a new take for the new recording');
  const old = takes(w).find((t) => t.paths[0] === first);
  assert.deepEqual([old.state, old.row, old.result], ['closed', 'T24', 'not_checked']);
  const now = takes(w).find((t) => t !== old && t.paths[0] !== first);
  assert.deepEqual([now.kind, now.state, basename(now.paths[0])], ['external', 'external', basename(w.fake.path())]);
  assert.match(last(await status(s)), new RegExp(`^OBS is recording \\(.*file \`${basename(w.fake.path())}\``));
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, s);
});

test('F-T7-60: a stop accept that returns before its stop (O7) spends its consent: no false X5 later', async () => {
  const w = await world();
  const s = await server(w, { era: 'modern', elicit: accept, manual: true });
  const first = await s.client.callTool({ name: 'obs_record_start', arguments: { token: 'spend-token-1' } }, { allowInputRequired: true });
  await s.call('obs_record_start', { token: 'spend-token-1' }, { inputResponses: { confirm: { action: 'accept', content: {} } }, requestState: first.requestState });
  const ask = () => s.client.callTool({ name: 'obs_record_stop', arguments: {} }, { allowInputRequired: true });
  const [p1, p2] = [await ask(), await ask()];
  const answer = (p) => s.call('obs_record_stop', {}, { inputResponses: { confirm: { action: 'accept', content: {} } }, requestState: p.requestState });
  const replies = await Promise.all([answer(p1), answer(p2)]);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  assert.equal(replies.filter((r) => /^The recording stopped at /.test(last(r.text))).length, 1, replies.map((r) => r.text).join('\n'));
  await wait(FAST.consentMs + 500);
  assert.doesNotMatch(logs(s), /No answer in 2 minutes/, 'both answers came: no X5');
  await done(w, s);
});

test('F-T7-62: a new recording on the path of a closed take gets its own take, and the tools say that OBS records', async () => {
  const w = await world({ fileName: 'interview.mov' });
  const s = await server(w, { elicit: accept });
  await status(s);
  w.fake.startInObs();
  assert.ok(await until(() => takes(w).length === 1));
  w.fake.stopInObs();
  assert.ok(await until(async () => /^Take closed/.test(last(await status(s)))));
  await wait(FAST.raceMs);
  w.fake.startInObs();
  // A read in the moment before OBS has the new output active gives no path; the next watch read adds it.
  assert.ok(await until(() => takes(w).filter((t) => t.state === 'external' && t.paths.length).length === 1), JSON.stringify(takes(w)));
  assert.deepEqual(takes(w).map((t) => t.paths[0] && basename(t.paths[0])), ['interview.mov', 'interview.mov'], JSON.stringify(takes(w)));
  assert.match(last(await status(s)), /^OBS is recording \(.*file `interview\.mov`\)/);
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, s);
});

test('F-T7-55: a recording that changes again after the W6 prompt gets X19, after 2 stop prompts', async () => {
  const w = await world();
  const change = async () => {
    w.fake.stopInObs();
    await wait(400);
    w.fake.startInObs();
    await wait(500);
  };
  const s = await server(w, { elicit: async (_m, n) => (n > 1 && (await change()), { action: 'accept', content: {} }) });
  await s.call('obs_record_start', { token: 'change-token-1' });
  const r = await s.call('obs_record_stop');
  assert.equal(last(r.text), TEXT.X19);
  assert.equal(s.prompts.length, 3, 'the start, the stop and one W6');
  assert.match(s.prompts[2], /^The recording changed while you decided/);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  await done(w, s);
});

test('F-T7-67: X10 and X14 do not say that OBS records when no take records; a drop right after the start is X10c', () => {
  const at = Date.UTC(2026, 10, 3, 14, 20, 1);
  const held = step({ ...newTake('t', 'normal', 'stop_held') }, { type: 'disconnect', at }).take;
  assert.equal(stateLine(held, undefined, at).startsWith(`I lost the connection to OBS at ${clock(at)}. I reconnect, and I send no recording request. OBS has not started`), true, stateLine(held, undefined, at));
  const rec = step({ ...newTake('t', 'normal', 'recording'), paths: ['rec/a.mov'] }, { type: 'disconnect', at }).take;
  assert.match(stateLine(rec, undefined, at), /^I lost the connection to OBS at \d\d:\d\d:\d\d\. OBS keeps recording on its own\./);
  const started = step({ ...newTake('t', 'normal', 'starting'), intentAt: at }, { type: 'disconnect', at: at + 20 }).take;
  assert.equal(stateLine(started, undefined, at + 9000), TEXT.X10c);
  assert.equal(TEXT.X14('recording'), 'obs-mcp is closing. OBS keeps recording. I did not stop it.');
  assert.equal(TEXT.X14(undefined), 'obs-mcp is closing. I did not send a stop.');
});

test('F-T7-67: X11 gives the last time that OBS surely recorded, not the time of the read', () => {
  const t = { ...newTake('t', 'normal', 'recording'), paths: ['rec/a.mov'], startedAt: R().at - 600000 };
  const read = step(t, { type: 'read', reading: R({ active: false, at: R().at + 4 * 3600e3 }), prevAt: R().at }).take;
  assert.equal(read.endedAt, R().at);
  assert.match(TEXT.X11(read), new RegExp(`^The recording stopped at about ${clock(R().at).slice(0, 5)}, and nobody asked for it\\.`));
  const off = step(t, { type: 'disconnect', at: R().at }).take;
  assert.equal(step(off, { type: 'timeout', phase: 'gone', at: R().at + 60000 }).take.endedAt, R().at, 'the drop, not the gone limit');
  const r5 = step(t, { type: 'restart', reading: R({ active: false }), same: false, at: R().at }).take;
  assert.match(TEXT.X11(r5), /^The recording stopped while I did not watch it, and nobody asked for it\./);
});

test('F-T7-67: X6 says paused for a paused recording; X17 asks again only while OBS records; X13 is gone', () => {
  assert.equal(TEXT.X6(R({ paused: true })), 'OBS already has a paused recording (paused at 00:01:00, file `a.mov`). I did not send a start. obs-mcp did not start this recording.');
  assert.match(TEXT.X6(R()), /^OBS already records \(started \d\d:\d\d:\d\d, file `a\.mov`\)\./);
  assert.equal(TEXT.X17(R({ active: false })), 'That confirm expired after 2 minutes, so I did not stop the recording. OBS shows no recording now.');
  assert.equal(TEXT.X17(R()), 'That confirm expired after 2 minutes, so I did not stop the recording. It still records (00:01:00). Ask me again to stop it.');
  assert.equal('X13' in TEXT, false);
});

test('F-T7-67: obs_read and obs_status give the waiting notices first', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  await status(s);
  w.fake.startInObs();
  assert.ok(await until(() => /^OBS started a recording/.test(logs(s))));
  const r = await s.client.callTool({ name: 'obs_read', arguments: { request: 'GetVersion' } });
  assert.match(r.content[0].text, /^OBS started a recording at \d\d:\d\d:\d\d \(file `[^`]+`\)\. obs-mcp did not start it/);
  assert.equal(JSON.parse(r.content[1].text).request, 'GetVersion');
  const again = await s.client.callTool({ name: 'obs_status', arguments: {} });
  assert.equal(again.content.length, 1, 'a notice shows once');
  await done(w, s);
});

test('F-T7-66, G32: a client that restarts controls again at once: no X16 for its own take', async () => {
  const w = await world();
  const a = await server(w, { elicit: accept });
  await a.call('obs_record_start', { token: 'own-restart-1' });
  await a.kill();
  const b = await server(w, { elicit: accept });
  const stop = await b.call('obs_record_stop');
  assert.doesNotMatch(stop.text, /Another obs-mcp copy/);
  assert.match(last(stop.text), /^The recording stopped at /);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, b);
});
