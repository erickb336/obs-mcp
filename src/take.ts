// The take state machine (T7 design, sections 1 to 5): states, transitions, the same-recording test and the texts.
// Pure: no I/O and no clock. The driver (takes.ts) reads OBS, writes the journal, and feeds each input here.
// Rule: a step returns at most one StopRecord to send, and only for your stop request (rows T9 and T14).
import { visible } from './verify.js';

export type State = 'idle' | 'starting' | 'start_uncertain' | 'stop_held' | 'external' | 'recording' | 'paused' | 'stopping' | 'stop_uncertain' | 'checking' | 'closed';
export type Result = 'not_started' | 'verified' | 'verified_with_warnings' | 'failed' | 'not_checked';
export type Mark = 'offline' | 'stopped_in_obs' | 'unplanned_stop' | 'lost' | 'external';
export type Kind = 'normal' | 'test' | 'external';

/** One GetRecordStatus read, with the file path (check 3), the connection number and the count of STARTED, STOPPING and STOPPED events seen on it. */
export type Reading = { at: number; conn: number; ev: number; active: boolean; paused: boolean; duration: number; bytes: number; path?: string };

export type Take = {
  id: string;
  kind: Kind;
  state: State;
  result?: Result;
  marks: Mark[];
  /** The row that moved the take last: it picks the words of the state line. */
  row?: string;
  intentAt?: number;
  startedAt?: number;
  /** outputBytes before the take: the baseline of check 2 (section 3). */
  startBytes?: number;
  /** The start path and the newest path: a split adds a path, and only these two are kept, so a state line stays short. */
  paths: string[];
  /** When the connection dropped, for X10. */
  offlineAt?: number;
  pausedAt?: number;
  stopAt?: number;
  endedAt?: number;
  heldUntil?: number;
  /** A STOPPING, STOPPED or 501 came after our stop: from then a STARTED is a new recording (T26). */
  stopSeen?: boolean;
  /** The file check line, after T25. */
  summary?: string;
};

export type Input =
  | { type: 'start'; at: number; reading: Reading; lastEventAt?: number }
  | { type: 'event'; state: 'STARTED' | 'STOPPING' | 'STOPPED' | 'PAUSED' | 'RESUMED'; at: number; path?: string | null }
  | { type: 'file'; path: string }
  | { type: 'reply'; request: 'StartRecord' | 'StopRecord'; code: number; at: number }
  /** prevAt: the time of the last read that showed the take active, the last time that it surely recorded. */
  | { type: 'read'; reading: Reading; same?: boolean; prevAt?: number }
  | { type: 'timeout'; phase: 'start' | 'hold' | 'stop' | 'gone'; at: number }
  | { type: 'disconnect'; at: number }
  | { type: 'exit'; at: number }
  | { type: 'stop'; reading: Reading }
  | { type: 'checked'; result: Result; summary: string }
  | { type: 'restart'; reading: Reading; same: boolean; at: number };

export type Step = {
  take: Take;
  /** The transition id of section 2, or undefined when nothing changed. */
  row?: string;
  /** Only rows T9 and T14 set it. */
  send?: 'StopRecord';
  /** Open a new external take for the recording that runs now (T19, T22, T24, T26). */
  spawn?: boolean;
  /** A text for the notice channel (rule 6), with its level. */
  notice?: { id: 'X11' | 'X15' | 'X18'; level: 'warning' | 'error' };
  /** A refusal before any send. */
  refuse?: 'X6' | 'X7';
};

/** The limits of section 4, in ms. */
export const LIMITS = {
  connectMs: 3000, // P1
  callMs: 10000, // P2
  startMs: 5000, // P3
  holdMs: 30000, // P4
  holdReadMs: 1000,
  stopMs: 15000, // P5
  stopReadMs: 2000, // P6
  goneMs: 60000, // P9
  consentMs: 120000, // P10, P15
  reminderFirstMs: 10000, // P11
  reminderMs: 60000,
  raceMs: 2000, // P14
  beatMs: 5000, // P13: the watch read
  reconnectMs: [500, 1000, 2000, 4000, 8000, 10000], // P8
};
export type Limits = typeof LIMITS;

const OPEN: State[] = ['starting', 'start_uncertain', 'stop_held', 'external', 'recording', 'paused', 'stopping', 'stop_uncertain', 'checking'];
/** Every state, for the check of a journal line (F-T7-42). */
export const STATES: State[] = ['idle', ...OPEN, 'closed'];
export const isOpen = (t: Take) => OPEN.includes(t.state);
const STOPS: State[] = ['stopping', 'stop_uncertain'];
/** The states of a take that OBS records. */
export const RECORDS: State[] = ['recording', 'paused', 'external'];

/** The take that a new intent starts from, or that the server opens for a recording it did not start. */
export const newTake = (id: string, kind: Kind, state: State = 'idle'): Take => ({ id, kind, state, marks: [], paths: [] });

/** Reading A of a journal: the STARTED event of the take, for the restart rows R3 and R4. */
export const journalReading = (t: Take): Reading | undefined =>
  t.startedAt === undefined ? undefined : { at: t.startedAt, conn: -1, ev: -1, active: true, paused: false, duration: 0, bytes: t.startBytes ?? 0, path: t.paths[0] };

/**
 * The same-recording test of section 3. a is the earlier reading (the one in the prompt, or journalReading), b the read now.
 * All 5 checks must pass. A failed check fails to the safe side: the server sends nothing.
 */
export function sameRecording(a: Reading, b: Reading, paths: string[], journal = a.conn === -1): boolean {
  if (!b.active) return false; // 1
  if (b.bytes < a.bytes) return false; // 2: the count resets only when OBS restarts
  if (!b.path || ![...paths, a.path].includes(b.path)) return false; // 3
  const bound = journal ? b.duration <= b.at - a.at + 2000 : a.duration - 500 <= b.duration && b.duration <= a.duration + (b.at - a.at) + 500;
  if (!bound) return false; // 4
  return !(a.conn === b.conn && a.ev !== b.ev); // 5: on one connection, no STARTED, STOPPING or STOPPED between A and B
}

const to = (take: Take, state: State, row: string, extra: Partial<Take> = {}): Step => ({ take: { ...take, ...extra, state, row }, row });
/** The paths of a take after a file path: the start path and the newest one (F-T7-5). */
const withPath = (paths: string[], p?: string | null) => (!p || paths.includes(p) ? paths : paths.length ? [paths[0], p] : [p]);
const mark = (t: Take, ...m: Mark[]) => [...new Set([...t.marks, ...m])];
const unmark = (t: Take, m: Mark) => t.marks.filter((x) => x !== m);
const close = (take: Take, result: Result, row: string, extra: Partial<Take> = {}) => to(take, 'closed', row, { result, ...extra });
/** at: when the recording ended, or undefined when nobody knows (R5). */
const checking = (take: Take, row: string, at: number | undefined, ...marks: Mark[]) => to(take, 'checking', row, { marks: mark(take, ...marks), endedAt: at });

/** One input on one take. Inputs with no row for the state change nothing. */
export function step(take: Take, input: Input): Step {
  const s = take.state;
  const same: Step = { take };
  switch (input.type) {
    case 'start':
      // O5: a start while the last take finishes. T1 needs a read that shows not active and no record event in 2 s (P14).
      if (STOPS.includes(s) || s === 'checking') return { take, refuse: 'X7' };
      if (s !== 'idle' && s !== 'closed') return { take, refuse: 'X6' };
      if (input.reading.active || (input.lastEventAt !== undefined && input.at - input.lastEventAt < LIMITS.raceMs)) return { take, refuse: 'X6' };
      return to(take, 'starting', 'T1', { intentAt: input.at, startBytes: input.reading.bytes });

    case 'stop': {
      const active = input.reading.active;
      if (STOPS.includes(s)) return { take, row: 'O7' };
      if (s === 'starting' || s === 'start_uncertain') {
        if (active) return { ...to(take, 'stopping', 'T9', { stopAt: input.reading.at, stopSeen: false }), send: 'StopRecord' };
        return to(take, 'stop_held', 'T10', { heldUntil: input.reading.at + LIMITS.holdMs });
      }
      if ((s === 'recording' || s === 'paused' || s === 'external') && active) return { ...to(take, 'stopping', 'T14', { stopAt: input.reading.at, stopSeen: false }), send: 'StopRecord' };
      return same;
    }

    case 'event': {
      const e = input.state;
      if (e === 'STARTED') {
        if (s === 'starting' || s === 'start_uncertain') return to(take, 'recording', s === 'starting' ? 'T2' : 'T4', { startedAt: input.at, paths: input.path ? [input.path] : [] });
        if (s === 'stop_held') return { ...to(take, 'external', 'T11', { kind: 'external', paths: input.path ? [input.path] : [] }), notice: { id: 'X18', level: 'warning' } };
        if (s === 'stopping' && !take.stopSeen) return same; // T9: the start that queued before our stop
        if (s === 'checking') return { take, row: 'T26', spawn: true, notice: { id: 'X15', level: 'warning' } };
        if (s === 'idle' || s === 'closed') return { take, row: 'T22', spawn: true, notice: { id: 'X15', level: 'warning' } };
        return same;
      }
      if (e === 'STOPPING') return s === 'stopping' ? { take: { ...take, stopSeen: true } } : same;
      if (e === 'PAUSED' && s === 'recording') return to(take, 'paused', 'T13', { pausedAt: input.at });
      if (e === 'RESUMED' && s === 'paused') return to(take, 'recording', 'T13', { pausedAt: undefined });
      if (e === 'STOPPED') {
        const end = { paths: withPath(take.paths, input.path) };
        if (s === 'starting' || s === 'start_uncertain') return close(take, 'not_started', 'T7');
        if (s === 'stopping') return to(take, 'checking', 'T15', { ...end, endedAt: input.at, stopSeen: true });
        if (s === 'stop_uncertain') return to(take, 'checking', 'T17', { ...end, endedAt: input.at, stopSeen: true });
        if (s === 'recording' || s === 'paused' || s === 'external') return checking({ ...take, ...end }, 'T20', input.at, s === 'external' ? 'external' : 'stopped_in_obs');
      }
      return same;
    }

    case 'file':
      return isOpen(take) && !take.paths.includes(input.path) ? { take: { ...take, paths: withPath(take.paths, input.path) } } : same;

    case 'reply':
      if (input.request === 'StartRecord' && input.code === 500) {
        if (s === 'starting') return to(take, 'external', 'T8', { kind: 'external' });
        // E10: a late 500 after your stop went out. The recording was not ours; the stop stands.
        if (s === 'stopping') return { take: { ...take, kind: 'external', marks: mark(take, 'external') }, row: 'E10' };
      }
      if (input.request === 'StopRecord' && s === 'stopping') {
        if (input.code === 501) return to(take, 'checking', 'T15', { marks: mark(take, 'stopped_in_obs'), endedAt: input.at, stopSeen: true });
        if (input.code !== 100) return to(take, 'stop_uncertain', 'T16');
      }
      return same;

    case 'timeout':
      if (input.phase === 'start' && s === 'starting') return to(take, 'start_uncertain', 'T3', { heldUntil: input.at + LIMITS.holdMs });
      if (input.phase === 'hold' && s === 'start_uncertain') return close(take, 'not_started', 'T6');
      if (input.phase === 'hold' && s === 'stop_held') return close(take, 'not_started', 'T12');
      if (input.phase === 'stop' && s === 'stopping') return to(take, 'stop_uncertain', 'T16');
      // The recording surely ran until the drop, and OBS has not answered since (X11 gives that time, F-T7-67).
      if (input.phase === 'gone' && (s === 'recording' || s === 'paused')) return { ...checking(take, 'T21', take.offlineAt ?? input.at, 'lost'), notice: { id: 'X11', level: 'error' } };
      return same;

    case 'disconnect': {
      const off = { marks: mark(take, 'offline'), offlineAt: take.marks.includes('offline') ? take.offlineAt : input.at };
      if (s === 'starting') return to(take, 'start_uncertain', 'T3', off);
      if (s === 'stopping') return to(take, 'stop_uncertain', 'T16', off);
      if (['recording', 'paused', 'external', 'stop_held', 'stop_uncertain', 'start_uncertain'].includes(s)) return to(take, s, 'O1', off);
      return same;
    }

    case 'exit':
      if (s === 'recording' || s === 'paused') return { ...checking(take, 'T21', input.at, 'lost'), notice: { id: 'X11', level: 'error' } };
      return same;

    case 'read': {
      const r = input.reading;
      const t = take.marks.includes('offline') ? { ...take, marks: unmark(take, 'offline'), offlineAt: undefined } : take;
      const base: Step = { take: t };
      if (s === 'start_uncertain' && r.active) {
        if (take.intentAt !== undefined && r.duration <= r.at - take.intentAt) return to(t, 'recording', 'T4', { startedAt: r.at - r.duration, paths: r.path ? [r.path] : [] });
        return to(t, 'external', 'T5', { kind: 'external', paths: r.path ? [r.path] : [] });
      }
      if (s === 'stop_held' && r.active) return { ...to(t, 'external', 'T11', { kind: 'external', paths: r.path ? [r.path] : [] }), notice: { id: 'X18', level: 'warning' } };
      // The recording ended after the last read that showed it, or after the drop (X11 gives that time, F-T7-67).
      if ((s === 'recording' || s === 'paused') && !r.active) return { ...checking(t, 'T21', take.offlineAt ?? input.prevAt ?? r.at, 'unplanned_stop'), notice: { id: 'X11', level: 'error' } };
      // After a reconnect, a take follows only the recording that it followed: an external take too (F-T7-65).
      if ((s === 'recording' || s === 'paused' || s === 'external') && input.same === false) return { ...close(t, 'not_checked', 'T24'), spawn: true };
      if (s === 'recording' && r.paused) return to(t, 'paused', 'T13', { pausedAt: r.at });
      if (s === 'paused' && r.active && !r.paused) return to(t, 'recording', 'T13', { pausedAt: undefined });
      if (s === 'external' && !r.active) return checking(t, 'T23', r.at, 'external');
      if (s === 'external' && r.path && !t.paths.length) return { take: { ...t, paths: [r.path] } };
      if (s === 'stop_uncertain' && !r.active) return to(t, 'checking', 'T17', { endedAt: r.at });
      // T18 is saved on the take, so that the state line gives its text, also after a reconnect (F-T7-17, F-T7-31).
      if (s === 'stop_uncertain' && input.same === true) return take.row === 'T18' && t === take ? base : to(t, 'stop_uncertain', 'T18');
      if (s === 'stop_uncertain' && input.same === false) return { ...close(t, 'not_checked', 'T19'), spawn: true };
      if ((s === 'idle' || s === 'closed') && r.active) return { take, row: 'T22', spawn: true, notice: { id: 'X15', level: 'warning' } };
      return base;
    }

    case 'checked':
      return s === 'checking' ? close(take, input.result, 'T25', { summary: input.summary }) : same;

    case 'restart': {
      // A row keeps a take only on the recording that the journal names. A take is never attached to another
      // recording, which can be a recording that someone else started: it closes, and that recording gets its own take (F-T7-27).
      const r = input.reading;
      // P9: a take lost after the gone limit comes back when OBS answers again with the same recording (F-T7-59).
      if (take.marks.includes('lost') && (s === 'checking' || s === 'closed')) {
        if (!r.active || !input.same) return same;
        const marks = take.marks.filter((m) => m !== 'lost' && m !== 'offline');
        return to(take, r.paused ? 'paused' : 'recording', 'R3', { marks, result: undefined, summary: undefined, endedAt: undefined, offlineAt: undefined });
      }
      if (s === 'starting' || s === 'start_uncertain' || s === 'stop_held') {
        if (!r.active) return close(take, 'not_started', 'R2');
        // R1: no STARTED came before the crash, so no path ties this recording to the take.
        return { ...close(take, 'not_checked', 'R1'), spawn: true, ...(s === 'stop_held' ? { notice: { id: 'X18' as const, level: 'warning' as const } } : {}) };
      }
      if (s === 'checking') return to(take, 'checking', 'R8');
      if (isOpen(take) && r.active && !input.same) return { ...close(take, 'not_checked', STOPS.includes(s) ? 'T19' : 'R4'), spawn: true };
      if (s === 'recording' || s === 'paused') {
        if (!r.active) return { ...checking(take, 'R5', undefined, 'unplanned_stop'), notice: { id: 'X11', level: 'error' } };
        return to(take, r.paused ? 'paused' : 'recording', 'R3');
      }
      if (STOPS.includes(s)) return to(take, 'stop_uncertain', 'R6');
      // R7, and T23 when OBS records nothing now (F-T7-29).
      if (s === 'external') return r.active ? to(take, 'external', 'R7', { paths: withPath(take.paths, r.path) }) : checking(take, 'T23', input.at, 'external');
      return same;
    }
  }
}

// ---- Texts (section 7.2). Times are local clock times; durations are hh:mm:ss.

const p2 = (n: number) => String(Math.floor(n)).padStart(2, '0');
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
export const hms = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${p2(s / 3600)}:${p2((s / 60) % 60)}:${p2(s % 60)}`;
};
const minSec = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${p2(s % 60)} s` : `${s} s`;
};
/**
 * A name from OBS or from a client, ready to show (F-T7-12, F-T7-26, F-T7-30, F-T7-35): in a Markdown code span, so
 * that no link, image, tag or emphasis can form, and plain text stays readable. A backtick becomes the look-alike
 * U+02CB, so the name cannot end the span. Each invisible, control or bidi character shows as \u{HEX}. A long name keeps
 * its start and its end.
 */
export const shown = (name: string) => {
  const c = [...visible(name).replace(/`/g, '\u02CB')];
  return `\`${c.length > 120 ? `${c.slice(0, 80).join('')}…${c.slice(-39).join('')}` : c.join('')}\``;
};
/** The file name of a path, with / or \ as the separator, ready to show. */
export const fileName = (path?: string) => shown((path ? path.split(/[\\/]/).pop() : undefined) || 'unknown');

const STOP_OBS = 'In OBS, look at the Controls dock. If the button reads Stopping Recording..., wait. If it reads Stop Recording, click it.';
/** What OBS shows now, after a stop that did not go out (X4, X5, X17). A paused take does not record (F-T7-23). */
const still = (r: Reading) => (!r.active ? 'OBS shows no recording now.' : r.paused ? `It is still paused (${hms(r.duration)}).` : `It still records (${hms(r.duration)}).`);
/** The pointer to the expected sources. obs_preflight comes in T8 (F-T7-22). */
export const PREFLIGHT = 'To name them, run obs_preflight (in a later version).';

/** The texts of section 7.2. r is the read now; take is the take it is about. */
export const TEXT = {
  /** An unknown scene or folder shows as plain words, not as a name. */
  W1: (scene: string | undefined, sources: { name: string; track: number }[], folder?: string) =>
    `Start recording in OBS? Scene: ${scene ? shown(scene) : 'unknown'}. Expected sources: ${sources.length ? `${sources.map((x) => `${shown(x.name)} (track ${x.track})`).join(', ')}.` : `none. ${PREFLIGHT}`} The file goes to ${folder ? shown(folder) : 'the OBS recording folder'}. Everyone in the recording should know about it and agree. Accept to start. Decline to cancel.`,
  W2: () => 'Start a test recording in OBS? It records until you stop it. obs-mcp never stops it by itself, and it will remind you. Accept to start. Decline to cancel.',
  W3: (r: Reading) => `Stop the OBS recording? It has run ${hms(r.duration)}. File: ${fileName(r.path)}. OBS then finishes the file. This takes about 1 s. Accept to stop. Decline to keep recording.`,
  W4: (r: Reading) => `Stop the OBS recording? obs-mcp did not start this recording. It has run ${hms(r.duration)}. File: ${fileName(r.path)}. Accept to stop. Decline to keep recording.`,
  W5: (r: Reading) => `Stop the OBS recording? It is paused at ${hms(r.duration)}. File: ${fileName(r.path)}. Accept to stop. Decline to keep it paused.`,
  W6: (r: Reading) =>
    `The recording changed while you decided, so I did not stop it. Now OBS shows: running ${hms(r.duration)}, file ${fileName(r.path)}. This is not the recording you saw. Stop this recording? Accept to stop. Decline to keep recording.`,
  W8: (r: Reading) => `A test recording still runs (${hms(r.duration)}). obs-mcp does not stop it by itself. To stop it, ask me to stop the recording, or click Stop Recording in OBS.`,
  X1: 'I did not stop the recording. This client cannot show a confirm dialog, and obs-mcp stops a recording only after you confirm in one. To stop it: in OBS, click Stop Recording in the Controls dock. I will see the stop and check the file.',
  X2: 'I did not start a recording. This client cannot show a confirm dialog, and obs-mcp starts a recording only after you confirm in one. To start: in OBS, click Start Recording in the Controls dock. I will see the start, watch the sources and check the file.',
  X3: 'I did not send this change. It needs your confirmation, and this client cannot show a confirm dialog. You can make the change in OBS.',
  X4: (r: Reading) => `You declined. I did not stop the recording. ${still(r)}`,
  X5: (r?: Reading) => `No answer in 2 minutes. I did not stop the recording.${r ? ` ${still(r)}` : ''}`,
  /** ours: an obs-mcp take, of this process or another one (F-T7-15). */
  X6: (r: Reading, ours = false) =>
    `${r.paused ? `OBS already has a paused recording (paused at ${hms(r.duration)}, file ${fileName(r.path)}).` : `OBS already records (started ${clock(r.at - r.duration)}, file ${fileName(r.path)}).`} I did not send a start. ${ours ? 'obs-mcp started this recording.' : 'obs-mcp did not start this recording.'}`,
  /** P14 with no recording now: a record event came in the last 2 s (F-T7-15). */
  X6b: 'OBS started or stopped a recording in the last 2 s. I did not send a start. Ask again in a few seconds.',
  X7: 'OBS is still finishing the last recording. I did not send a start. Ask again in a few seconds.',
  X8: (t: Take) => `I sent the stop at ${clock(t.stopAt ?? 0)}, but OBS did not confirm it in ${LIMITS.stopMs / 1000} s. I will not send it again, because a second stop can cut the file short. ${STOP_OBS}`,
  X9: (t: Take) => `I sent the start at ${clock(t.intentAt ?? 0)}, but OBS did not confirm it in ${LIMITS.startMs / 1000} s. I will not send it again. OBS may still start. In OBS, look at the Controls dock: if the button reads Stop Recording, OBS records.`,
  /** recording: OBS recorded at the drop. Otherwise the text does not say that OBS records (F-T7-67). */
  X10: (at: number, recording = true) => `I lost the connection to OBS at ${clock(at)}.${recording ? ' OBS keeps recording on its own.' : ''} I reconnect, and I send no recording request.`,
  /** The connection dropped right after the stop went out (7.1, F-T7-17). */
  X10b: 'I lost the connection to OBS right after I sent the stop. I will not send it again. I reconnect and read what OBS shows.',
  /** The connection dropped right after the start went out (F-T7-67). */
  X10c: 'I lost the connection to OBS right after I sent the start. I will not send it again. OBS may still start. I reconnect and read what OBS shows.',
  /** The time is the last time that OBS surely recorded (F-T7-67); after a restart (R5) nobody knows it. */
  X11: (t: Take) => `The recording stopped ${t.endedAt === undefined ? 'while I did not watch it' : `at about ${clock(t.endedAt).slice(0, 5)}`}, and nobody asked for it. OBS may show an error dialog. I am checking the file that OBS wrote: ${fileName(t.paths.at(-1))}.`,
  X12: (t: Take) => `The recording was stopped in OBS at ${clock(t.endedAt ?? 0)}. I am checking the file.`,
  /** recording: a take that records. Otherwise the text does not say that OBS records (F-T7-67). */
  X14: (recording = true) => (recording ? 'obs-mcp is closing. OBS keeps recording. I did not stop it.' : 'obs-mcp is closing. I did not send a stop.'),
  X15: (r: Reading, sources: string[]) =>
    `OBS started a recording at ${clock(r.at - r.duration)} (file ${fileName(r.path)}). obs-mcp did not start it, and it does not stop it. ${sources.length ? `I watch ${list(sources)}, and I check the file when it ends.` : `I check the file when it ends. No expected sources. ${PREFLIGHT}`}`,
  /** G32: a process that does not control recording. One text for every recording request. */
  X16: 'I did not send it. Another obs-mcp copy controls recording in this OBS, and this copy only reads. To start or stop, click Start Recording or Stop Recording in the Controls dock of OBS.',
  X17: (r: Reading) => `That confirm expired after 2 minutes, so I did not stop the recording. ${still(r)}${r.active ? ' Ask me again to stop it.' : ''}`,
  /** A second change after W6: the recording changed each time. */
  X19: 'The recording changed each time you decided, so I did not stop it. To stop it, click Stop Recording in the Controls dock of OBS.',
  /** OBS gave no file path, so no stop can pass check 3 (F-T7-55). */
  X20: 'I did not stop the recording. OBS gives me no file path for it, so I cannot tell that it is the recording you saw. To stop it, click Stop Recording in the Controls dock of OBS.',
  /** A file error of the journal: only its code, because the message names the folder (F-T7-38, F-T7-41). */
  J1: (code: string) => `I could not write the take record on this computer (${code}).`,
  X18: (r: Reading) => `A recording started in OBS after you asked me to stop (running ${hms(r.duration)}, file ${fileName(r.path)}). I did not stop it. To stop it, ask me again, or click Stop Recording in OBS.`,
};

const list = (raw: string[]) => {
  const names = raw.map(shown);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

/** The state line: the first line of each tool reply about a take (section 1). r is the last read; now is the clock. */
export function stateLine(take: Take | undefined, r: Reading | undefined, now: number): string {
  if (!take || take.state === 'idle') return 'OBS is not recording.';
  const d = hms(r?.duration ?? 0);
  const file = fileName(take.paths.at(-1) ?? r?.path);
  let line: string;
  switch (take.state) {
    case 'starting':
      line = `I asked OBS to start at ${clock(take.intentAt ?? now)}. Waiting for OBS to confirm.`;
      break;
    case 'start_uncertain':
      // The row of the drop: T3 with the offline mark (F-T7-67). A later drop is O1, and keeps the X10 line.
      if (take.row === 'T3' && take.marks.includes('offline')) return TEXT.X10c + (take.kind === 'test' ? TEST_MARK : '');
      line = TEXT.X9(take);
      break;
    case 'stop_held':
      line = 'OBS has not started the recording. I hold your stop for 30 s. If a recording starts, I tell you, and you can ask me again to stop it.';
      break;
    case 'recording':
      line = `Recording for ${d} (OBS confirmed it). File: ${file}.`;
      break;
    case 'paused':
      line = `The recording is paused at ${d}, for ${minSec(now - (take.pausedAt ?? now))} now. Nothing goes into the file.`;
      break;
    case 'external':
      line = `OBS is recording (${d}, file ${file}), but obs-mcp did not start this recording. I do not stop it unless you ask.`;
      break;
    case 'stopping':
      line = `I asked OBS to stop at ${clock(take.stopAt ?? now)}. OBS is finishing the file.`;
      break;
    case 'stop_uncertain':
      // The row of the drop: T16 with the offline mark. A later drop is O1, and keeps the X10 line.
      if (take.row === 'T16' && take.marks.includes('offline')) return TEXT.X10b;
      // T18: a read shows the same recording still active (7.1).
      line = take.row === 'T18' ? `OBS still records (${d}). I will not send a second stop. In OBS, click Stop Recording in the Controls dock.` : TEXT.X8(take);
      break;
    case 'checking':
      line =
        take.row === 'T15' && !take.marks.includes('stopped_in_obs') ? `The recording stopped at ${clock(take.endedAt ?? now)} (OBS confirmed it). I am checking the file ${file}.`
        : take.row === 'T17' ? `OBS shows no recording now, so the stop is done. I am checking the file ${file}.`
        : take.marks.includes('unplanned_stop') || take.marks.includes('lost') ? TEXT.X11(take)
        : take.marks.includes('stopped_in_obs') || take.row === 'T20' ? TEXT.X12(take)
        : `OBS shows no recording now. I am checking the file ${file}.`;
      break;
    case 'closed':
      line = `Take closed: ${take.result}.${take.summary ? ` ${take.summary}` : (CLOSED[take.row ?? '']?.(take) ?? '')}`;
      break;
  }
  if (take.marks.includes('offline') && isOpen(take)) line = `${TEXT.X10(take.offlineAt ?? now, RECORDS.includes(take.state))} ${line}`;
  if (take.kind === 'test' && isOpen(take) && !STOPS.includes(take.state) && take.state !== 'checking') line += TEST_MARK;
  return line;
}

/** The test mark of the state line, until the take stops. A reply with W8 leaves it out, because W8 says the same (F-T7-33). */
export const TEST_MARK = ' This is a test recording. obs-mcp does not stop it by itself.';

/** What happened to the old file of a take that a new recording replaced (F-T7-51). */
const oldFile = (t: Take) =>
  t.paths.length ? `I did not check its file ${fileName(t.paths.at(-1))}. To check it, run obs_verify_file with this file name.` : 'I do not know the name of its file, so I did not check it.';
const CLOSED: Record<string, (t: Take) => string> = {
  T6: () => ' OBS did not start the recording in 30 s. Look in OBS for an error dialog.',
  T7: () => ' OBS did not start the recording. OBS gives no reason, so look in the OBS log.',
  T12: () => ' OBS did not start a recording while I held your stop. A later recording is reported and never stopped by me.',
  T19: (t) => ` The recording that I stopped at ${clock(t.stopAt ?? 0)} has ended, and OBS records a new one now. I sent the stop once. ${oldFile(t)}`,
  T24: (t) => ` The take that I followed ended while I could not reach OBS, and OBS records a new one now. ${oldFile(t)}`,
  R1: () => ' OBS records, but I cannot tell if it is the start that I sent, so this take ends here.',
  R2: () => ' OBS shows no recording, so the start did not happen.',
  R4: (t) => ` The take that I followed ended while obs-mcp was not running, and OBS records a new one now. ${oldFile(t)}`,
};
