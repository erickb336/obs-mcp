// The take driver: it feeds OBS events, reads, timers and the tools into the pure state machine (take.ts), writes
// each step to the journal (journal.ts) before any recording request, and runs the watch, the reminders and the file
// check. One driver per process, outside the MCP server factory (E21).
// The rules it keeps: the intent is on disk before a send (rule 1); each intent sends once (rule 2); only a stop
// request with your consent sends StopRecord (rule 3); only the owner process writes or sends (rule 7, G29).
import { createHash, randomBytes } from 'node:crypto';
import { FencedError, Journal, type Source } from './journal.js';
import { Obs, ObsError, type ObsEvent } from './obs.js';
import { clock, fileName, hms, isOpen, journalReading, newTake, sameRecording, stateLine, step, TEXT, type Input, type Limits, type Reading, type Step, type Take } from './take.js';

/** The file check of a take: its result and one line for the reply. */
export type Check = (path: string, sources: Source[]) => Promise<{ result: 'verified' | 'verified_with_warnings' | 'failed' | 'not_checked'; summary: string }>;
type Open = { take: Take; client: string; sources: Source[]; tokenHash?: string; timers: NodeJS.Timeout[]; reading?: Reading };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const STATES: Record<string, 'STARTED' | 'STOPPING' | 'STOPPED' | 'PAUSED' | 'RESUMED'> = {
  OBS_WEBSOCKET_OUTPUT_STARTED: 'STARTED',
  OBS_WEBSOCKET_OUTPUT_STOPPING: 'STOPPING',
  OBS_WEBSOCKET_OUTPUT_STOPPED: 'STOPPED',
  OBS_WEBSOCKET_OUTPUT_PAUSED: 'PAUSED',
  OBS_WEBSOCKET_OUTPUT_RESUMED: 'RESUMED',
};

export class Takes {
  /** The takes this process owns and follows. */
  private open = new Map<string, Open>();
  /** The notices that wait for the next tool reply. A keyed notice replaces the waiting one with the same key. */
  private notices: { text: string; key?: string }[] = [];
  private ev = new Map<number, number>();
  private lastEventAt?: number;
  /** The newest read of this process. */
  private latest?: Reading;
  /** Takes taken over at a server start whose restart row waits for a read of OBS, with the time of their last beat. */
  private waiting = new Map<string, number>();
  private seq = 0;
  /** The last take that closed in this process, for obs_take_status. */
  last?: Take;
  private waiters = new Set<() => void>();
  /** Notice sink: a log notification to the client. Set by the server. */
  notify: (level: 'warning' | 'error', text: string) => void = () => {};

  constructor(
    readonly obs: Obs,
    readonly journal: Journal,
    readonly limits: Limits,
    private check: Check,
  ) {
    obs.onEvent((e) => this.onEvent(e));
  }

  // ---- Notices (rule 6): a log notification now, and the same text at the top of the next tool reply, once.

  notice(text: string, level: 'warning' | 'error' = 'warning', key?: string) {
    if (key) this.notices = this.notices.filter((n) => n.key !== key);
    this.notices.push({ text, key });
    this.notify(level, text);
  }

  /** The reply of a tool: the waiting notices first, then the lines. An open test take adds reminder W8 once (F-T7-21). */
  reply(...lines: string[]): string {
    const waiting = this.notices.splice(0);
    const out = [...waiting.map((n) => n.text), ...lines];
    if (!waiting.some((n) => n.key === 'W8')) {
      for (const o of this.open.values()) if (o.take.kind === 'test' && isOpen(o.take) && o.reading) out.push(TEXT.W8(this.newest(o.reading)));
    }
    return out.join('\n');
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

  /** F10: find the active output that writes a file, then keep only the path field of its settings. The rest of the reply is dropped here. */
  private async filePath(conn: number): Promise<string | undefined> {
    try {
      const list = (await this.obs.callOn(conn, 'GetOutputList')).outputs;
      const out = Array.isArray(list) ? list.find((o) => o?.outputActive === true && o?.outputKind === 'ffmpeg_muxer') : undefined;
      if (typeof out?.outputName !== 'string') return undefined;
      const path = ((await this.obs.callOn(conn, 'GetOutputSettings', { outputName: out.outputName })).outputSettings as { path?: unknown } | undefined)?.path;
      return typeof path === 'string' && path ? path : undefined;
    } catch {
      return undefined;
    }
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

  private write(o: Open) {
    try {
      this.journal.state(o.take.id, o.take);
    } catch (e) {
      if (e instanceof FencedError) this.release(o);
      else throw e;
    }
  }

  /** Another process took over: stop all work on the take here (the fence). */
  private release(o: Open) {
    for (const t of o.timers) clearTimeout(t);
    this.open.delete(o.take.id);
  }

  private every(o: Open, ms: number, fn: () => void) {
    const t = setInterval(fn, ms);
    t.unref?.();
    o.timers.push(t);
  }

  /** What a state starts: the beat, the timers of section 4, the watch and the file check. */
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
    // The owner beats in every open state, so that no live take looks dead to another process (F-T7-4).
    if (isOpen(o.take)) this.beating(o);
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
      this.open.delete(o.take.id);
      this.last = o.take;
      this.journal.prune();
      if (!this.open.size) this.obs.keepConnected(false);
    }
  }

  /** A beat now, and one each beatMs (P13). */
  private beating(o: Open) {
    const beat = () => {
      try {
        this.journal.beat(o.take.id);
      } catch (e) {
        if (e instanceof FencedError) this.release(o);
      }
    };
    beat();
    this.every(o, this.limits.beatMs, beat);
  }

  /** One watch read. */
  private async tick(o: Open) {
    const r = await this.tryRead();
    if (r && !this.ended && this.open.get(o.take.id) === o) this.observe(o, r);
  }

  /** A read on a take. After a reconnect, the same-recording test runs against the journal (T24). */
  private observe(o: Open, r: Reading) {
    const s = o.take.state;
    let same: boolean | undefined;
    if (s === 'stop_uncertain' && r.active && o.reading) same = sameRecording(o.reading, r, o.take.paths);
    else if ((s === 'recording' || s === 'paused') && r.active && o.reading && o.reading.conn !== r.conn) {
      const a = journalReading(o.take);
      same = a ? sameRecording(a, r, o.take.paths) : true;
    }
    this.apply(o, { type: 'read', reading: r, same });
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
      // mark ends with the reconnect (F-T7-16).
      void this.restartWaiting();
      for (const o of this.open.values()) if (!this.waiting.has(o.take.id)) void this.tick(o);
      return;
    }
    if (e.type === 'closed') {
      for (const o of this.open.values()) {
        const s = this.apply(o, { type: 'disconnect', at: Date.now() });
        if (s.row === 'O1' && (o.take.state === 'recording' || o.take.state === 'paused')) {
          const t = setTimeout(() => !this.obs.connected && this.apply(o, { type: 'timeout', phase: 'gone', at: Date.now() }), this.limits.goneMs);
          t.unref?.();
          o.timers.push(t);
        }
      }
      return;
    }
    if (e.type === 'ExitStarted') {
      for (const o of this.open.values()) this.apply(o, { type: 'exit', at: Date.now() });
      return;
    }
    if (e.type === 'RecordFileChanged') {
      const path = e.data.newOutputPath;
      if (typeof path === 'string') for (const o of this.open.values()) this.apply(o, { type: 'file', path });
      return;
    }
    const state = STATES[String(e.data.outputState)];
    if (!state) return;
    const at = Date.now();
    if (state === 'STARTED' || state === 'STOPPING' || state === 'STOPPED') {
      this.ev.set(e.conn, (this.ev.get(e.conn) ?? 0) + 1);
      this.lastEventAt = at;
    }
    const path = typeof e.data.outputPath === 'string' ? e.data.outputPath : undefined;
    if (state === 'STARTED' && !this.open.size) {
      void this.openExternal(undefined);
      return;
    }
    for (const o of [...this.open.values()]) this.apply(o, { type: 'event', state, at, path });
  }

  /**
   * A take of another process whose owner stopped beating (P16), and that is not the recording OBS shows now: it holds
   * nothing, so it does not block a start or a new take, and the tools do not show it (F-T7-2). A process of its own
   * client can still take it over (Q1).
   */
  private stale(id: string, take: Take, r: Reading): boolean {
    if (this.journal.beatAge(id) <= this.limits.staleMs) return false;
    if (!r.active) return true;
    const a = journalReading(take);
    return !!a && !sameRecording(a, r, take.paths);
  }

  /** The open takes of other processes. With the read r, a stale take does not count. */
  private others(r?: Reading): { take: Take; client: string }[] {
    return this.journal.openTakes().flatMap((id) => {
      const l = this.open.has(id) ? undefined : this.journal.load(id);
      return l && !(r && this.stale(id, l.take, r)) ? [{ take: l.take, client: l.meta.client }] : [];
    });
  }

  /** T22 and the spawn rows: open an external take, watched at once (F13), with the expected sources of the last preflight (E27). */
  private async openExternal(given?: Reading) {
    const r = given?.active ? given : await this.tryRead();
    if (!r?.active || this.ended) return;
    if ([...this.open.values()].some((o) => isOpen(o.take) && o.take.state !== 'checking' && o.take.state !== 'stopping' && o.take.state !== 'stop_uncertain')) return;
    if (this.others(r).length) return; // another process follows this recording
    // E25: the id comes from the file path, so every process finds one take, and the first owner file wins.
    const id = sha(`external:${r.path ?? Math.round((r.at - r.duration) / 10000)}`).slice(0, 16);
    if (this.open.has(id) || this.journal.load(id)) return;
    if (!this.journal.own(id, 1)) return;
    const take: Take = { ...newTake(id, 'external', 'external'), row: 'T22', startedAt: r.at - r.duration, startBytes: r.bytes, paths: r.path ? [r.path] : [] };
    const o: Open = { take, client: this.journal.me.client, sources: this.lastSources, timers: [], reading: r };
    this.journal.append(id, { t: 'open', v: 1, id, kind: 'external', client: o.client, pid: process.pid, obs: this.obs.version?.obsVersion, ws: this.obs.version?.obsWebSocketVersion });
    if (o.sources.length) this.journal.append(id, { t: 'expect', sources: o.sources });
    this.journal.state(id, take);
    this.open.set(id, o);
    this.obs.keepConnected(true);
    this.notice(TEXT.X15(r, o.sources.map((s) => s.name)));
    this.entered(o);
  }

  /** E27: the expected sources of the last obs_preflight of this process. obs_preflight (T8a) sets them; none until then. */
  lastSources: Source[] = [];

  // ---- Server start (D4): the journal has an open take

  /**
   * Takes over the open takes of the same client whose owner stopped beating (Q1), then applies R1 to R8 to each
   * owned take when OBS answers. Sends no recording request.
   */
  async resume() {
    for (const id of this.journal.openTakes()) {
      if (this.open.has(id) || this.ended) continue;
      // The start of the watch gap: the old owner's beat, read before the takeover makes a new owner file (F-T7-19).
      const lastBeat = Date.now() - this.journal.beatAge(id);
      if (!this.journal.takeOver(id, this.limits.staleMs) || !this.journal.isOwner(id)) continue;
      const l = this.journal.load(id);
      if (!l) continue;
      const o: Open = { take: l.take, client: l.meta.client, sources: l.sources, timers: [], tokenHash: l.recs.findLast((x) => x.t === 'intent' && x.what === 'start')?.token as string | undefined };
      this.open.set(id, o);
      this.waiting.set(id, lastBeat);
      this.beating(o); // the new owner beats while it waits for OBS
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
    for (const [id, lastBeat] of [...this.waiting]) {
      this.waiting.delete(id);
      const o = this.open.get(id);
      if (!o) continue;
      const a = journalReading(o.take);
      const same = r.active && a ? sameRecording(a, r, o.take.paths) : false;
      const before = o.take.state;
      const s = this.apply(o, { type: 'restart', reading: r, same, at: Date.now() });
      if (s.row === 'R1') this.notice(TEXT.X15(r, o.sources.map((x) => x.name)));
      if (s.row === 'R3') this.notice(`OBS still records the take that I started (${hms(r.duration)}, file ${fileName(o.take.paths.at(-1))}). The watch had a gap from ${clock(lastBeat)} to ${clock(Date.now())}.`);
      if (s.row === 'R3' && o.take.kind === 'test') this.notice(TEXT.W8(r), 'warning', 'W8');
      if (o.take.state === before) this.entered(o); // R3, R7 and R8 keep the state: the watch or the check starts again
    }
  }

  // ---- The tools' steps

  /**
   * The take that a tool is about: one this process owns, or an open take of another process (read only). A take of
   * the same client whose owner stopped beating is taken over first (Q1). With the read r, a stale take of another
   * process does not count (F-T7-2).
   */
  async current(r?: Reading): Promise<{ take: Take; owner: boolean; client: string } | undefined> {
    await this.resume();
    const mine = [...this.open.values()].filter((o) => isOpen(o.take));
    const pick = mine.find((o) => o.take.state !== 'checking') ?? mine[0];
    if (pick) return { take: pick.take, owner: true, client: pick.client };
    const other = this.others(r)[0];
    return other && { take: other.take, owner: false, client: other.client };
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
  async refusal(r: Reading): Promise<string | undefined> {
    const cur = (await this.current(r))?.take ?? newTake('none', 'normal', 'idle');
    const refuse = step(cur, { type: 'start', at: Date.now(), reading: r, lastEventAt: this.lastEventAt }).refuse;
    if (!refuse) return undefined;
    if (refuse === 'X7') return TEXT.X7;
    if (r.active) return TEXT.X6(r, isOpen(cur) && cur.kind !== 'external');
    return isOpen(cur) ? `${stateLine(cur, r, Date.now())} I did not send a start.` : TEXT.X6b;
  }

  /**
   * T1: after your consent, claim the start, journal the intent with a sync, send StartRecord once on the connection
   * of the read, and wait up to 5 s for STARTED (P3). Returns the take, or a refusal text when nothing was sent.
   */
  async start(token: string, kind: 'normal' | 'test', consentId: string, r: Reading): Promise<{ take?: Take; text?: string }> {
    const refused = await this.refusal(r);
    if (refused) return { text: refused };
    if (r.conn !== this.obs.connection || !this.obs.connected) return { text: 'The connection to OBS changed after your answer, so I did not send the start. Ask me again to start it.' };
    const id = randomBytes(8).toString('hex');
    const o: Open = { take: newTake(id, kind), client: this.journal.me.client, sources: this.lastSources, tokenHash: sha(token), timers: [], reading: r };
    // The last claim is busy while its take is open and alive, or for 2 s while its take file is not there yet.
    const busy = (prev: string | undefined, age: number) => {
      const l = prev ? this.journal.load(prev) : undefined;
      return l ? isOpen(l.take) && !this.stale(prev!, l.take, r) : age < this.limits.raceMs;
    };
    try {
      if (!this.journal.claim(id, busy)) return { text: TEXT.X7b };
      this.journal.own(id, 1);
      this.journal.append(id, { t: 'open', v: 1, id, kind, client: o.client, pid: process.pid, obs: this.obs.version?.obsVersion, ws: this.obs.version?.obsWebSocketVersion });
      if (o.sources.length) this.journal.append(id, { t: 'expect', sources: o.sources });
      this.journal.append(id, { t: 'intent', what: 'start', at: Date.now(), token: o.tokenHash, consent: consentId });
      this.open.set(id, o);
      this.apply(o, { type: 'start', at: Date.now(), reading: r });
      this.journal.append(id, { t: 'sent', request: 'StartRecord', seq: ++this.seq, conn: r.conn, at: Date.now() });
    } catch (e) {
      this.release(o);
      if (e instanceof FencedError || (e as { code?: string }).code || /journal/.test(String((e as Error).message))) return { text: 'I could not save the take record, so I did not send the start.' };
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
  async stop(id: string, b: Reading, consentId: string | undefined, shown: Reading | undefined): Promise<Take> {
    const o = this.open.get(id);
    if (!o) throw new Error('not the owner');
    const s = step(o.take, { type: 'stop', reading: b });
    if (!s.send) {
      this.apply(o, { type: 'stop', reading: b });
      return o.take;
    }
    // Journal the intent before the step, in the same tick, so that a parallel accept finds the open stop (rule 5).
    this.journal.append(id, { t: 'intent', what: 'stop', at: Date.now(), consent: consentId, duration: shown?.duration, path: shown?.path, bytes: shown?.bytes });
    this.apply(o, { type: 'stop', reading: b });
    this.journal.append(id, { t: 'sent', request: 'StopRecord', seq: ++this.seq, conn: b.conn, at: Date.now() });
    return this.send(o, 'StopRecord', b.conn, 'stopping', this.limits.stopMs, 'stop');
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
        // A fenced or full journal does not change what OBS did.
      }
    };
    // An OBS code goes to the state machine. No reply in callMs on a live connection is a timeout (T3, T16), not a
    // drop, so that no text says "I lost the connection" then.
    this.obs.callOn(conn, request).then(
      () => record(100),
      (e) => {
        const code = (e as { code?: number }).code;
        if (code !== undefined && code >= 200 && code < 1000) {
          record(code);
          this.apply(o, { type: 'reply', request, code, at: Date.now() });
        } else if (o.take.state === state) this.apply(o, code === undefined && this.obs.connected ? { type: 'timeout', phase, at: Date.now() } : { type: 'disconnect', at: Date.now() });
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
    for (const o of this.open.values()) for (const t of o.timers) clearTimeout(t);
    this.open.clear();
  }
  private ended = false;

  get hasOpen() {
    return this.open.size > 0;
  }
}
