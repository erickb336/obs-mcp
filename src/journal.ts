// The take journal (T7 design, section 6): one append-only JSONL file per take, synced to disk before each recording
// request. It keeps the state of a take across restarts; only the controlling process writes it (G32). It stays on this
// machine. The writer takes typed records with an allow-list of fields, so no free object, request parameter or OBS
// settings reply can reach the disk.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isOpen, newTake, STATES, type Take } from './take.js';

export const RETENTION = { days: 30, takes: 100 }; // G28
// A line holds at most 2 paths of up to 4,096 bytes (the limit of the driver), each up to 6 times longer in JSON (F-T7-40).
const MAX_LINE = 64 * 1024;
const MAX_LINES = 1000;

/** The fields that each record type may hold. Every value must be a string, a number, a boolean, or a list of those. */
const FIELDS: Record<string, string[]> = {
  open: ['v', 'id', 'kind', 'pid', 'obs', 'ws'],
  expect: ['sources'],
  intent: ['what', 'at', 'token', 'consent', 'duration', 'path', 'bytes'],
  sent: ['request', 'seq', 'conn', 'at'],
  reply: ['request', 'code', 'at'],
  event: ['state', 'at', 'path'],
  state: ['state', 'row', 'kind', 'result', 'marks', 'intentAt', 'startedAt', 'startBytes', 'paths', 'offlineAt', 'pausedAt', 'stopAt', 'endedAt', 'heldUntil', 'stopSeen', 'summary', 'at'],
  dropped: ['count'],
};
const SOURCE_FIELDS = ['uuid', 'name', 'kind', 'track', 'backup'];
export type Source = { uuid?: string; name: string; kind: string; track: number; backup?: number };
export type Rec = { t: keyof typeof FIELDS; [k: string]: unknown };

const scalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v);
/** Writes every byte, or throws: one writeSync call can write fewer bytes than it gets (F-T7-61). */
function writeAll(fd: number, buf: Buffer) {
  for (let done = 0; done < buf.length; ) {
    const n = writeSync(fd, buf, done);
    if (n <= 0) throw Object.assign(new Error('journal: the write made no progress'), { code: 'EIO' });
    done += n;
  }
}

/** Throws on a field that is not on the allow-list, or on a free object. */
function checked(rec: Rec): Rec {
  const allowed = Object.hasOwn(FIELDS, rec.t) ? FIELDS[rec.t] : undefined;
  if (!allowed) throw new Error(`journal: unknown record ${rec.t}`);
  for (const [k, v] of Object.entries(rec)) {
    if (k === 't' || k === 'k' || v === undefined) continue;
    if (!allowed.includes(k)) throw new Error(`journal: field ${k} is not allowed in ${rec.t}`);
    const ok =
      k === 'sources'
        ? Array.isArray(v) && v.every((s) => s && typeof s === 'object' && Object.entries(s).every(([sk, sv]) => SOURCE_FIELDS.includes(sk) && scalar(sv)))
        : scalar(v) || (Array.isArray(v) && v.every(scalar));
    if (!ok) throw new Error(`journal: field ${k} of ${rec.t} is not a plain value`);
  }
  return rec;
}

export class Journal {
  private lines = new Map<string, number>();
  private dropped = new Map<string, number>();

  constructor(readonly dir: string) {}

  /** Makes the folder, only for this process's user. A folder that is there already keeps its mode: it can hold other files (F-T7-39). */
  private ensure() {
    const made = mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (made && process.platform !== 'win32') chmodSync(this.dir, 0o700);
  }

  private file = (id: string, ext: string) => join(this.dir, `take-${id}.${ext}`);

  private list(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }

  /**
   * Appends one record and syncs it to disk. Only the controlling process writes (G32). Past the line cap, event and
   * reply records are counted, not written (section 6, size).
   */
  append(id: string, rec: Rec) {
    const known = this.lines.get(id);
    const n = known ?? this.read(id).length;
    // A crash during a write can leave a last line with no end: the new line starts on a line of its own.
    const torn = known === undefined && this.endsTorn(id);
    if (n >= MAX_LINES - 10 && ['event', 'reply'].includes(rec.t)) {
      this.dropped.set(id, (this.dropped.get(id) ?? 0) + 1);
      return;
    }
    const line = (torn ? '\n' : '') + JSON.stringify(checked(rec)) + '\n';
    if (Buffer.byteLength(line) > MAX_LINE) throw Object.assign(new Error(`journal: a ${rec.t} line is longer than ${MAX_LINE} bytes`), { code: 'E2BIG' });
    this.ensure();
    const fd = openSync(this.file(id, 'jsonl'), 'a', 0o600);
    try {
      writeAll(fd, Buffer.from(line));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.lines.set(id, n + 1);
  }

  private endsTorn(id: string): boolean {
    try {
      const text = readFileSync(this.file(id, 'jsonl'), 'utf8');
      return text.length > 0 && !text.endsWith('\n');
    } catch {
      return false;
    }
  }

  /** Writes the state of a take after a step: the fold of the file is its last state line. */
  state(id: string, t: Take, at = Date.now()) {
    if (t.state === 'closed' && this.dropped.get(id)) this.append(id, { t: 'dropped', count: this.dropped.get(id) });
    const { id: _id, ...fields } = t;
    this.append(id, { t: 'state', ...fields, at });
  }

  /** The records of a take. A damaged line (a crash during a write) is skipped. */
  read(id: string): Rec[] {
    let text = '';
    try {
      text = readFileSync(this.file(id, 'jsonl'), 'utf8');
    } catch {
      return [];
    }
    return text.split('\n').flatMap((l) => {
      try {
        const r = JSON.parse(l);
        return r && typeof r === 'object' && typeof r.t === 'string' ? [r] : [];
      } catch {
        return [];
      }
    });
  }

  /**
   * The take, folded from the file: the last good state line gives the state. Only the fields of a state line are
   * read, so a hand-edited line with another key (id, __proto__) changes nothing (F-T7-54).
   */
  load(id: string): { take: Take; sources: Source[]; recs: Rec[] } | undefined {
    const recs = this.read(id);
    const open = recs.find((r) => r.t === 'open');
    if (!open) return undefined;
    const take: Take = newTake(id, KINDS.includes(open.kind as string) ? (open.kind as Take['kind']) : 'normal');
    const last = recs.findLast(validState);
    for (const k of TAKE_FIELDS) if (last && Object.hasOwn(last, k) && last[k] !== undefined) (take as Record<string, unknown>)[k] = last[k];
    const expect = recs.findLast((r) => r.t === 'expect')?.sources;
    const sources = (Array.isArray(expect) ? expect : []).flatMap((x) => {
      const s = x as Record<string, unknown>;
      return s && typeof s.name === 'string' && typeof s.kind === 'string' && Number.isInteger(s.track)
        ? [{ name: s.name, kind: s.kind, track: s.track as number, ...(Number.isInteger(s.backup) ? { backup: s.backup as number } : {}), ...(typeof s.uuid === 'string' ? { uuid: s.uuid } : {}) }]
        : [];
    });
    return { take, sources, recs };
  }

  /** Every take file whose fold is an open take. */
  openTakes(): string[] {
    return this.list()
      .map((f) => /^take-([\w-]+)\.jsonl$/.exec(f)?.[1])
      .filter((id): id is string => !!id && !!this.load(id) && isOpen(this.load(id)!.take));
  }

  /** The closed take whose last state line is the newest, for a status in a new process. An open take is current(). */
  latest(): Take | undefined {
    let best: { at: number; take: Take } | undefined;
    for (const f of this.list()) {
      const id = /^take-([\w-]+)\.jsonl$/.exec(f)?.[1];
      const l = id ? this.load(id) : undefined;
      const at = Number(l?.recs.findLast(validState)?.at ?? 0);
      if (l && !isOpen(l.take) && (!best || at > best.at)) best = { at, take: l.take };
    }
    return best?.take;
  }

  /**
   * G28: removes closed takes older than 30 days, and the oldest closed takes past 100, with their files. Best
   * effort: a file that cannot be removed is logged and kept, and prune never throws, so it never stops the server
   * (F-T7-32). The log names the file only, not the folder.
   */
  prune(now = Date.now()) {
    try {
      this.pruneFiles(now);
    } catch (e) {
      console.error(`obs-mcp: could not clean the take journal: ${(e as { code?: string }).code ?? (e as Error).message}`);
    }
  }

  private pruneFiles(now: number) {
    const old = now - RETENTION.days * 864e5;
    const closed = this.list()
      .map((f) => /^take-([\w-]+)\.jsonl$/.exec(f)?.[1])
      .filter((id): id is string => !!id)
      .map((id) => ({ id, l: this.load(id) }))
      .filter((x) => x.l && !isOpen(x.l.take))
      .map((x) => ({ id: x.id, at: Number(x.l!.recs.findLast(validState)?.at ?? 0) }))
      .sort((a, b) => b.at - a.at);
    const gone = new Set(closed.filter((x, i) => i >= RETENTION.takes || x.at < old).map((x) => x.id));
    for (const f of this.list()) {
      const id = /^take-([\w-]+)\./.exec(f)?.[1];
      if (!id || !gone.has(id)) continue;
      try {
        rmSync(join(this.dir, f), { force: true });
      } catch (e) {
        console.error(`obs-mcp: could not remove the old journal file ${f}: ${(e as { code?: string }).code ?? (e as Error).message}`);
      }
    }
  }
}

const KINDS = ['normal', 'test', 'external'];
const NUMBERS = ['intentAt', 'startedAt', 'startBytes', 'offlineAt', 'pausedAt', 'stopAt', 'endedAt', 'heldUntil', 'at'];
const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
const opt = (v: unknown, type: string) => v === undefined || typeof v === type;
/**
 * A state line that a take can come from: a damaged line, or a line of another version, does not (F-T7-42). The
 * last good line gives the take.
 */
const validState = (r: Rec) =>
  r.t === 'state' &&
  STATES.includes(r.state as Take['state']) &&
  (r.kind === undefined || KINDS.includes(r.kind as string)) &&
  strings(r.marks) &&
  strings(r.paths) &&
  NUMBERS.every((k) => r[k] === undefined || Number.isFinite(r[k])) &&
  ['row', 'result', 'summary'].every((k) => opt(r[k], 'string')) &&
  opt(r.stopSeen, 'boolean');

/** The fields of a take that a state line holds. */
const TAKE_FIELDS = FIELDS.state.filter((k) => k !== 'at');
