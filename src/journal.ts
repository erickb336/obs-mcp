// The take journal (T7 design, section 6): one append-only JSONL file per take, synced to disk before each recording
// request; a beat file; numbered owner files and start claims, each made by one exclusive create. It stays on this
// machine. The writer takes typed records with an allow-list of fields, so no free object, request parameter or OBS
// settings reply can reach the disk.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { isOpen, newTake, type Take } from './take.js';

export const RETENTION = { days: 30, takes: 100 }; // G28
const MAX_LINE = 4096;
const MAX_LINES = 1000;

/** The fields that each record type may hold. Every value must be a string, a number, a boolean, or a list of those. */
const FIELDS: Record<string, string[]> = {
  open: ['v', 'id', 'kind', 'client', 'pid', 'obs', 'ws'],
  expect: ['sources'],
  intent: ['what', 'at', 'token', 'consent', 'duration', 'path', 'bytes'],
  sent: ['request', 'seq', 'conn', 'at'],
  reply: ['request', 'code', 'at'],
  event: ['state', 'at', 'path'],
  state: ['state', 'row', 'kind', 'result', 'marks', 'intentAt', 'startedAt', 'startBytes', 'paths', 'pausedAt', 'stopAt', 'endedAt', 'heldUntil', 'stopSeen', 'summary', 'at'],
  dropped: ['count'],
};
const SOURCE_FIELDS = ['uuid', 'name', 'kind', 'track', 'backup'];
export type Source = { uuid?: string; name: string; kind: string; track: number; backup?: number };
export type Rec = { t: keyof typeof FIELDS; [k: string]: unknown };
/** The open record of a take: who owns it, and what kind of take it is. */
export type Meta = { id: string; kind: string; client: string; pid: number };

const scalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v);
/** Throws on a field that is not on the allow-list, or on a free object. */
function checked(rec: Rec): Rec {
  const allowed = FIELDS[rec.t];
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

/** Another process took over the take: this one must stop writing and only read (the fence of section 6). */
export class FencedError extends Error {}

export class Journal {
  /** This process: its id, the client name it serves, and a random token in its owner files. */
  readonly me: { pid: number; client: string; token: string };
  private lines = new Map<string, number>();
  private dropped = new Map<string, number>();
  private owned = new Map<string, number>();

  constructor(readonly dir: string, client: string) {
    this.me = { pid: process.pid, client, token: randomBytes(16).toString('hex') };
  }

  private ensure() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(this.dir, 0o700);
  }

  private file = (id: string, ext: string) => join(this.dir, `take-${id}.${ext}`);

  /** Creates a file only when it does not exist (flag wx): of two processes, exactly one wins. */
  private create(path: string, body: string): boolean {
    this.ensure();
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, body);
      fsyncSync(fd);
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') return false;
      throw e;
    }
  }

  /** The start claim n (section 6). A failed create means that another process won this start. */
  claim(n = this.highest(/^start-(\d+)\.claim$/) + 1): boolean {
    return this.create(join(this.dir, `start-${n}.claim`), JSON.stringify({ pid: this.me.pid, at: Date.now() }));
  }

  private highest(re: RegExp): number {
    let max = 0;
    for (const f of this.list()) max = Math.max(max, Number(re.exec(f)?.[1] ?? 0));
    return max;
  }

  private list(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }

  /** The owner of a take: the owner file with the highest number. */
  owner(id: string): { k: number; pid: number; client: string; token: string } | undefined {
    const esc = id.replace(/[^\w-]/g, '');
    const k = this.highest(new RegExp(`^take-${esc}\\.owner-(\\d+)$`));
    if (!k) return undefined;
    try {
      return { k, ...JSON.parse(readFileSync(this.file(id, `owner-${k}`), 'utf8')) };
    } catch {
      return undefined;
    }
  }

  /** Creates owner file k for this process. Exactly one process can create each k. */
  own(id: string, k: number): boolean {
    const won = this.create(this.file(id, `owner-${k}`), JSON.stringify(this.me));
    if (won) this.owned.set(id, k);
    return won;
  }

  isOwner(id: string): boolean {
    const o = this.owner(id);
    return !!o && o.token === this.me.token;
  }

  /** The age of the owner's last beat, in ms. With no beat file, the age of the owner file. */
  beatAge(id: string, now = Date.now()): number {
    try {
      return now - JSON.parse(readFileSync(this.file(id, 'beat'), 'utf8')).at;
    } catch {
      const o = this.owner(id);
      return o ? now - statSync(this.file(id, `owner-${o.k}`)).mtimeMs : Infinity;
    }
  }

  /** Q1 (E24): a process of the same client takes over a take whose owner has not beaten in staleMs. */
  takeOver(id: string, staleMs: number): boolean {
    const o = this.owner(id);
    if (!o || o.token === this.me.token) return !!o;
    if (o.client !== this.me.client || this.beatAge(id) <= staleMs) return false;
    return this.own(id, o.k + 1);
  }

  /** The heartbeat (P13): a temp file, then a rename, so it never grows and never tears. */
  beat(id: string, at = Date.now()) {
    this.fence(id);
    const tmp = this.file(id, `beat.${this.me.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ at }), { mode: 0o600 });
    renameSync(tmp, this.file(id, 'beat'));
  }

  private fence(id: string) {
    const k = this.owned.get(id);
    if (k === undefined || this.owner(id)?.k !== k) throw new FencedError(`Another obs-mcp process took over take ${id}.`);
  }

  /**
   * Appends one record and syncs it to disk. Only the owner writes; a write after a takeover throws FencedError.
   * Past the line cap, event, reply and sent records are counted, not written (section 6, size).
   */
  append(id: string, rec: Rec) {
    this.fence(id);
    const known = this.lines.get(id);
    const n = known ?? this.read(id).length;
    // A crash during a write can leave a last line with no end: the new line starts on a line of its own.
    const torn = known === undefined && this.endsTorn(id);
    if (n >= MAX_LINES - 10 && ['event', 'reply'].includes(rec.t)) {
      this.dropped.set(id, (this.dropped.get(id) ?? 0) + 1);
      return;
    }
    const line = (torn ? '\n' : '') + JSON.stringify({ ...checked(rec), k: this.owned.get(id) }) + '\n';
    if (Buffer.byteLength(line) > MAX_LINE) throw new Error(`journal: a ${rec.t} line is longer than ${MAX_LINE} bytes`);
    const fd = openSync(this.file(id, 'jsonl'), 'a', 0o600);
    try {
      writeSync(fd, line);
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
    const { state, row, kind, result, marks, intentAt, startedAt, startBytes, paths, pausedAt, stopAt, endedAt, heldUntil, stopSeen, summary } = t;
    this.append(id, { t: 'state', state, row, kind, result, marks, intentAt, startedAt, startBytes, paths, pausedAt, stopAt, endedAt, heldUntil, stopSeen, summary, at });
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

  /** The take and its open record, folded from the file: the last state line gives the state. */
  load(id: string): { take: Take; meta: Meta; sources: Source[]; recs: Rec[] } | undefined {
    const recs = this.read(id);
    const open = recs.find((r) => r.t === 'open');
    if (!open) return undefined;
    const meta = { id, kind: String(open.kind), client: String(open.client), pid: Number(open.pid) };
    const last = recs.findLast((r) => r.t === 'state');
    const take: Take = { ...newTake(id, meta.kind as Take['kind']), ...(last ? strip(last) : {}) };
    const sources = (recs.findLast((r) => r.t === 'expect')?.sources as Source[] | undefined) ?? [];
    return { take, meta, sources, recs };
  }

  /** Every take file whose fold is an open take. */
  openTakes(): string[] {
    return this.list()
      .map((f) => /^take-([\w-]+)\.jsonl$/.exec(f)?.[1])
      .filter((id): id is string => !!id && !!this.load(id) && isOpen(this.load(id)!.take));
  }

  /** G28: removes closed takes older than 30 days, and the oldest closed takes past 100, with their files; and old claims. */
  prune(now = Date.now()) {
    const old = now - RETENTION.days * 864e5;
    const closed = this.list()
      .map((f) => /^take-([\w-]+)\.jsonl$/.exec(f)?.[1])
      .filter((id): id is string => !!id)
      .map((id) => ({ id, l: this.load(id) }))
      .filter((x) => x.l && !isOpen(x.l.take))
      .map((x) => ({ id: x.id, at: Number(x.l!.recs.findLast((r) => r.t === 'state')?.at ?? 0) }))
      .sort((a, b) => b.at - a.at);
    const gone = new Set(closed.filter((x, i) => i >= RETENTION.takes || x.at < old).map((x) => x.id));
    const top = this.highest(/^start-(\d+)\.claim$/);
    for (const f of this.list()) {
      const id = /^take-([\w-]+)\./.exec(f)?.[1];
      const claim = /^start-(\d+)\.claim$/.exec(f);
      const stale = claim && Number(claim[1]) !== top && statSync(join(this.dir, f)).mtimeMs < old;
      if ((id && gone.has(id)) || stale) rmSync(join(this.dir, f), { force: true });
    }
  }
}

const strip = (r: Rec): Partial<Take> => {
  const { t: _t, k: _k, at: _at, ...rest } = r;
  return rest as Partial<Take>;
};
