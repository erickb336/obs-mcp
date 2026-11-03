// The file check: what a saved recording holds, per audio track and over the full timeline.
// It only reads. It never changes, moves or deletes the file, whatever the result.
// ffprobe gives the streams and their durations. One ffmpeg pass gives, for each audio track, its level (astats) and
// every silent interval (silencedetect). Without ffmpeg, afinfo (macOS) gives the tracks, and the sound is not checked.
// The file path, the expected sources and every line that ffmpeg prints are untrusted input.
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { audioTools } from './platform.js';

export type Kind = 'voice' | 'continuous' | 'any';
/** One input that this recording must hold: its name, its kind, its track (1 is the first audio track) and an optional backup track. */
export type Expected = { name: string; kind: Kind; track: number; backup?: number };
export type State = 'verified' | 'verified_with_warnings' | 'failed' | 'not_checked';
type Verdict = 'pass' | 'warn' | 'fail' | 'not_checked' | 'info';
type Interval = { start: number; end: number; why?: 'silent' | 'no audio data' };
type Gap = { from: string; to: string; seconds: number; why: 'silent' | 'no audio data' };
type Claim = { claim: string; verdict: Verdict; evidence: string; gaps?: Gap[]; more_gaps?: number };

/** A problem with the request or the settings. The tool reports it as an error and checks nothing. */
export class VerifyError extends Error {}

const MIN_SOUND_S = 0.5; // a track with less sound than this is silent
const LOW_PEAK_DB = -40; // a peak below this is a low level
const CLIP_PEAK_DB = -0.1; // a peak at or above this may clip
const MAX_GAPS = 20; // gaps listed in one claim or track
const MAX_OUTPUT = 32 * 1024 * 1024; // bytes read from one tool run

/** The gap limits per kind. No real take sets them yet, so they are settings with conservative defaults. */
export function limitsFrom(env: NodeJS.ProcessEnv = process.env) {
  const num = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n < min || n > max) throw new VerifyError(`${name} is "${raw.slice(0, 20)}". It must be a number from ${min} to ${max}. Fix it, or remove it to use ${fallback}.`);
    return n;
  };
  const voice = num('OBS_MCP_VOICE_GAP_S', 30, 0.1, 86400);
  const continuous = num('OBS_MCP_CONTINUOUS_GAP_S', 2, 0.1, 86400);
  return {
    silenceDb: num('OBS_MCP_SILENCE_DB', -50, -120, -1),
    timeoutS: num('OBS_MCP_VERIFY_TIMEOUT_S', 900, 1, 86400),
    // A gap at or above fail fails the source. A gap at or above warn, and below fail, is a warning. "any" fails only with no sound.
    gap: { voice: { warn: Math.min(10, voice), fail: voice }, continuous: { warn: Math.min(0.5, continuous), fail: continuous }, any: { warn: 10, fail: Infinity } } as Record<Kind, { warn: number; fail: number }>,
  };
}
export type Limits = ReturnType<typeof limitsFrom>;

/** The file inside the recording folder. Refuses "..", a path or a link that leads out of the folder, and anything that is not a regular file. */
export function resolveInFolder(folder: string, input: string): { path: string; name: string } {
  const shown = JSON.stringify(input.slice(0, 200));
  if (!input || input.includes('\0')) throw new VerifyError('Give the name of a file in the recording folder.');
  if (input.split(/[\\/]/).includes('..')) throw new VerifyError(`The path ${shown} has "..". Give a file inside the recording folder.`);
  let root: string;
  try {
    root = realpathSync(folder);
  } catch {
    throw new VerifyError('The recording folder cannot be read.');
  }
  let real: string;
  try {
    real = realpathSync(isAbsolute(input) ? input : join(root, input));
  } catch {
    throw new VerifyError(`No file ${shown} in the recording folder.`);
  }
  const name = relative(root, real);
  if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) throw new VerifyError(`${shown} is outside the recording folder, or a link leads out of it. The check reads only files inside the recording folder.`);
  if (!statSync(real).isFile()) throw new VerifyError(`${shown} is not a regular file.`);
  return { path: real, name };
}

/** Refuses expected sources that cannot be checked as given. */
function checkExpect(expect: Expected[]) {
  const names = new Set<string>();
  for (const e of expect) {
    if (names.has(e.name)) throw new VerifyError(`Two expected sources have the name ${JSON.stringify(e.name)}. Give each a different name.`);
    names.add(e.name);
    if (e.backup === e.track) throw new VerifyError(`The backup of ${JSON.stringify(e.name)} is its own track ${e.track}. A backup must be another track.`);
  }
}

/** Runs a tool with an argument array, never a shell, with a time limit and an output limit. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string; stopped?: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let done = false;
    const err: Buffer[] = [];
    let bytes = 0;
    let stopped: string | undefined;
    // A stop answers at once: a child of the tool can hold the pipes open after the kill, so "close" can come late.
    const stop = (why: string) => {
      stopped ??= why;
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      finish(null);
    };
    const timer = setTimeout(() => stop(`it ran longer than ${timeoutMs / 1000} s (OBS_MCP_VERIFY_TIMEOUT_S)`), timeoutMs);
    const keep = (to: Buffer[]) => (d: Buffer) => {
      bytes += d.length;
      if (bytes > MAX_OUTPUT) stop(`its output passed ${MAX_OUTPUT} bytes`);
      else to.push(d);
    };
    child.stdout.on('data', keep(out));
    child.stderr.on('data', keep(err));
    function finish(code: number | null) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8'), stopped });
    }
    child.on('error', (e) => {
      stopped ??= `it could not start (${(e as NodeJS.ErrnoException).code ?? e.message})`;
      finish(null);
    });
    child.on('close', finish);
  });
}

/** What ffprobe says: the container duration, the first video stream and each audio stream, in file order. */
export type Probe = { durationS?: number; video?: { durationS?: number }; audio: { sampleRate?: number; durationS?: number; startS?: number }[] };

const num = (v: unknown) => (v === undefined || v === null || v === '' || v === 'N/A' || !Number.isFinite(Number(v)) ? undefined : Number(v));

/** Parses the JSON of "ffprobe -show_entries format=duration:stream=codec_type,sample_rate,duration,start_time -of json". */
export function parseProbe(json: string): Probe {
  const j = JSON.parse(json) as { format?: { duration?: string }; streams?: { codec_type?: string; sample_rate?: string; duration?: string; start_time?: string }[] };
  const streams = j.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  return {
    durationS: num(j.format?.duration),
    video: video ? { durationS: num(video.duration) } : undefined,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({ sampleRate: num(s.sample_rate), durationS: num(s.duration), startS: num(s.start_time) })),
  };
}

/** What one ffmpeg pass says about each track (1-based): level, decoded samples and silent intervals; and the error lines. */
export type Log = { tracks: Map<number, { peakDb?: number; rmsDb?: number; samples?: number; silences: { start: number; end?: number }[] }>; errors: string[] };

const db = (s: string) => (s.trim() === '-inf' ? -Infinity : num(s.trim()));

/** Parses the stderr of the ffmpeg pass of verifyFile: filters named astats@tN and silencedetect@tN, one pair for track N. */
export function parseLog(text: string, file = ''): Log {
  const tracks: Log['tracks'] = new Map();
  const errors: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[(astats|silencedetect)@t(\d+) @ [^\]]*\] (.*)$/.exec(line);
    if (!m) {
      // ffmpeg starts an error line with "[" or "Error"; metadata from the file is indented, so a tag text never counts.
      // The test reads the line without the file path, so that a file name such as "truncated.mov" is not an error.
      // An error line loses the memory address and the full path, so that a reply holds neither.
      const bare = file ? line.split(file).join('') : line;
      if (/^(\[|Error)/.test(line) && /error|invalid|corrupt|partial file|truncat|moov atom|missing/i.test(bare) && errors.length < 5) errors.push(line.replace(/ @ 0x[0-9a-f]+/gi, '').split(file || '\0').join(basename(file)).slice(0, 200));
      continue;
    }
    const n = Number(m[2]);
    const t = tracks.get(n) ?? { silences: [] };
    tracks.set(n, t);
    const kv = /^([^:]+): (.*)$/.exec(m[3]);
    if (m[1] === 'silencedetect') {
      const start = /^silence_start: (\S+)/.exec(m[3]);
      const end = /^silence_end: (\S+)/.exec(m[3]);
      if (start && num(start[1]) !== undefined) t.silences.push({ start: Number(start[1]) });
      else if (end && num(end[1]) !== undefined) {
        const open = t.silences.at(-1);
        if (open && open.end === undefined) open.end = Number(end[1]);
      }
    } else if (kv) {
      if (kv[1] === 'Peak level dB') t.peakDb = db(kv[2]);
      if (kv[1] === 'RMS level dB') t.rmsDb = db(kv[2]);
      if (kv[1] === 'Number of samples') t.samples = num(kv[2]);
    }
  }
  return { tracks, errors };
}

/** One audio track, measured: its end on the timeline, its levels and its silent intervals over the full timeline. */
type Measure = { track: number; endS: number; declaredS?: number; peakDb?: number; rmsDb?: number; silences: Interval[]; soundS: number };

const total = (iv: Interval[]) => iv.reduce((a, g) => a + (g.end - g.start), 0);

/** Sorts intervals and joins the ones that touch. */
function merge(iv: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const g of [...iv].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && g.start <= last.end + 1e-6) {
      if (g.end > last.end) last.end = g.end;
      if (g.why === 'no audio data') last.why = g.why;
    } else out.push({ ...g });
  }
  return out;
}

/** The times when both lists are silent: the silence that a backup track does not cover. */
function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) for (const y of b) {
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end, why: x.why === 'no audio data' && y.why === 'no audio data' ? 'no audio data' : 'silent' });
  }
  return merge(out);
}

/** Puts the probe and the ffmpeg log together, per track, on the timeline of the container. */
export function measure(probe: Probe, log: Log): Measure[] {
  const duration = probe.durationS ?? 0;
  return probe.audio.map((a, i) => {
    const t = log.tracks.get(i + 1) ?? { silences: [] };
    const start = a.startS && a.startS > 0 ? a.startS : 0;
    const decoded = t.samples !== undefined && a.sampleRate ? t.samples / a.sampleRate : (a.durationS ?? duration);
    const endS = Math.min(duration, start + decoded);
    const silences: Interval[] = t.silences.map((s) => ({ start: s.start, end: s.end ?? endS, why: 'silent' as const }));
    // Before the track starts and after it ends, the file holds no audio data for it: that is silence too.
    if (start >= MIN_SOUND_S) silences.push({ start: 0, end: start, why: 'no audio data' });
    if (duration - endS >= MIN_SOUND_S) silences.push({ start: endS, end: duration, why: 'no audio data' });
    const merged = merge(silences);
    return { track: i + 1, endS, declaredS: a.durationS, peakDb: t.peakDb, rmsDb: t.rmsDb, silences: merged, soundS: Math.max(0, duration - total(merged)) };
  });
}

/** A time as hh:mm:ss.s. */
export const timecode = (s: number) => {
  const t = Math.max(0, Math.round(s * 10) / 10);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
};
const gapOf = (g: Interval): Gap => ({ from: timecode(g.start), to: timecode(g.end), seconds: Math.round((g.end - g.start) * 10) / 10, why: g.why ?? 'silent' });
const dbText = (v?: number) => (v === undefined ? 'unknown' : v === -Infinity ? '-inf dB' : `${v.toFixed(1)} dB`);
const listed = (gaps: Interval[]) => ({ ...(gaps.length ? { gaps: gaps.slice(0, MAX_GAPS).map(gapOf) } : {}), ...(gaps.length > MAX_GAPS ? { more_gaps: gaps.length - MAX_GAPS } : {}) });
const pick = <T>(arr: T[], i: number): T | undefined => arr[i - 1];

/** The state from the claims: one fail fails the file; a claim not checked leaves it not checked; a warning leaves a warning. */
export function stateOf(claims: Claim[]): State {
  const has = (v: Verdict) => claims.some((c) => c.verdict === v);
  return has('fail') ? 'failed' : has('not_checked') ? 'not_checked' : has('warn') ? 'verified_with_warnings' : 'verified';
}

/** The claims about sound, one per expected source, or one per track when no source is named. */
export function judge(probe: Probe, measures: Measure[], expect: Expected[], limits: Limits): Claim[] {
  const duration = probe.durationS ?? 0;
  const everything: Interval[] = [{ start: 0, end: duration, why: 'no audio data' }];
  const claims: Claim[] = [];
  const levelNote = (m: Measure) => (m.peakDb !== undefined && m.peakDb < LOW_PEAK_DB ? `Low level: peak ${dbText(m.peakDb)} is below ${LOW_PEAK_DB} dB` : m.peakDb !== undefined && m.peakDb >= CLIP_PEAK_DB ? `Peak ${dbText(m.peakDb)}: it may clip` : undefined);
  const summary = (m: Measure) => `Track ${m.track}: peak ${dbText(m.peakDb)}, RMS ${dbText(m.rmsDb)}, sound ${m.soundS.toFixed(1)} s of ${duration.toFixed(1)} s`;

  for (const e of expect) {
    const own = pick(measures, e.track);
    const backup = e.backup ? pick(measures, e.backup) : undefined;
    const { warn, fail } = limits.gap[e.kind];
    const ownSilence = own?.silences ?? everything;
    const left = e.backup ? intersect(ownSilence, backup?.silences ?? everything) : ownSilence;
    const assess = (iv: Interval[]) => {
      const long = iv.filter((g) => g.end - g.start >= warn);
      return { long, failing: duration - total(iv) < MIN_SOUND_S || long.some((g) => g.end - g.start >= fail) };
    };
    const alone = assess(ownSilence);
    const covered = assess(left);
    const claim = `Source ${JSON.stringify(e.name)} (${e.kind}) has sound on track ${e.track}`;
    const facts = [own ? summary(own) : `the file has ${measures.length} audio track${measures.length === 1 ? '' : 's'}`];
    if (e.backup) facts.push(backup ? `backup ${summary(backup)}` : `backup track ${e.backup} is missing`);
    const rule = e.kind === 'any' ? 'kind any needs some sound' : `gap limit ${fail} s, gaps from ${warn} s are listed`;
    if (covered.failing) {
      const why = !own ? `Track ${e.track} is missing` : duration - total(left) < MIN_SOUND_S ? 'No sound' : `A gap of ${fail} s or more`;
      claims.push({ claim, verdict: 'fail', evidence: `${why}${e.backup ? ', and the backup does not cover it' : ''}: ${facts.join('; ')}. Rule: ${rule}.`, ...listed(covered.long) });
    } else if (alone.failing) {
      claims.push({ claim, verdict: 'warn', evidence: `Track ${e.track} fails alone, and backup track ${e.backup} has sound there: use the backup track for those times. ${facts.join('; ')}. Rule: ${rule}.`, ...listed(alone.long) });
    } else {
      const gaps = e.kind === 'any' ? [] : covered.long;
      const level = own ? levelNote(own) : undefined;
      const notes = [gaps.length ? `${gaps.length} gap${gaps.length === 1 ? '' : 's'} of ${warn} s or more, below the limit of ${fail} s` : '', level ?? ''].filter(Boolean);
      claims.push({ claim, verdict: notes.length ? 'warn' : 'pass', evidence: `${notes.length ? `${notes.join('; ')}. ` : ''}${facts.join('; ')}. Rule: ${rule}.`, ...listed(gaps) });
    }
  }

  const named = new Set(expect.flatMap((e) => [e.track, e.backup ?? 0]));
  for (const m of measures.filter((x) => !named.has(x.track))) {
    const silent = m.soundS < MIN_SOUND_S;
    const level = silent ? undefined : levelNote(m);
    // With expected sources, a track that none names only informs. Without them, each track counts.
    const verdict: Verdict = expect.length ? 'info' : silent || level ? 'warn' : 'pass';
    claims.push({ claim: `Track ${m.track} has sound`, verdict, evidence: `${silent ? 'Silent. ' : level ? `${level}. ` : ''}${summary(m)}.${expect.length ? ' No expected source names this track.' : ''}` });
  }
  if (!expect.length && measures.length) {
    const any = measures.some((m) => m.soundS >= MIN_SOUND_S);
    claims.push({ claim: 'The file has sound on at least one track', verdict: any ? 'pass' : 'fail', evidence: any ? `Sound on track ${measures.filter((m) => m.soundS >= MIN_SOUND_S).map((m) => m.track).join(', ')}.` : `All ${measures.length} audio tracks are silent.` });
  }
  return claims;
}

/** The result for the model: the state first, then one verdict per claim with the timecode of each gap, then the measurements. */
export async function verifyFile(path: string, name: string, expect: Expected[] = [], env: NodeJS.ProcessEnv = process.env) {
  checkExpect(expect);
  const limits = limitsFrom(env);
  const tools = audioTools(env);
  const size = statSync(path).size;
  const head = { file: name, size_bytes: size };
  const settings = {
    silence_floor_db: limits.silenceDb,
    voice_gap_limit_s: limits.gap.voice.fail,
    continuous_gap_limit_s: limits.gap.continuous.fail,
    basis: 'No real take sets these limits yet. They are settings with conservative defaults: OBS_MCP_VOICE_GAP_S, OBS_MCP_CONTINUOUS_GAP_S, OBS_MCP_SILENCE_DB.',
  };
  const note = 'The check only reads the file. It never changes, moves or deletes it, whatever the result.';
  const timeoutMs = limits.timeoutS * 1000;
  const done = (claims: Claim[], extra: Record<string, unknown> = {}) => ({ state: stateOf(claims), ...head, claims, ...extra, limits: settings, note });

  if (!tools.ffmpeg || !tools.ffprobe) {
    const missing = `${[tools.ffmpeg ? '' : 'ffmpeg', tools.ffprobe ? '' : 'ffprobe'].filter(Boolean).join(' and ')} not found`;
    const notChecked = `Sound not checked: ${missing} (PATH, or OBS_MCP_FFMPEG). Install: ${tools.install}`;
    if (!tools.afinfo) return done([{ claim: 'The file was checked', verdict: 'not_checked', evidence: `${notChecked}. Nothing in the file was checked.` }], { checked_with: 'nothing' });
    return done(await afinfoClaims(tools.afinfo, path, expect, notChecked, timeoutMs), { checked_with: 'afinfo (macOS fallback)' });
  }

  const input = `file:${path}`; // an absolute path with the file protocol: never read as an option or as another protocol
  const p = await run(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration:stream=codec_type,sample_rate,duration,start_time', '-of', 'json', '-i', input], timeoutMs);
  const version = p.stopped ? 'ffprobe' : (await run(tools.ffmpeg, ['-hide_banner', '-version'], 10000)).out.split('\n')[0].replace(/ Copyright.*$/, '');
  const clean = (s: string) => s.replace(/ @ 0x[0-9a-f]+/gi, '').split(path).join(name).trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
  let probe: Probe | undefined;
  try {
    probe = p.code === 0 && !p.stopped ? parseProbe(p.out) : undefined;
  } catch {
    probe = undefined;
  }
  if (!probe || probe.durationS === undefined) {
    // A stopped tool says nothing about the file, so it is not_checked; a tool that cannot read the file fails it.
    const claim = 'The file is readable and complete';
    if (p.stopped) return done([{ claim, verdict: 'not_checked', evidence: `ffprobe stopped: ${p.stopped}. Nothing in the file was checked.` }], { checked_with: version });
    return done([{ claim, verdict: 'fail', evidence: `ffprobe cannot read it: ${clean(p.err) || 'no duration'}. The file may be cut short or not finished: OBS may still write it, or it stopped before the end.` }], { checked_with: version });
  }

  const claims: Claim[] = [];
  const duration = probe.durationS;
  const n = probe.audio.length;
  let measures: Measure[] = [];
  let soundChecked = true;
  const fileFacts = [`Duration ${timecode(duration)}`, `${n} audio track${n === 1 ? '' : 's'}`, probe.video ? 'a video stream' : 'no video stream'];
  const fileProblems: string[] = [];
  if (n) {
    const d = Math.min(...Object.values(limits.gap).map((g) => g.warn), MIN_SOUND_S);
    const graph = probe.audio.map((_, i) => `[0:a:${i}]astats@t${i + 1}=metadata=0:measure_perchannel=none,silencedetect@t${i + 1}=noise=${limits.silenceDb}dB:d=${d}[o${i + 1}]`).join(';');
    const maps = probe.audio.flatMap((_, i) => ['-map', `[o${i + 1}]`]);
    const f = await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-protocol_whitelist', 'file', '-i', input, '-filter_complex', graph, ...maps, '-f', 'null', '-'], timeoutMs);
    const log = parseLog(f.err, path);
    measures = measure(probe, log);
    if (f.stopped || f.code !== 0) {
      soundChecked = false;
      fileProblems.push(f.stopped ? `ffmpeg stopped: ${f.stopped}` : `ffmpeg exit code ${f.code}: ${log.errors.join(' | ') || clean(f.err.split('\n').slice(-4).join('\n'))}`);
    } else {
      const short = measures.filter((m) => m.declaredS !== undefined && m.declaredS - (m.endS - (probe!.audio[m.track - 1].startS ?? 0)) >= 1);
      for (const m of short) fileProblems.push(`Track ${m.track} says ${m.declaredS!.toFixed(1)} s, but its audio data ends at ${timecode(m.endS)}`);
      if (log.errors.length) fileProblems.push(`ffmpeg reported: ${log.errors.join(' | ')}`);
    }
  }
  claims.push({
    claim: 'The file is readable and complete',
    verdict: fileProblems.length ? (soundChecked ? 'fail' : 'not_checked') : 'pass',
    evidence: `${fileProblems.length ? `${fileProblems.join('; ')}. ${soundChecked ? 'The file may be cut short or damaged.' : 'The sound check did not finish, so the sound is not checked.'} ` : ''}${fileFacts.join(', ')}.`,
  });
  const video = probe.video;
  const videoShort = video?.durationS !== undefined && duration - video.durationS >= 2;
  claims.push({
    claim: 'The file has a video stream for the full timeline',
    verdict: !video || videoShort ? 'warn' : 'pass',
    evidence: !video ? 'No video stream.' : `Video ${video.durationS === undefined ? 'duration unknown' : timecode(video.durationS)} of ${timecode(duration)}.`,
  });
  claims.push({ claim: 'The file has audio', verdict: n ? 'pass' : 'fail', evidence: n ? `${n} audio track${n === 1 ? '' : 's'}.` : 'No audio stream.' });
  if (n && soundChecked) claims.push(...judge(probe, measures, expect, limits));
  else if (expect.length) claims.push(...expect.map((e) => ({ claim: `Source ${JSON.stringify(e.name)} (${e.kind}) has sound on track ${e.track}`, verdict: (n ? 'not_checked' : 'fail') as Verdict, evidence: n ? 'Sound not checked: the ffmpeg pass did not finish.' : 'The file has no audio stream.' })));

  const roles = new Map<number, string>();
  for (const e of expect) {
    roles.set(e.track, `source ${JSON.stringify(e.name)} (${e.kind})`);
    if (e.backup && !roles.has(e.backup)) roles.set(e.backup, `backup of ${JSON.stringify(e.name)}`);
  }
  const tracks = soundChecked
    ? measures.map((m) => {
        const kind = expect.find((e) => e.track === m.track)?.kind ?? 'any';
        const shown = m.silences.filter((g) => g.end - g.start >= limits.gap[kind].warn);
        return {
          track: m.track,
          role: roles.get(m.track) ?? 'not named',
          peak_db: m.peakDb === -Infinity ? '-inf' : m.peakDb,
          rms_db: m.rmsDb === -Infinity ? '-inf' : m.rmsDb,
          sound_s: Math.round(m.soundS * 10) / 10,
          ends_at: timecode(m.endS),
          silent_intervals: shown.slice(0, MAX_GAPS).map(gapOf),
          ...(shown.length > MAX_GAPS ? { more_intervals: shown.length - MAX_GAPS } : {}),
        };
      })
    : [];
  return done(claims, { checked_with: version, duration: timecode(duration), video_duration: video?.durationS === undefined ? null : timecode(video.durationS), tracks });
}

/** The macOS fallback: afinfo reads the audio tracks and their durations. It cannot read sound levels or video. */
async function afinfoClaims(afinfo: string, path: string, expect: Expected[], notChecked: string, timeoutMs: number): Promise<Claim[]> {
  const r = await run(afinfo, [path], timeoutMs);
  const count = Number(/Num Tracks:\s+(\d+)/.exec(r.out)?.[1] ?? (/estimated duration/.test(r.out) ? 1 : 0));
  const durations = [...r.out.matchAll(/estimated duration: ([\d.]+) sec/g)].map((m) => Number(m[1]));
  if (r.code !== 0 || r.stopped || !durations.length) {
    return [
      { claim: 'The file is readable and complete', verdict: 'fail', evidence: `afinfo cannot read audio in it${r.stopped ? `: ${r.stopped}` : ''}. The file may be cut short, not finished, or hold no audio.` },
      { claim: 'The file has sound', verdict: 'not_checked', evidence: notChecked },
    ];
  }
  const claims: Claim[] = [
    { claim: 'The file is readable and complete', verdict: 'not_checked', evidence: `afinfo reads ${count} audio track${count === 1 ? '' : 's'}, ${durations.map((d, i) => `track ${i + 1} ${timecode(d)}`).join(', ')}. afinfo does not show a cut-short file or the video. ${notChecked}.` },
  ];
  for (const e of expect) {
    const has = e.track <= count;
    claims.push({ claim: `Source ${JSON.stringify(e.name)} (${e.kind}) has sound on track ${e.track}`, verdict: has || (e.backup && e.backup <= count) ? 'not_checked' : 'fail', evidence: has ? `Track ${e.track} is present. ${notChecked}.` : `Track ${e.track} is missing: the file has ${count} audio tracks.` });
  }
  if (!expect.length) claims.push({ claim: 'The file has sound', verdict: 'not_checked', evidence: notChecked });
  return claims;
}
