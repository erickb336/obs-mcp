// T7 repair round 2: one test for each finding F-T7-12 and F-T7-17 to F-T7-35 of the round 1 re-checks of PR 9.
// F-T7-34 is in take-repair.test.mjs (the closed-line tests need ffmpeg). SIMULATED: fake OBS only, with the scaled
// limits of test/take-app.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../dist/journal.js';
import { fileName, newTake, shown, stateLine, TEXT } from '../dist/take.js';
import { accept } from './mcp-pair.mjs';
import { FAST, recordRequests, server, until, wait, world } from './take-app.mjs';

const status = async (s) => (await s.call('obs_take_status')).text;
const last = (text) => text.split('\n').at(-1);
const done = async (w, ...servers) => {
  for (const s of servers) await s.kill();
  await w.fake.close();
};
const takes = (w) => {
  const j = new Journal(w.dir);
  return readdirSync(w.dir).filter((f) => f.endsWith('.jsonl')).map((f) => j.load(f.slice(5, -6)).take);
};

/** R196 k.mjs: Claude Desktop follows a recording from the OBS button and dies; OBS stops; Claude Code records; Claude Desktop comes back. */
async function returning(how) {
  const w = await world();
  const a = await server(w, { elicit: accept, client: 'Claude Desktop' });
  await a.call('obs_take_status');
  w.fake.startInObs();
  await wait(400);
  assert.match(last(await status(a)), /^OBS is recording/);
  await a.kill();
  w.fake.stopInObs();
  await wait(2500);
  const b = await server(w, { elicit: accept, client: 'Claude Code' });
  await b.call('obs_take_status');
  if (how === 'tool') assert.match(last((await b.call('obs_record_start', { token: 'other-client-1' })).text), /^Recording for /);
  else {
    w.fake.startInObs();
    await wait(400);
    assert.match(last(await status(b)), /^OBS is recording/);
  }
  await wait(500);
  const a2 = await server(w, { elicit: accept, client: 'Claude Desktop' });
  return { w, a2, b };
}

for (const how of ['tool', 'button']) {
  test(`F-T7-27, G32: a returning client does not attach its stale take to the recording of another client (${how})`, async () => {
    const { w, a2, b } = await returning(how);
    await status(a2);
    await wait(300);
    const stop = await a2.call('obs_record_stop');
    assert.equal(stop.text, TEXT.X16('stop'), 'the copy that came back only reads: Claude Code controls');
    assert.equal(a2.prompts.length, 0, 'no stop prompt');
    assert.deepEqual(recordRequests(w.fake), how === 'tool' ? ['StartRecord'] : [], 'nothing stopped the recording of Claude Code');
    assert.equal(w.fake.state.recording, true);
    assert.equal(takes(w).filter((t) => t.state !== 'closed').length, 1, 'one take follows the recording');
    assert.ok(takes(w).some((t) => t.state === 'closed' && t.kind === 'external'), 'the old take of Claude Desktop is closed');
    assert.match(last(await status(b)), how === 'tool' ? /^Recording for / : /^OBS is recording/);
    await done(w, a2, b);
  });
}

test('F-T7-29: a returning client whose external recording ended does not say that OBS records', async () => {
  const w = await world();
  const a = await server(w, { elicit: accept, client: 'Claude Desktop' });
  await a.call('obs_take_status');
  w.fake.startInObs();
  await wait(400);
  await a.kill();
  w.fake.stopInObs();
  await wait(1500);
  const a2 = await server(w, { elicit: accept, client: 'Claude Desktop' });
  const text = await status(a2);
  assert.doesNotMatch(text, /OBS is recording/, text);
  assert.doesNotMatch((await a2.call('obs_record_stop')).text, /OBS is recording/);
  assert.ok(['T23', 'T25'].includes(takes(w)[0].row), takes(w)[0].row);
  assert.deepEqual(recordRequests(w.fake), []);
  await done(w, a2);
});

test('F-T7-32: an old journal file that cannot be removed does not stop the server start; the other old files go', async () => {
  const w = await world();
  const j = new Journal(w.dir);
  const old = Date.now() - 40 * 864e5;
  for (const id of ['old0', 'old1']) {
    j.append(id, { t: 'open', v: 1, id, kind: 'normal', pid: 1 });
    j.state(id, { ...newTake(id, 'normal', 'closed'), result: 'verified' }, old);
  }
  mkdirSync(join(w.dir, 'take-old0.beat')); // rmSync cannot remove a folder: the delete fails as EPERM or EBUSY would
  const s = await server(w);
  assert.deepEqual(readdirSync(w.dir).filter((f) => f.startsWith('take-')).sort(), ['take-old0.beat'], 'only the file that cannot go is left');
  assert.equal(await status(s), 'OBS is not recording.');
  await done(w, s);
});

test('F-T7-12, F-T7-26, F-T7-30, F-T7-35: each OBS or client name shows in a code span: no Markdown forms, no backslash is added', () => {
  // The names of R197 shown.mjs and R199.
  assert.equal(shown('Interview [HD]'), '`Interview [HD]`', 'plain text stays readable');
  assert.equal(shown('[scrubbed]'), '`[scrubbed]`');
  assert.equal(shown('\\[Accept here\\](https://evil.example)'), '`\\[Accept here\\](https://evil.example)`', 'a backslash is literal in a code span');
  assert.equal(shown('`code`'), '`\u02CBcode\u02CB`', 'a backtick cannot end the span');
  assert.equal(shown('a\u0007b\r\nc'), '`a\\u{7}b\\u{D}\\u{A}c`');
  assert.equal(shown('clip\u202Egpj.exe'), '`clip\\u{202E}gpj.exe`');
  assert.equal(fileName('rec/a\u202Eb[c](d)<e>`f`.mov'), '`a\\u{202E}b[c](d)<e>\u02CBf\u02CB.mov`');
  assert.equal(fileName(undefined), '`unknown`');
  const long = fileName(`rec/${'x'.repeat(300)}.mov`);
  assert.match(long, /^`x{80}…x{35}\.mov`$/);
  const evil = `rec/a\u202E\u2066\nb[l](https://evil.example/y)<img src=x>\`c\`**IMPORTANT** _now_${'z'.repeat(300)}.mov`;
  const r = { at: Date.now(), conn: 1, ev: 0, active: true, paused: false, duration: 1000, bytes: 1, path: evil };
  const t = { ...newTake('t', 'normal', 'recording'), paths: [evil], endedAt: Date.now() };
  const names = ['Scene [x](https://evil.example)\u202E', 'Mic [1](https://evil.example) <b>', 'Evil [x](https://evil.example) app', '\\<https://evil.example\\>'];
  const texts = [
    TEXT.W1(names[0], [{ name: names[1], track: 1 }], '/Movies/<b>evil.example'), TEXT.W3(r), TEXT.W4(r), TEXT.W5(r), TEXT.W6(r), TEXT.X6(r), TEXT.X11(t),
    TEXT.X15(r, [names[1], names[3]]), TEXT.X18(r), stateLine(t, r, Date.now()), stateLine({ ...t, state: 'external' }, r, Date.now()),
  ];
  for (const text of texts) {
    assert.doesNotMatch(text, /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/, text);
    // Outside the code spans is only the text of obs-mcp: no part of a name, and no Markdown mark of one.
    const outside = text.replace(/`[^`]*`/g, '');
    assert.doesNotMatch(outside, /evil|[[\]<>`*\\]/, text);
    assert.ok(!text.includes('z'.repeat(121)), 'a long name is cut');
  }
});

test('F-T7-17, F-T7-31: after a drop right after StopRecord and a reconnect, the state line is the T18 text, and the journal keeps T18', async () => {
  const w = await world({ silentOn: ['StopRecord'] });
  const s = await server(w, { elicit: accept });
  await s.call('obs_record_start', { token: 'drop-token-1' });
  const stopping = s.call('obs_record_stop');
  assert.ok(await until(() => recordRequests(w.fake).includes('StopRecord'), 2000));
  w.fake.drop();
  assert.equal(last((await stopping).text), TEXT.X10b);
  assert.ok(await until(async () => /^OBS still records/.test(await status(s)), 3000), await status(s));
  assert.match(await status(s), /^OBS still records \(00:00:0\d\)\. I will not send a second stop\. In OBS, click Stop Recording in the Controls dock\.$/);
  assert.equal(takes(w)[0].row, 'T18');
  await wait(500);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord'], 'never a second stop');
  await done(w, s);
});

test('F-T7-28: a stop with no reply goes uncertain at the stop limit that X8 names, not at the call limit', async () => {
  const w = await world({ silentOn: ['StopRecord'] });
  const s = await server(w, { elicit: accept, limits: { ...FAST, callMs: 600, stopMs: 1500 } });
  await s.call('obs_record_start', { token: 'silent-token-1' });
  const t0 = Date.now();
  const text = last((await s.call('obs_record_stop')).text);
  const ms = Date.now() - t0;
  assert.ok(ms >= 1400, `the stop waited ${ms} ms, under the stop limit`);
  assert.match(text, /^I sent the stop at \d\d:\d\d:\d\d, but OBS did not confirm it in 15 s\. I will not send it again/);
  assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
  await done(w, s);
});

test('F-T7-33: a test take says "obs-mcp does not stop it by itself" once in each reply, and never after the stop', async () => {
  const w = await world();
  const s = await server(w, { elicit: accept });
  const started = (await s.call('obs_record_start', { token: 'test-token-33', test: true })).text;
  const once = (text) => text.split('does not stop it by itself').length - 1;
  assert.equal(once(started), 1, started);
  await wait(700); // a reminder W8 waits for the next reply
  const during = await status(s);
  assert.equal(once(during), 1, during);
  await wait(700);
  const stopped = (await s.call('obs_record_stop')).text;
  assert.equal(once(stopped), 0, stopped);
  assert.doesNotMatch(stopped, /still runs/);
  assert.equal(once(await status(s)), 0);
  await done(w, s);
});
