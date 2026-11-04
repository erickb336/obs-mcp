// T7 unit 3: the pure take state machine and the same-recording test. No OBS, no clock: every time is a number here.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { journalReading, newTake, sameRecording, stateLine, step, TEXT } from '../dist/take.js';

const T0 = Date.UTC(2026, 10, 3, 14, 30, 50);
const P = 'rec/2026-11-03 15-30-50.mov';
const Q = 'rec/2026-11-03 15-44-02.mov';
const R = (o = {}) => ({ at: T0 + 10000, conn: 1, ev: 2, active: true, paused: false, duration: 9000, bytes: 9e6, path: P, ...o });
const take = (state, o = {}) => ({ ...newTake('t1', 'normal', state), intentAt: T0, startedAt: T0 + 300, startBytes: 0, paths: [P], ...o });

// Each row of section 2: the take before, the input, then the row, the state after, and the other effects that the row names.
const ROWS = [
  ['T1', take('idle'), { type: 'start', at: T0, reading: R({ active: false }) }, 'starting'],
  ['T1 from closed', take('closed', { result: 'verified' }), { type: 'start', at: T0, reading: R({ active: false }), lastEventAt: T0 - 2500 }, 'starting', { row: 'T1' }],
  ['T2', take('starting'), { type: 'event', state: 'STARTED', at: T0 + 272, path: P }, 'recording'],
  ['T3 timeout', take('starting'), { type: 'timeout', phase: 'start', at: T0 + 5000 }, 'start_uncertain', { row: 'T3' }],
  ['T3 disconnect', take('starting'), { type: 'disconnect' }, 'start_uncertain', { row: 'T3', marks: ['offline'] }],
  ['T4 event', take('start_uncertain'), { type: 'event', state: 'STARTED', at: T0 + 6000, path: P }, 'recording', { row: 'T4' }],
  ['T4 read', take('start_uncertain'), { type: 'read', reading: R({ at: T0 + 7000, duration: 1500 }) }, 'recording', { row: 'T4' }],
  ['T5', take('start_uncertain'), { type: 'read', reading: R({ at: T0 + 7000, duration: 60000 }) }, 'external', { kind: 'external' }],
  ['T6', take('start_uncertain'), { type: 'timeout', phase: 'hold', at: T0 + 35000 }, 'closed', { result: 'not_started' }],
  ['T7 starting', take('starting'), { type: 'event', state: 'STOPPED', at: T0 + 100 }, 'closed', { row: 'T7', result: 'not_started' }],
  ['T7 start_uncertain', take('start_uncertain'), { type: 'event', state: 'STOPPED', at: T0 + 6000 }, 'closed', { row: 'T7', result: 'not_started' }],
  ['T8', take('starting'), { type: 'reply', request: 'StartRecord', code: 500, at: T0 }, 'external', { kind: 'external' }],
  ['T9', take('starting'), { type: 'stop', reading: R({ duration: 100 }) }, 'stopping', { send: 'StopRecord' }],
  ['T9 from start_uncertain', take('start_uncertain'), { type: 'stop', reading: R() }, 'stopping', { row: 'T9', send: 'StopRecord' }],
  ['T9 queued start ignored', take('stopping', { stopSeen: false }), { type: 'event', state: 'STARTED', at: T0 + 300, path: P }, 'stopping', { row: undefined }],
  ['T10', take('starting'), { type: 'stop', reading: R({ active: false }) }, 'stop_held'],
  ['T11 event', take('stop_held'), { type: 'event', state: 'STARTED', at: T0 + 9000, path: Q }, 'external', { row: 'T11', notice: 'X18', paths: [Q] }],
  ['T11 read', take('stop_held'), { type: 'read', reading: R({ path: Q }) }, 'external', { row: 'T11', notice: 'X18' }],
  ['T12', take('stop_held'), { type: 'timeout', phase: 'hold', at: T0 + 40000 }, 'closed', { result: 'not_started' }],
  ['T13 pause', take('recording'), { type: 'event', state: 'PAUSED', at: T0 + 20000 }, 'paused', { row: 'T13' }],
  ['T13 resume', take('paused'), { type: 'event', state: 'RESUMED', at: T0 + 30000 }, 'recording', { row: 'T13' }],
  ['T13 read settles a lost reply', take('recording'), { type: 'read', reading: R({ paused: true }) }, 'paused', { row: 'T13' }],
  ['T14 recording', take('recording'), { type: 'stop', reading: R() }, 'stopping', { row: 'T14', send: 'StopRecord' }],
  ['T14 paused', take('paused'), { type: 'stop', reading: R({ paused: true }) }, 'stopping', { row: 'T14', send: 'StopRecord' }],
  ['T14 external', take('external', { kind: 'external' }), { type: 'stop', reading: R() }, 'stopping', { row: 'T14', send: 'StopRecord' }],
  ['T15 STOPPED', take('stopping'), { type: 'event', state: 'STOPPED', at: T0 + 20000, path: P }, 'checking', { row: 'T15' }],
  ['T15 501', take('stopping'), { type: 'reply', request: 'StopRecord', code: 501, at: T0 + 20000 }, 'checking', { row: 'T15', marks: ['stopped_in_obs'] }],
  ['T16 timeout', take('stopping'), { type: 'timeout', phase: 'stop', at: T0 + 35000 }, 'stop_uncertain', { row: 'T16' }],
  ['T16 disconnect', take('stopping'), { type: 'disconnect' }, 'stop_uncertain', { row: 'T16', marks: ['offline'] }],
  ['T16 other code', take('stopping'), { type: 'reply', request: 'StopRecord', code: 500, at: T0 }, 'stop_uncertain', { row: 'T16' }],
  ['T17 event', take('stop_uncertain'), { type: 'event', state: 'STOPPED', at: T0 + 40000, path: P }, 'checking', { row: 'T17' }],
  ['T17 read', take('stop_uncertain', { marks: ['offline'] }), { type: 'read', reading: R({ active: false }) }, 'checking', { row: 'T17', marks: [] }],
  ['T18', take('stop_uncertain'), { type: 'read', reading: R(), same: true }, 'stop_uncertain', { row: 'T18', send: undefined }],
  ['T19', take('stop_uncertain'), { type: 'read', reading: R({ path: Q }), same: false }, 'closed', { row: 'T19', result: 'not_checked', spawn: true }],
  ['T20 ours', take('recording'), { type: 'event', state: 'STOPPED', at: T0 + 20000, path: P }, 'checking', { row: 'T20', marks: ['stopped_in_obs'] }],
  ['T20 external', take('external', { kind: 'external' }), { type: 'event', state: 'STOPPED', at: T0 + 20000, path: P }, 'checking', { row: 'T20', marks: ['external'] }],
  ['T21 read', take('recording'), { type: 'read', reading: R({ active: false }) }, 'checking', { row: 'T21', marks: ['unplanned_stop'], notice: 'X11' }],
  ['T21 ExitStarted', take('paused'), { type: 'exit', at: T0 + 20000 }, 'checking', { row: 'T21', marks: ['lost'], notice: 'X11' }],
  ['T21 OBS gone', take('recording', { marks: ['offline'] }), { type: 'timeout', phase: 'gone', at: T0 + 80000 }, 'checking', { row: 'T21', marks: ['offline', 'lost'], notice: 'X11' }],
  ['T22 event', take('closed', { result: 'verified' }), { type: 'event', state: 'STARTED', at: T0, path: Q }, 'closed', { row: 'T22', spawn: true, notice: 'X15' }],
  ['T22 read at connect', take('idle'), { type: 'read', reading: R() }, 'idle', { row: 'T22', spawn: true, notice: 'X15' }],
  ['T23', take('external', { kind: 'external' }), { type: 'read', reading: R({ active: false }) }, 'checking', { row: 'T23', marks: ['external'] }],
  ['T24', take('recording'), { type: 'read', reading: R({ path: Q }), same: false }, 'closed', { row: 'T24', result: 'not_checked', spawn: true }],
  ['T25', take('checking'), { type: 'checked', result: 'verified', summary: '00:00:09, 1 of 1 expected sources had sound in the file.' }, 'closed', { row: 'T25', result: 'verified' }],
  ['T26', take('checking', { stopSeen: true }), { type: 'event', state: 'STARTED', at: T0 + 21000, path: Q }, 'checking', { row: 'T26', spawn: true, notice: 'X15' }],
  ['O1', take('recording'), { type: 'disconnect' }, 'recording', { row: 'O1', marks: ['offline'] }],
  ['O1 external', take('external'), { type: 'disconnect' }, 'external', { row: 'O1', marks: ['offline'] }],
  ['O5 stopping', take('stopping'), { type: 'start', at: T0, reading: R({ active: false }) }, 'stopping', { row: undefined, refuse: 'X7' }],
  ['O5 checking', take('checking'), { type: 'start', at: T0, reading: R({ active: false }) }, 'checking', { row: undefined, refuse: 'X7' }],
  ['O7 F6: a second accept sends nothing', take('stopping'), { type: 'stop', reading: R() }, 'stopping', { row: 'O7', send: undefined }],
  ['O7 stop_uncertain', take('stop_uncertain'), { type: 'stop', reading: R() }, 'stop_uncertain', { row: 'O7', send: undefined }],
  ['E10 late 500 after our stop', take('stopping'), { type: 'reply', request: 'StartRecord', code: 500, at: T0 }, 'stopping', { row: 'E10', kind: 'external', marks: ['external'] }],
  ['P14 race guard', take('idle'), { type: 'start', at: T0, reading: R({ active: false }), lastEventAt: T0 - 1500 }, 'idle', { row: undefined, refuse: 'X6' }],
  ['X6 while OBS records', take('idle'), { type: 'start', at: T0, reading: R() }, 'idle', { row: undefined, refuse: 'X6' }],
  ['R1', take('start_uncertain'), { type: 'restart', reading: R(), same: false, at: T0 + 60000 }, 'external', { row: 'R1', kind: 'external' }],
  ['R1 held stop', take('stop_held'), { type: 'restart', reading: R(), same: false, at: T0 + 60000 }, 'external', { row: 'R1', notice: 'X18' }],
  ['R2', take('starting'), { type: 'restart', reading: R({ active: false }), same: false, at: T0 + 60000 }, 'closed', { row: 'R2', result: 'not_started' }],
  ['R3', take('recording'), { type: 'restart', reading: R(), same: true, at: T0 + 60000 }, 'recording', { row: 'R3' }],
  ['R3 paused', take('recording'), { type: 'restart', reading: R({ paused: true }), same: true, at: T0 + 60000 }, 'paused', { row: 'R3' }],
  ['R4', take('paused'), { type: 'restart', reading: R({ path: Q }), same: false, at: T0 + 60000 }, 'closed', { row: 'R4', result: 'not_checked', spawn: true }],
  ['R5', take('recording'), { type: 'restart', reading: R({ active: false }), same: false, at: T0 + 60000 }, 'checking', { row: 'R5', marks: ['unplanned_stop'], notice: 'X11' }],
  ['R6 stopping', take('stopping'), { type: 'restart', reading: R(), same: true, at: T0 + 60000 }, 'stop_uncertain', { row: 'R6' }],
  ['R6 stop_uncertain', take('stop_uncertain'), { type: 'restart', reading: R({ active: false }), same: false, at: T0 + 60000 }, 'stop_uncertain', { row: 'R6' }],
  ['R7', take('external'), { type: 'restart', reading: R({ path: Q }), same: false, at: T0 + 60000 }, 'external', { row: 'R7', paths: [P, Q] }],
  ['R8', take('checking'), { type: 'restart', reading: R({ active: false }), same: false, at: T0 + 60000 }, 'checking', { row: 'R8' }],
];

describe('T7 unit 3: one test for each row of section 2', () => {
  for (const [name, before, input, state, want = {}] of ROWS) {
    test(name, () => {
      const out = step(before, input);
      const row = 'row' in want ? want.row : name.split(' ')[0];
      assert.equal(out.row, row, 'row');
      assert.equal(out.take.state, state, 'state');
      assert.equal(out.send, 'send' in want ? want.send : undefined, 'send');
      assert.equal(!!out.spawn, !!want.spawn, 'spawn');
      assert.equal(out.notice?.id, want.notice, 'notice');
      assert.equal(out.refuse, want.refuse, 'refuse');
      for (const k of ['result', 'kind', 'paths']) if (k in want) assert.deepEqual(out.take[k], want[k], k);
      if ('marks' in want) assert.deepEqual(out.take.marks, want.marks, 'marks');
    });
  }
});

test('only rows T9 and T14 send, and only StopRecord: no input sends a start, and no timeout, read or restart sends a stop', () => {
  const senders = ROWS.filter(([, b, i]) => step(b, i).send).map(([n]) => n.split(' ')[0]);
  assert.deepEqual([...new Set(senders)], ['T9', 'T14']);
  for (const [, b, i] of ROWS) if (i.type !== 'stop') assert.equal(step(b, i).send, undefined);
});

describe('T7 unit 3: the same-recording test (section 3)', () => {
  const A = R({ at: T0, duration: 60000, bytes: 6e7 });
  const B = (o) => R({ at: T0 + 40000, duration: 100000, bytes: 1e8, ...o });
  test('B passes when it is active, on a path of the take, within the bound, and no record event came on the same connection', () => {
    assert.equal(sameRecording(A, B(), [P]), true);
  });
  test('check 1: B not active fails', () => assert.equal(sameRecording(A, B({ active: false }), [P]), false));
  test('check 2: fewer bytes than A (OBS restarted) fails', () => assert.equal(sameRecording(A, B({ bytes: 1000 }), [P]), false));
  test('check 3: another path, or no path, fails; a path from a split passes', () => {
    assert.equal(sameRecording(A, B({ path: Q }), [P]), false);
    assert.equal(sameRecording(A, B({ path: undefined }), [P]), false);
    assert.equal(sameRecording(A, B({ path: Q }), [P, Q]), true);
  });
  test('check 4: a duration that runs faster than the clock, or goes back by more than 0.5 s, fails', () => {
    assert.equal(sameRecording(A, B({ duration: 100501 }), [P]), false);
    assert.equal(sameRecording(A, B({ duration: 100500 }), [P]), true);
    assert.equal(sameRecording(A, B({ duration: 59499 }), [P]), false);
  });
  test('check 5: a STARTED, STOPPING or STOPPED between A and B on one connection fails; on a new connection the count does not apply', () => {
    assert.equal(sameRecording(A, B({ ev: 3 }), [P]), false);
    assert.equal(sameRecording(A, B({ ev: 0, conn: 2 }), [P]), true);
  });
  test('E11: a paused take passes, because its duration stays still while the clock runs', () => {
    const pausedA = R({ at: T0, duration: 724000, paused: true });
    assert.equal(sameRecording(pausedA, R({ at: T0 + 40000, duration: 724000, paused: true }), [P]), true);
    // You resume between the prompt and the answer: the duration grows by less than the clock.
    assert.equal(sameRecording(pausedA, R({ at: T0 + 40000, duration: 734000 }), [P]), true);
  });
  test('journal to read: the duration may be up to 2 s longer than the time since STARTED, and has no lower bound', () => {
    const j = journalReading(take('recording', { startedAt: T0 }));
    assert.equal(sameRecording(j, R({ at: T0 + 10000, duration: 11900, conn: 1 }), [P]), true);
    assert.equal(sameRecording(j, R({ at: T0 + 10000, duration: 12100, conn: 1 }), [P]), false);
    assert.equal(sameRecording(j, R({ at: T0 + 600000, duration: 1000, conn: 1 }), [P]), true, 'a long pause only makes it shorter');
  });
});

test('the state line of each state, and the marks that change it', () => {
  const at = T0 + 10000;
  const r = R({ duration: 724000 });
  assert.equal(stateLine(undefined, undefined, at), 'OBS is not recording.');
  assert.match(stateLine(take('recording'), r, at), /^Recording for 00:12:04 \(OBS confirmed it\)\. File: 2026-11-03 15-30-50\.mov\.$/);
  assert.match(stateLine(take('paused', { pausedAt: at - 63000 }), r, at), /^The recording is paused at 00:12:04, for 1 min 03 s now\. Nothing goes into the file\.$/);
  assert.match(stateLine(take('external'), r, at), /^OBS is recording \(00:12:04, file 2026-11-03 15-30-50\.mov\), but obs-mcp did not start this recording\. I do not stop it unless you ask\.$/);
  assert.match(stateLine(take('recording', { marks: ['offline'] }), r, at), /^I lost the connection to OBS at \d\d:\d\d:\d\d\. OBS keeps recording on its own\./);
  assert.match(stateLine(take('recording', { kind: 'test' }), r, at), /This is a test recording\. obs-mcp does not stop it by itself\.$/);
  assert.match(stateLine(take('closed', { result: 'not_started', row: 'T7' }), r, at), /^Take closed: not_started\. OBS did not start the recording\. OBS gives no reason, so look in the OBS log\.$/);
  assert.equal(TEXT.W3(r), 'Stop the OBS recording? It has run 00:12:04. File: 2026-11-03 15-30-50.mov. OBS then finishes the file. This takes about 1 s. Accept to stop. Decline to keep recording.');
});
