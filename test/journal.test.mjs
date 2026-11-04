// T7 unit 4: the take journal on disk. SIMULATED takes; no OBS.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FencedError, Journal } from '../dist/journal.js';
import { stateDir } from '../dist/platform.js';
import { newTake } from '../dist/take.js';

const folder = () => join(mkdtempSync(join(tmpdir(), 'obs-mcp-journal-')), 'takes');
const RACE = fileURLToPath(new URL('./journal-race.mjs', import.meta.url));
const run = (args) => new Promise((resolve, reject) => execFile(process.execPath, [RACE, ...args], (e, out) => (e ? reject(e) : resolve(JSON.parse(out)))));

test('T7 unit 4, F8, F-T7-11, F-T7-13: two real processes on one journal folder: exactly one wins each start and each owner file', async () => {
  const dir = folder();
  new Journal(dir, 'race').own('setup', 1); // makes the folder
  const go = String(Date.now() + 600);
  const [a, b] = await Promise.all([run([dir, go, '200']), run([dir, go, '200'])]);
  const all = (key) => [...a[key], ...b[key]].sort((x, y) => x - y);
  assert.deepEqual(all('claims'), Array.from({ length: 200 }, (_, i) => i + 1));
  assert.deepEqual(all('owners'), Array.from({ length: 200 }, (_, i) => i + 2));
  console.log(`claims won: ${a.claims.length} and ${b.claims.length}; owner files won: ${a.owners.length} and ${b.owners.length}`);
});

test('the folder is 0700 and each file 0600 (POSIX); the default folder follows the OS, and OBS_MCP_STATE_DIR overrides it', { skip: process.platform === 'win32' && 'Windows has no POSIX modes' }, () => {
  const dir = folder();
  const j = new Journal(dir, 'Claude Code');
  assert.equal(j.own('a', 1), true);
  j.append('a', { t: 'open', v: 1, id: 'a', kind: 'normal', client: 'Claude Code', pid: 1 });
  j.beat('a');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  assert.equal(stateDir({ OBS_MCP_STATE_DIR: '/x/takes' }), '/x/takes');
  assert.match(stateDir({}, 'darwin'), /Library[\\/]Application Support[\\/]obs-mcp[\\/]takes$/);
  assert.match(stateDir({ XDG_STATE_HOME: '/s' }, 'linux'), /^[\\/]s[\\/]obs-mcp[\\/]takes$/);
  assert.match(stateDir({ LOCALAPPDATA: 'C:\\L' }, 'win32'), /^C:\\L[\\/]obs-mcp[\\/]takes$/);
});

test('the fold of the lines gives the take; a damaged last line is skipped; an open take is listed', () => {
  const dir = folder();
  const j = new Journal(dir, 'Claude Code');
  j.own('a', 1);
  j.append('a', { t: 'open', v: 1, id: 'a', kind: 'test', client: 'Claude Code', pid: 7 });
  j.append('a', { t: 'expect', sources: [{ uuid: 'uuid-Mic', name: 'Mic', kind: 'voice', track: 1 }] });
  j.append('a', { t: 'intent', what: 'start', at: 1000, token: 'ab12' });
  j.state('a', { ...newTake('a', 'test', 'starting'), intentAt: 1000, row: 'T1' });
  j.state('a', { ...newTake('a', 'test', 'recording'), intentAt: 1000, startedAt: 1272, paths: ['rec/x.mov'], row: 'T2' });
  appendFileSync(join(dir, 'take-a.jsonl'), '{"t":"state","state":"clo'); // a crash during a write
  const l = j.load('a');
  assert.deepEqual([l.take.state, l.take.row, l.take.kind, l.take.paths, l.meta.client, l.sources[0].name], ['recording', 'T2', 'test', ['rec/x.mov'], 'Claude Code', 'Mic']);
  assert.deepEqual(j.openTakes(), ['a']);
  // A new process (after the crash) writes the next line on a line of its own.
  const next = new Journal(dir, 'Claude Code');
  next.own('a', 2);
  next.state('a', { ...l.take, state: 'closed', result: 'verified', row: 'T25' });
  assert.deepEqual(j.openTakes(), []);
  assert.equal(next.load('a').take.result, 'verified');
});

test('the writer takes only typed records with allowed fields: no free object, no unknown field, no long line', () => {
  const j = new Journal(folder(), 'c');
  j.own('a', 1);
  assert.throws(() => j.append('a', { t: 'intent', what: 'stop', password: 'x' }), /field password is not allowed in intent/);
  assert.throws(() => j.append('a', { t: 'intent', what: 'stop', path: { outputSettings: { key: 'x' } } }), /field path of intent is not a plain value/);
  assert.throws(() => j.append('a', { t: 'expect', sources: [{ name: 'Mic', settings: 'x' }] }), /field sources of expect is not a plain value/);
  assert.throws(() => j.append('a', { t: 'settings', x: 1 }), /unknown record settings/);
  assert.throws(() => j.append('a', { t: 'event', state: 'STARTED', path: 'x'.repeat(5000) }), /longer than 4096 bytes/);
  assert.deepEqual(j.read('a'), []);
});

test('F8: a takeover needs a beat older than 15 s and the same client; then the old owner is fenced and only reads', () => {
  const dir = folder();
  const old = new Journal(dir, 'Claude Code');
  old.own('a', 1);
  old.append('a', { t: 'open', v: 1, id: 'a', kind: 'normal', client: 'Claude Code', pid: 1 });
  old.beat('a');
  const other = new Journal(dir, 'Cursor');
  const same = new Journal(dir, 'Claude Code');
  assert.equal(same.takeOver('a', 15000), false, 'the beat is fresh');
  writeFileSync(join(dir, 'take-a.beat'), JSON.stringify({ at: Date.now() - 16000 }));
  assert.equal(other.takeOver('a', 15000), false, 'another client never takes over (G29)');
  assert.equal(same.takeOver('a', 15000), true);
  assert.equal(same.owner('a').k, 2);
  assert.equal(same.isOwner('a'), true);
  assert.equal(old.isOwner('a'), false);
  assert.throws(() => old.append('a', { t: 'intent', what: 'stop', at: 1 }), FencedError);
  assert.throws(() => old.beat('a'), FencedError);
  same.append('a', { t: 'intent', what: 'stop', at: 2 });
  assert.deepEqual(same.read('a').map((r) => [r.t, r.k]), [['open', 1], ['intent', 2]], 'each line carries its owner number');
});

test('G28: pruning keeps open takes, removes closed takes past 30 days or past 100, and their files', () => {
  const dir = folder();
  const j = new Journal(dir, 'c');
  const now = Date.now();
  const make = (id, state, at) => {
    j.own(id, 1);
    j.append(id, { t: 'open', v: 1, id, kind: 'normal', client: 'c', pid: 1 });
    j.state(id, { ...newTake(id, 'normal', state), result: state === 'closed' ? 'verified' : undefined }, at);
    j.beat(id);
  };
  make('open1', 'recording', now - 40 * 864e5);
  make('old', 'closed', now - 31 * 864e5);
  for (let i = 0; i < 102; i++) make(`c${i}`, 'closed', now - i * 1000);
  j.claim('c1', () => false);
  j.claim('c2', () => false);
  utimesSync(join(dir, 'start-1.claim'), new Date(now - 40 * 864e5), new Date(now - 40 * 864e5));
  j.prune(now);
  const ids = new Set(readdirSync(dir).map((f) => /^take-([\w-]+)\./.exec(f)?.[1]).filter(Boolean));
  assert.equal(ids.has('open1'), true);
  assert.equal(ids.has('old'), false);
  assert.equal(ids.has('c99'), true);
  assert.equal(ids.has('c100'), false);
  assert.equal(ids.size, 101);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.claim')), ['start-2.claim']);
  assert.equal(readdirSync(dir).some((f) => f.startsWith('take-old.')), false);
});

test('past the cap of 1,000 lines, event and reply lines are counted in one line, and state lines still go in', () => {
  const j = new Journal(folder(), 'c');
  j.own('a', 1);
  j.append('a', { t: 'open', v: 1, id: 'a', kind: 'normal', client: 'c', pid: 1 });
  for (let i = 0; i < 1100; i++) j.append('a', { t: 'event', state: 'PAUSED', at: i });
  j.state('a', { ...newTake('a', 'normal', 'closed'), result: 'verified' });
  const recs = j.read('a');
  assert.equal(recs.length, 992);
  assert.deepEqual(recs.slice(-2).map((r) => [r.t, r.count ?? r.state]), [['dropped', 111], ['state', 'closed']]);
  const size = readFileSync(join(j.dir, 'take-a.jsonl')).length;
  console.log(`a take file of ${recs.length} lines is ${size} bytes`);
});
