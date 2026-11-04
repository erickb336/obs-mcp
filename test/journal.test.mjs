// T7 unit 4: the take journal on disk. SIMULATED takes; no OBS.
import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { Journal } from '../dist/journal.js';
import { stateDir } from '../dist/platform.js';
import { newTake } from '../dist/take.js';

const folder = () => join(mkdtempSync(join(tmpdir(), 'obs-mcp-journal-')), 'takes');
test('the folder is 0700 and each file 0600 (POSIX); the default folder follows the OS, and OBS_MCP_STATE_DIR overrides it', { skip: process.platform === 'win32' && 'Windows has no POSIX modes' }, () => {
  const dir = folder();
  const j = new Journal(dir);
  j.append('a', { t: 'open', v: 1, id: 'a', kind: 'normal', pid: 1 });
  j.state('a', newTake('a', 'normal', 'starting'));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  assert.equal(stateDir({ OBS_MCP_STATE_DIR: '/x/takes' }), '/x/takes');
  assert.match(stateDir({}, 'darwin'), /Library[\\/]Application Support[\\/]obs-mcp[\\/]takes$/);
  assert.match(stateDir({ XDG_STATE_HOME: '/s' }, 'linux'), /^[\\/]s[\\/]obs-mcp[\\/]takes$/);
  assert.match(stateDir({ LOCALAPPDATA: 'C:\\L' }, 'win32'), /^C:\\L[\\/]obs-mcp[\\/]takes$/);
});

test('the fold of the lines gives the take; a damaged last line is skipped; an open take is listed', () => {
  const dir = folder();
  const j = new Journal(dir);
  j.append('a', { t: 'open', v: 1, id: 'a', kind: 'test', pid: 7 });
  j.append('a', { t: 'expect', sources: [{ uuid: 'uuid-Mic', name: 'Mic', kind: 'voice', track: 1 }] });
  j.append('a', { t: 'intent', what: 'start', at: 1000, token: 'ab12' });
  j.state('a', { ...newTake('a', 'test', 'starting'), intentAt: 1000, row: 'T1' });
  j.state('a', { ...newTake('a', 'test', 'recording'), intentAt: 1000, startedAt: 1272, paths: ['rec/x.mov'], row: 'T2' });
  appendFileSync(join(dir, 'take-a.jsonl'), '{"t":"state","state":"clo'); // a crash during a write
  const l = j.load('a');
  assert.deepEqual([l.take.state, l.take.row, l.take.kind, l.take.paths, l.sources[0].name], ['recording', 'T2', 'test', ['rec/x.mov'], 'Mic']);
  assert.deepEqual(j.openTakes(), ['a']);
  // A new process (after the crash) writes the next line on a line of its own.
  const next = new Journal(dir);
  next.state('a', { ...l.take, state: 'closed', result: 'verified', row: 'T25' });
  assert.deepEqual(j.openTakes(), []);
  assert.equal(next.load('a').take.result, 'verified');
});

test('the writer takes only typed records with allowed fields: no free object, no unknown field, no long line', () => {
  const j = new Journal(folder());
  assert.throws(() => j.append('a', { t: 'intent', what: 'stop', password: 'x' }), /field password is not allowed in intent/);
  assert.throws(() => j.append('a', { t: 'intent', what: 'stop', path: { outputSettings: { key: 'x' } } }), /field path of intent is not a plain value/);
  assert.throws(() => j.append('a', { t: 'expect', sources: [{ name: 'Mic', settings: 'x' }] }), /field sources of expect is not a plain value/);
  assert.throws(() => j.append('a', { t: 'settings', x: 1 }), /unknown record settings/);
  assert.throws(() => j.append('a', { t: '__proto__', x: 1 }), /unknown record __proto__/);
  assert.throws(() => j.append('a', { t: 'open', client: 'Claude Code' }), /field client is not allowed in open/);
  assert.throws(() => j.append('a', { t: 'event', state: 'STARTED', path: 'x'.repeat(70000) }), /longer than 65536 bytes/);
  assert.deepEqual(j.read('a'), []);
});

test('F-T7-54: a hand-edited state line with an id, a __proto__ or another key changes only the fields of a take, and the take writes on', () => {
  const dir = folder();
  const j = new Journal(dir);
  j.append('a', { t: 'open', v: 1, id: 'a', kind: 'normal', pid: 1 });
  appendFileSync(join(dir, 'take-a.jsonl'), '{"t":"state","state":"recording","row":"T2","paths":["x.mov"],"marks":[],"id":"other","__proto__":{"state":"closed"},"color":"red","at":5}\n');
  const next = new Journal(dir);
  const t = next.load('a').take;
  assert.deepEqual(t, { id: 'a', kind: 'normal', state: 'recording', row: 'T2', paths: ['x.mov'], marks: [] });
  assert.equal(Object.getPrototypeOf(t), Object.prototype);
  next.state('a', { ...t, state: 'checking', row: 'T20' }); // a step after the load writes, with no unknown field
  assert.deepEqual([next.load('a').take.state, next.openTakes()], ['checking', ['a']]);
});

test('F-T7-61: a write that takes fewer bytes than it gets goes on until the line is whole; a write of no bytes fails', (t) => {
  const j = new Journal(folder());
  const real = fs.writeSync;
  t.after(() => (mock.restoreAll(), syncBuiltinESMExports()));
  mock.method(fs, 'writeSync', (fd, buf, off = 0) => real(fd, buf, off, Math.min(7, buf.length - off)));
  syncBuiltinESMExports();
  j.append('a', { t: 'open', v: 1, id: 'a', kind: 'normal', pid: 1 });
  j.state('a', { ...newTake('a', 'normal', 'recording'), paths: ['a long file name.mov'], row: 'T2' });
  assert.deepEqual(j.read('a').map((r) => r.state ?? r.t), ['open', 'recording']);
  mock.method(fs, 'writeSync', () => 0);
  syncBuiltinESMExports();
  assert.throws(() => j.append('a', { t: 'intent', what: 'stop', at: 1 }), (e) => e.code === 'EIO');
  mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(j.read('a').length, 2, 'the failed line is not in the file as a record');
});

test('G28: pruning keeps open takes, removes closed takes past 30 days or past 100, and their files', () => {
  const dir = folder();
  const j = new Journal(dir);
  const now = Date.now();
  const make = (id, state, at) => {
    j.append(id, { t: 'open', v: 1, id, kind: 'normal', pid: 1 });
    j.state(id, { ...newTake(id, 'normal', state), result: state === 'closed' ? 'verified' : undefined }, at);
  };
  make('open1', 'recording', now - 40 * 864e5);
  make('old', 'closed', now - 31 * 864e5);
  for (let i = 0; i < 102; i++) make(`c${i}`, 'closed', now - i * 1000);
  j.prune(now);
  const ids = new Set(readdirSync(dir).map((f) => /^take-([\w-]+)\./.exec(f)?.[1]).filter(Boolean));
  assert.equal(ids.has('open1'), true);
  assert.equal(ids.has('old'), false);
  assert.equal(ids.has('c99'), true);
  assert.equal(ids.has('c100'), false);
  assert.equal(ids.size, 101);
  assert.equal(readdirSync(dir).some((f) => f.startsWith('take-old.')), false);
});

test('past the cap of 1,000 lines, event and reply lines are counted in one line, and state lines still go in', () => {
  const j = new Journal(folder());
  j.append('a', { t: 'open', v: 1, id: 'a', kind: 'normal', pid: 1 });
  for (let i = 0; i < 1100; i++) j.append('a', { t: 'event', state: 'PAUSED', at: i });
  j.state('a', { ...newTake('a', 'normal', 'closed'), result: 'verified' });
  const recs = j.read('a');
  assert.equal(recs.length, 992);
  assert.deepEqual(recs.slice(-2).map((r) => [r.t, r.count ?? r.state]), [['dropped', 111], ['state', 'closed']]);
  const size = readFileSync(join(j.dir, 'take-a.jsonl')).length;
  console.log(`a take file of ${recs.length} lines is ${size} bytes`);
});
