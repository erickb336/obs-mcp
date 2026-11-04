// The take driver: it feeds OBS events, reads, timers and the tools into the pure state machine (take.ts), writes
// each step to the journal (journal.ts) before any recording request, and runs the watch, the reminders and the file
// check. One driver per process, outside the MCP server factory (E21).
// The rules it keeps: the intent is on disk before a send (rule 1); each intent sends once (rule 2); only a stop
// request with your consent sends StopRecord (rule 3); only the controlling process writes or sends (rule 7, G32).
import { createHash, randomBytes } from 'node:crypto';
import { Journal, type Source } from './journal.js';
import { Obs, ObsError, type ObsEvent } from './obs.js';
import { clock, fileName, hms, isOpen, journalReading, newTake, RECORDS, sameRecording, stateLine, step, TEST_MARK, TEXT, type Input, type Limits, type Reading, type Step, type Take } from './take.js';

/** The file check of a take: its result and one line for the reply. */
export type Check = (path: string, sources: Source[]) => Promise<{ result: 'verified' | 'verified_with_warnings' | 'failed' | 'not_checked'; summary: string }>;
type Open = { take: Take; sources: Source[]; tokenHash?: string; timers: NodeJS.Timeout[]; reading?: Reading; gone?: NodeJS.Timeout; unsaved?: boolean };

/** The longest path that a file call takes (PATH_MAX of Linux). A longer path from OBS names no file, so it counts as no path, and the journal holds every path it keeps (F-T7-40). */
const MAX_PATH = 4096;
const pathOf = (v: unknown) => (typeof v === 'string' && v && Buffer.byteLength(v) <= MAX_PATH ? v : undefined);
/** The code of a file system error, such as EACCES. The message names the folder, so a reply gives only the code (F-T7-41). */
export const fsCode = (e: unknown) => {
  const code = (e as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : undefined;
};

/** The states in which a test take gets reminder W8 (O4). */
const reminds = (t: Take) => t.state === 'recording' || t.state === 'paused';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const STATES: Record<string, 'STARTED' | 'STOPPING' | 'STOPPED' | 'PAUSED' | 'RESUMED'> = {
  OBS_WEBSOCKET_OUTPUT_STARTED: 'STARTED',
  OBS_WEBSOCKET_OUTPUT_STOPPING: 'STOPPING',
  OBS_WEBSOCKET_OUTPUT_STOPPED: 'STOPPED',
  OBS_WEBSOCKET_OUTPUT_PAUSED: 'PAUSED',
  OBS_WEBSOCKET_OUTPUT_RESUMED: 'RESUMED',
};

export class Takes {
  /** The takes this process follows. Only the controlling process follows a take (G32). */
  private open = new Map<string, Open>();
  /** The notices that wait for the next tool reply. A keyed notice replaces the waiting one with the same key. */
  private notices: { text: string; key?: string }[] = [];
  private ev = new Map<number, number>();
  private lastEventAt?: number;
  /** The newest read of this process. */
  private latest?: Reading;
  /** Takes whose restart row waits for a read of OBS: the open takes of the journal when this process becomes the controller, and a take lost at the gone limit (P9). */
  private waiting = new Map<string, Open>();
  private seq = 0;
  /** The last take that closed in this process, for obs_take_status. */
  last?: Take;
  /** The takes that closed in this process. A failed write can leave such a take open on disk: it is not open (F-T7-38). */
  private done = new Set<string>();
  private journalOpen = () => this.journal.openTakes().filter((id) => !this.done.has(id));
  private waiters = new Set<() => void>();
  /** Notice sink: a log notification to the client. Set by the server. */
  notify: (level: 'warning' | 'error', text: string) => void = () => {};

  constructor(
    readonly obs: Obs,
    readonly journal: Journal,
    readonly limits: Limits,
    private check: Check,
    /** The controller lock: only its holder follows takes and sends (G32). error says why a reader cannot confirm control. */
    readonly lock: { readonly held: boolean; readonly error?: string } = { held: true },
  ) {
    obs.onEvent((e) => this.onEvent(e));
  }

  // ---- Notices (rule 6): a log notification now, and the same text at the top of the next tool reply, once.

  notice(text: string, level: 'warning' | 'error' = 'warning', key?: string) {
    if (key) this.notices = this.notices.filter((n) => n.key !== key);
    this.notices.push({ text, key });
    this.notify(level, text);
  }

  /**
   * The reply of a tool: the waiting notices first, then the lines. A test take that has recorded for the first
   * reminder time adds reminder W8 once, at the top, where the W8 notice goes too (O4, F-T7-21, F-T7-53). Before that
   * time the state line keeps the test mark. W8 says what the mark says, so the state line then leaves it out (F-T7-33).
   */
  reply(...lines: string[]): string {
    const top = this.notices.splice(0);
    let w8 = top.some((n) => n.key === 'W8');
    for (const o of this.open.values()) {
      if (!w8 && o.take.kind === 'test' && reminds(o.take) && o.reading && Date.now() - (o.take.startedAt ?? Date.now()) >= this.limits.reminderFirstMs) {
        top.push({ text: TEXT.W8(this.newest(o.reading)) });
        w8 = true;
      }
    }
    return [...top.map((n) => n.text), ...(w8 ? lines.map((l) => l.replace(TEST_MARK, '')) : lines)].join('\n');
  }

  /** The newer of a take's reading and the last read of this process, while OBS records (F-T7-19). */
  private newest(r: Reading): Reading {
    return this.latest?.active && this.latest.at > r.at ? this.latest : r;
  }

  // ---- Reads

  /** GetRecordStatus and, while active, the path field of the file output (check 3), both on one connection. */
  async read(): Promise<Reading> {
    const { data, conn } = await this.obs.read('GetRecordStatus');
    const r: Reading = {
      at: Date.now(),
      conn,
      ev: this.ev.get(conn) ?? 0,
      active: data.outputActive === true,
      paused: data.outputPaused === true,
      duration: Number(data.outputDuration) || 0,
      bytes: Number(data.outputBytes) || 0,
    };
    if (r.active) r.path = await this.filePath(conn);
    this.latest = r;
    return r;
  }

  /**
   * F10: the path of the active output that writes a file: an encoded output that sends to no service, with a string
   * path in its settings. The kind does not count: OBS 33 records hybrid MOV through mov_output, Advanced mode through
   * ffmpeg_muxer, and other formats through other kinds (F-T7-36, R210). Only an active output counts, because the path
   * keeps the last file after the stop (R210). Only the path field is kept; the rest of each reply is dropped here.
   */
  private async filePath(conn: number): Promise<string | undefined> {
    try {
      const list = (await this.obs.callOn(conn, 'GetOutputList')).outputs;
      for (const o of Array.isArray(list) ? list : []) {
        const flags = (o?.outputFlags ?? {}) as Record<string, unknown>;
        if (o?.outputActive !== true || typeof o.outputName !== 'string' || flags.OBS_OUTPUT_ENCODED !== true || flags.OBS_OUTPUT_SERVICE === true) continue;
        const path = pathOf(((await this.obs.callOn(conn, 'GetOutputSettings', { outputName: o.outputName })).outputSettings as { path?: unknown } | undefined)?.path);
        if (path) return path;
      }
    } catch {
      // No path: check 3 fails, to the safe side.
    }
    return undefined;
  }

  private async tryRead(): Promise<Reading | undefined> {
    try {
      return await this.read();
    } catch (e) {
      if (e instanceof ObsError) return undefined;
      throw e;
    }
  }

  // ---- Steps

  /** Runs one input on one owned take: journal first, then the effects. Returns the step. */
  private apply(o: Open, input: Input): Step {
    const s = step(o.take, input);
    if (input.type === 'read' || input.type === 'restart' || input.type === 'stop') o.reading = input.reading;
    if (s.take === o.take && !s.row) return s;
    const before = o.take.state;
    const changed = s.take !== o.take;
    o.take = s.take;
    if (changed) this.write(o);
    if (s.notice?.id === 'X11') this.notice(TEXT.X11(o.take), s.notice.level);
    // T19, T24, R1 and R4 close the take for a new recording: its closed line names the old file (F-T7-51), before X15.
    if (changed && s.spawn && o.take.state === 'closed') this.notice(stateLine(o.take, undefined, Date.now()));
    if (s.notice?.id === 'X18') void this.x18(input);
    if (s.row === 'E10') this.notice('OBS already recorded when my start arrived. Your stop applied to that recording.');
    if (s.spawn) void this.openExternal(input.type === 'event' ? undefined : (input as { reading?: Reading }).reading);
    if (o.take.state !== before) this.entered(o);
    for (const w of this.waiters) w();
    return s;
  }

  /** X18 with the recording that runs now: an event has no reading, so it reads (F-T7-19). X15 comes from openExternal. */
  private async x18(input: Input) {
    const r = (input as { reading?: Reading }).reading ?? (await this.tryRead());
    this.notice(TEXT.X18(r ?? { at: Date.now(), conn: 0, ev: 0, active: true, paused: false, duration: 0, bytes: 0 }));
  }

  /**
   * The state line of a step. A file error (a full disk, a file that cannot be written) does not stop the take: the
   * step is what OBS did, so its effects run, and you get one notice (F-T7-38). The intents are written before their
   * sends, and a failed intent sends nothing.
   */
  private write(o: Open) {
    try {
      this.journal.state(o.take.id, o.take);
    } catch (e) {
      if (!fsCode(e)) throw e;
      if (!o.unsaved) this.notice(TEXT.J1(fsCode(e)!), 'error');
      o.unsaved = true;
    }
  }

  /** Stops all work on a take that this process does not follow. */
  private release(o: Open) {
    for (const t of o.timers) clearTimeout(t);
    clearTimeout(o.gone);
    this.open.delete(o.take.id);
  }

  private every(o: Open, ms: number, fn: () => void) {
    const t = setInterval(fn, ms);
    t.unref?.();
    o.timers.push(t);
  }

  /** What a state starts: the timers of section 4, the watch and the file check. */
  private entered(o: Open) {
    for (const t of o.timers) clearTimeout(t);
    o.timers = [];
    const L = this.limits;
    const once = (ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      o.timers.push(t);
    };
    const s = o.take.state;
    // A waiting W8 says that the test recording runs: it goes when the take stops (F-T7-33).
    if (!reminds(o.take)) this.notices = this.notices.filter((n) => n.key !== 'W8');
    if (s === 'start_uncertain' || s === 'stop_held') {
      this.every(o, L.holdReadMs, () => void this.tick(o));
      once(L.holdMs, () => this.apply(o, { type: 'timeout', phase: 'hold', at: Date.now() }));
    }
    if (s === 'stop_uncertain') this.every(o, L.stopReadMs, () => void this.tick(o));
    if (s === 'recording' || s === 'paused' || s === 'external') {
      this.every(o, L.beatMs, () => void this.tick(o));
      if (o.take.kind === 'test') {
        // The reminder reads OBS, so that it gives the time now (F-T7-19).
        const remind = async () => {
          const now = (await this.tryRead()) ?? o.reading;
          if (this.open.get(o.take.id) === o && now?.active) this.notice(TEXT.W8(now), 'warning', 'W8');
        };
        once(Math.max(0, (o.take.startedAt ?? Date.now()) + L.reminderFirstMs - Date.now()), () => {
          void remind();
          this.every(o, L.reminderMs, () => void remind());
        });
      }
    }
    if (s === 'checking') void this.runCheck(o);
    if (s === 'closed') {
      clearTimeout(o.gone);
      this.open.delete(o.take.id);
      this.done.add(o.take.id);
      this.last = o.take;
      this.journal.prune();
      if (!this.open.size && !this.waiting.size) this.obs.keepConnected(false);
    }
  }

  /** One watch read. */
  private async tick(o: Open) {
    const r = await this.tryRead();
    if (r && !this.ended && this.open.get(o.take.id) === o) this.observe(o, r);
  }

  /**
   * A read on a take. In stop_uncertain, and on the first read of each new connection, the 5 checks of the
   * same-recording test decide if OBS still records the take's recording (T18, T19, T24; F-T7-59, F-T7-65).
   */
  private observe(o: Open, r: Reading) {
    const s = o.take.state;
    const test = r.active && (s === 'stop_uncertain' || (RECORDS.includes(s) && o.reading?.conn !== r.conn));
    const prevAt = o.reading?.active ? o.reading.at : undefined;
    this.apply(o, { type: 'read', reading: r, same: test ? this.same(o, r) : undefined, prevAt });
  }

  /** The same-recording test against the last read that showed the take, or else the STARTED event in the journal. No reading A fails it, to the safe side. */
  private same(o: Open, r: Reading): boolean {
    const a = o.reading?.active ? o.reading : journalReading(o.take);
    return !!a && sameRecording(a, r, o.take.paths);
  }

  private async runCheck(o: Open) {
    const path = o.take.paths.at(-1);
    let out: Awaited<ReturnType<Check>>;
    try {
      out = path ? await this.check(path, o.sources) : { result: 'not_checked', summary: 'The file path is not known, so I did not check a file.' };
    } catch {
      // The reason can name the folder; obs_verify_file gives it in full (F-T7-25).
      out = { result: 'not_checked', summary: `I could not check the file ${fileName(path)}. obs_verify_file with this file name gives the reason.` };
    }
    if (this.open.get(o.take.id) === o) this.apply(o, { type: 'checked', ...out });
  }

  // ---- OBS events

  private onEvent(e: ObsEvent) {
    if (e.type === 'opened') {
      // A connection is up: the waiting restart rows run (F-T7-3), and each take reads at once, so that the offline
      // mark ends with the reconnect (F-T7-16). The gone limit of the drop ends too: a later drop starts its own (F-T7-37).
      if (!this.lock.held) return;
      void this.restartWaiting();
      for (const o of this.open.values()) {
        clearTimeout(o.gone);
        if (!this.waiting.has(o.take.id)) void this.tick(o);
      }
      return;
    }
    if (e.type === 'closed') {
      for (const o of this.open.values()) {
        const s = this.apply(o, { type: 'disconnect', at: Date.now() });
        if (s.row === 'O1' && (o.take.state === 'recording' || o.take.state === 'paused')) {
          clearTimeout(o.gone);
          o.gone = setTimeout(() => this.gone(o), this.limits.goneMs);
          o.gone.unref?.();
        }
      }
      return;
    }
    if (e.type === 'ExitStarted') {
      for (const o of this.open.values()) this.apply(o, { type: 'exit', at: Date.now() });
      return;
    }
    if (e.type === 'RecordFileChanged') {
      const path = pathOf(e.data.newOutputPath);
      if (path) for (const o of this.open.values()) this.apply(o, { type: 'file', path });
      return;
    }
    const state = STATES[String(e.data.outputState)];
    if (!state) return;
    const at = Date.now();
    if (state === 'STARTED' || state === 'STOPPING' || state === 'STOPPED') {
      this.ev.set(e.conn, (this.ev.get(e.conn) ?? 0) + 1);
      this.lastEventAt = at;
    }
    if (!this.lock.held) return;
    // The state name gives the state. PAUSED comes with outputActive false, but the output stays active (R210).
    const path = pathOf(e.data.outputPath);
    if (state === 'STARTED' && !this.open.size) {
      void this.openExternal(undefined);
      return;
    }
    for (const o of [...this.open.values()]) this.apply(o, { type: 'event', state, at, path });
  }

  /**
   * P9: OBS gave no answer for the gone limit. The take is lost (T21), and its restart row waits for OBS: when OBS
   * answers with the same recording, the take comes back (R3, F-T7-59).
   */
  private gone(o: Open) {
    if (this.obs.connected || this.open.get(o.take.id) !== o) return;
    this.apply(o, { type: 'timeout', phase: 'gone', at: Date.now() });
    if (o.take.marks.includes('lost')) this.waiting.set(o.take.id, o);
  }

  /** T22 and the spawn rows: open an external take, watched at once (F13), with the expected sources of the last preflight (E27). */
  private async openExternal(given?: Reading) {
    if (!this.lock.held) return;
    // A read from before the last record event can show a recording that has ended since: read again.
    const r = given?.active && given.at >= (this.lastEventAt ?? 0) ? given : await this.tryRead();
    if (!r?.active || this.ended || this.waiting.size) return; // a waiting take may be this recording: its restart row decides
    if ([...this.open.values()].some((o) => isOpen(o.take) && o.take.state !== 'checking' && o.take.state !== 'stopping' && o.take.state !== 'stop_uncertain')) return;
    // A new id for each take: a recording on the path of a closed take gets its own take (F-T7-62).
    const id = randomBytes(8).toString('hex');
    const take: Take = { ...newTake(id, 'external', 'external'), row: 'T22', startedAt: r.at - r.duration, startBytes: r.bytes, paths: r.path ? [r.path] : [] };
    const o: Open = { take, sources: this.lastSources, timers: [], reading: r };
    try {
      this.journal.append(id, { t: 'open', v: 1, id, kind: 'external', pid: process.pid, obs: this.obs.version?.obsVersion, ws: this.obs.version?.obsWebSocketVersion });
      if (o.sources.length) this.journal.append(id, { t: 'expect', sources: o.sources });
      this.journal.state(id, take);
    } catch (e) {
      if (!fsCode(e)) throw e;
      // The recording goes on, unfollowed. It sends nothing either way.
      return this.notice(TEXT.J1(fsCode(e)!), 'error');
    }
    this.open.set(id, o);
    this.obs.keepConnected(true);
    this.notice(TEXT.X15(r, o.sources.map((s) => s.name)));
    this.entered(o);
  }

  /** E27: the expected sources of the last obs_preflight of this process. obs_preflight (T8a) sets them; none until then. */
  lastSources: Source[] = [];

  // ---- The controller start (D4, G32): the journal has an open take

  /**
   * When this process becomes the controller (at the server start, or at a tool call after the old controller
   * exited), it follows each open take of the journal, and applies R1 to R8 when OBS answers. Sends no recording request.
   */
  async resume() {
    for (const id of this.journal.openTakes()) {
      if (this.open.has(id) || this.done.has(id) || this.ended) continue;
      const l = this.journal.load(id);
      if (!l) continue;
      const o: Open = { take: l.take, sources: l.sources, timers: [], tokenHash: l.recs.findLast((x) => x.t === 'intent' && x.what === 'start')?.token as string | undefined };
      this.open.set(id, o);
      this.waiting.set(id, o);
    }
    if (!this.waiting.size || this.ended) return;
    this.obs.keepConnected(true);
    await this.restartWaiting();
  }

  /** The restart rows of the waiting takes, after one read. With OBS unreachable, they run when a connection opens (F-T7-3). */
  private async restartWaiting() {
    if (!this.waiting.size) return;
    const r = await this.tryRead();
    if (!r || this.ended) return;
    for (const [id, o] of [...this.waiting]) {
      this.waiting.delete(id);
      const same = r.active && this.same(o, r);
      // A lost take that closed comes back only on its own recording (P9).
      if (this.open.get(id) !== o) {
        if (!same) continue;
        this.open.set(id, o);
        this.done.delete(id);
      }
      const before = o.take.state;
      const s = this.apply(o, { type: 'restart', reading: r, same, at: Date.now() });
      const file = `${hms(r.duration)}, file ${fileName(o.take.paths.at(-1))}`;
      if (s.row === 'R3') this.notice(r.paused ? `The take that I started is still paused in OBS (${file}). I watch it again from ${clock(Date.now())}.` : `OBS still records the take that I started (${file}). I watch it again from ${clock(Date.now())}.`); // F-T7-45
      if (s.row === 'R3' && o.take.kind === 'test') this.notice(TEXT.W8(r), 'warning', 'W8');
      if (s.row && o.take.state === before) this.entered(o); // R3, R7 and R8 keep the state: the watch or the check starts again
    }
    if (!this.open.size) this.obs.keepConnected(false);
    if (r.active && !this.open.size) void this.openExternal(r);
  }

  // ---- The tools' steps

  /** The take that a tool is about: one that this process follows, or, in a reader, the open take of the journal (G32). */
  current(): Take | undefined {
    if (!this.lock.held) {
      const id = this.journal.openTakes()[0];
      return id ? this.journal.load(id)?.take : undefined;
    }
    const mine = [...this.open.values()].filter((o) => isOpen(o.take));
    return (mine.find((o) => o.take.state !== 'checking') ?? mine[0])?.take;
  }

  byToken(token: string): Take | undefined {
    const h = sha(token);
    return [...this.open.values()].find((o) => o.tokenHash === h && isOpen(o.take))?.take;
  }

  lastReading(id?: string) {
    const r = id ? this.open.get(id)?.reading : undefined;
    return r && this.newest(r);
  }

  /** P14 and T1 before a start: the refusal text, or undefined to allow (X6, X6b, X7; F-T7-15). */
  refusal(r: Reading): string | undefined {
    const cur = this.current() ?? newTake('none', 'normal', 'idle');
    const refuse = step(cur, { type: 'start', at: Date.now(), reading: r, lastEventAt: this.lastEventAt }).refuse;
    if (!refuse) return undefined;
    // A stop that OBS did not confirm: the state line says what to do in OBS (F-T7-50).
    if (refuse === 'X7') return cur.state === 'stop_uncertain' ? `${stateLine(cur, r, Date.now())} I did not send a start.` : TEXT.X7;
    if (r.active) return TEXT.X6(r, isOpen(cur) && cur.kind !== 'external');
    return isOpen(cur) ? `${stateLine(cur, r, Date.now())} I did not send a start.` : TEXT.X6b;
  }

  /**
   * T1: after your consent, journal the intent with a sync, send StartRecord once on the connection of the read, and
   * wait up to 5 s for STARTED (P3). Returns the take, or a refusal text when nothing was sent. Only the controlling
   * process gets here (G32), and the refusal and the step run in one tick, so two accepts send one start.
   */
  async start(token: string, kind: 'normal' | 'test', consentId: string, r: Reading): Promise<{ take?: Take; text?: string }> {
    if (!this.lock.held) return { text: TEXT.X16('start', this.lock.error) };
    const refused = this.refusal(r);
    if (refused) return { text: refused };
    if (r.conn !== this.obs.connection || !this.obs.connected) return { text: 'The connection to OBS changed after your answer, so I did not send the start. Ask me again to start it.' };
    const id = randomBytes(8).toString('hex');
    const o: Open = { take: newTake(id, kind), sources: this.lastSources, tokenHash: sha(token), timers: [], reading: r };
    try {
      this.journal.append(id, { t: 'open', v: 1, id, kind, pid: process.pid, obs: this.obs.version?.obsVersion, ws: this.obs.version?.obsWebSocketVersion });
      if (o.sources.length) this.journal.append(id, { t: 'expect', sources: o.sources });
      this.journal.append(id, { t: 'intent', what: 'start', at: Date.now(), token: o.tokenHash, consent: consentId });
      this.open.set(id, o);
      this.apply(o, { type: 'start', at: Date.now(), reading: r });
      this.journal.append(id, { t: 'sent', request: 'StartRecord', seq: ++this.seq, conn: r.conn, at: Date.now() });
    } catch (e) {
      this.release(o);
      if (fsCode(e)) return { text: 'I could not save the take record, so I did not send the start.' };
      throw e;
    }
    this.obs.keepConnected(true);
    return { take: await this.send(o, 'StartRecord', r.conn, 'starting', this.limits.startMs, 'start') };
  }

  /**
   * T9, T10 and T14, after your consent and the same-recording test: journal the stop intent with a sync, send
   * StopRecord once on the connection of read B, and wait up to 15 s for STOPPED (P5). A second stop finds the open
   * stop and sends nothing (O7).
   */
  async stop(id: string, b: Reading, consentId: string | undefined, shown: Reading | undefined): Promise<{ take: Take; text?: string }> {
    const o = this.open.get(id);
    if (!o) throw new Error('no such take');
    if (!this.lock.held) return { take: o.take, text: TEXT.X16('stop', this.lock.error) };
    const s = step(o.take, { type: 'stop', reading: b });
    if (!s.send) {
      this.apply(o, { type: 'stop', reading: b });
      return { take: o.take };
    }
    // Journal the intent before the step, in the same tick, so that a parallel accept finds the open stop (rule 5).
    // With no intent on disk, nothing is sent (rule 1), and the reply gives the error code only (F-T7-41).
    try {
      this.journal.append(id, { t: 'intent', what: 'stop', at: Date.now(), consent: consentId, duration: shown?.duration, path: shown?.path, bytes: shown?.bytes });
    } catch (e) {
      if (fsCode(e)) return { take: o.take, text: `${TEXT.J1(fsCode(e)!)} So I did not send the stop.` };
      throw e;
    }
    this.apply(o, { type: 'stop', reading: b });
    try {
      this.journal.append(id, { t: 'sent', request: 'StopRecord', seq: ++this.seq, conn: b.conn, at: Date.now() });
    } catch {
      // The intent is on disk; this line only records the send.
    }
    return { take: await this.send(o, 'StopRecord', b.conn, 'stopping', this.limits.stopMs, 'stop') };
  }

  /**
   * Sends one recording request, never again, and waits while the take stays in state, up to ms. A reply code goes to
   * the state machine whenever it comes (T8, T15, T16, E10); a lost connection while waiting is T3 or T16. Returns the
   * take as it was when the wait ended, so that the reply is about that moment (the file check may end soon after).
   */
  private async send(o: Open, request: 'StartRecord' | 'StopRecord', conn: number, state: string, ms: number, phase: 'start' | 'stop'): Promise<Take> {
    const record = (code: number) => {
      try {
        this.journal.append(o.take.id, { t: 'reply', request, code, at: Date.now() });
      } catch {
        // A full journal does not change what OBS did.
      }
    };
    // An OBS code goes to the state machine. No reply on a live connection is not a step: the take waits for its own
    // limit (P3, P5), so that X8 and X9 name the time that passed (F-T7-28), and no text says "I lost the connection".
    this.obs.callOn(conn, request).then(
      () => record(100),
      (e) => {
        const code = (e as { code?: number }).code;
        if (code !== undefined && code >= 200 && code < 1000) {
          record(code);
          this.apply(o, { type: 'reply', request, code, at: Date.now() });
        } else if (o.take.state === state && !this.obs.connected) this.apply(o, { type: 'disconnect', at: Date.now() });
      },
    );
    const seen = await this.until(() => o.take.state !== state, ms, () => o.take);
    if (seen) return seen;
    if (o.take.state === state) this.apply(o, { type: 'timeout', phase, at: Date.now() });
    return o.take;
  }

  /** Resolves with snap() at the moment test() holds, or undefined after ms. */
  private until<T>(test: () => boolean, ms: number, snap: () => T): Promise<T | undefined> {
    return new Promise((resolve) => {
      if (test()) return resolve(snap());
      const w = () => test() && fin(snap());
      const timer = setTimeout(() => fin(undefined), ms);
      const fin = (v: T | undefined) => {
        clearTimeout(timer);
        this.waiters.delete(w);
        resolve(v);
      };
      this.waiters.add(w);
    });
  }

  /** Opens an external take for a recording that runs now with no take (T22 at a tool call). */
  adopt(r: Reading) {
    return this.openExternal(r);
  }

  /** O2: the client closed input. Nothing is sent; the journal keeps each take. A read still in flight changes nothing after this. */
  close() {
    this.ended = true;
    for (const o of this.open.values()) for (const t of [...o.timers, o.gone]) clearTimeout(t);
    this.open.clear();
    this.waiting.clear();
  }
  private ended = false;

  get hasOpen() {
    return this.open.size > 0;
  }

  /** Whether a take that this process follows records or is paused now (X14). */
  get recording(): 'recording' | 'paused' | undefined {
    const states = [...this.open.values()].map((o) => o.take.state);
    return states.some((s) => s === 'recording' || s === 'external') ? 'recording' : states.includes('paused') ? 'paused' : undefined;
  }
}
