// The file check: what a saved recording holds, per audio track and over the full timeline.
// It only reads. It never changes, moves or deletes the file, whatever the result.
// ffprobe gives the streams and their durations. One ffmpeg pass on each audio track gives its level (astats) and
// every silent interval (silencedetect). Without ffmpeg, afinfo (macOS) gives the tracks, and the sound is not checked.
// The file path, the expected sources and every line that ffmpeg prints are untrusted input. The filter results come on
// stdout, where only the filters write; the log on stderr can hold text from the file, so it never fails a file alone.
// Limits that the check cannot close: a hard link inside the folder to a file outside it is a regular file inside the
// folder, so the check reads it; and a file that another program swaps between the path check and the ffmpeg run is
// read as it is at that time. Both need write access to the recording folder.
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
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
const NAMED_GAPS = 3; // silent intervals named in the evidence of a claim
// Silent intervals read from the pass of one track. A real track cannot pass it: each interval is 0.5 s or more, so
// 100,000 is about 14 hours. A pass with more is not trusted, and the sound of that track is not checked.
const MAX_INTERVALS = 100_000;
const MAX_OUTPUT = 32 * 1024 * 1024; // bytes read from one tool run
const MIN_RATE_HZ = 8000; // the lowest sample rate that the check reads; OBS records at 44.1 kHz or 48 kHz
// A track whose audio data ends this much or more before its stated length, or before the end of the file when it
// states no length (MKV), is cut short. OBS writes every track for the full recording; a healthy track ends within
// one audio frame (about 0.02 s) of the file.
const CUT_S = 1;
// The container types that OBS records, and the ffmpeg demuxer for each. ffmpeg never guesses the type, so that a
// playlist (hls) or a concat list in the folder cannot make it read a file outside the folder.
const FORMATS: Record<string, string> = { '.mov': 'mov', '.mp4': 'mov', '.m4v': 'mov', '.mkv': 'matroska', '.flv': 'flv', '.ts': 'mpegts' };

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

/** True when path is inside base, by the text of both paths only. */
const inside = (base: string, path: string) => {
  const r = relative(base, path);
  return !!r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
};

// A character in a path that can hide or change the text of the reply, where the name goes. The check refuses it and
// names it. Other format characters are part of valid names (an emoji sequence, a zero-width non-joiner, a soft hyphen).
const HIDDEN: [RegExp, string][] = [
  [/\p{Cc}/u, 'a control character'], // C0 (a new line, a carriage return, NUL), DEL and C1 (U+0085, U+009B)
  [/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u, 'a text direction control'],
  [/[\u2028\u2029]/u, 'a line or paragraph separator'],
  [/[\u200B\uFEFF]/u, 'a zero-width space'], // no valid name needs one, and it hides a difference between two names
];
function refuseHidden(path: string) {
  for (const [re, what] of HIDDEN) {
    const ch = re.exec(path)?.[0];
    if (ch) throw new VerifyError(`The path has the character U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}, ${what}. The check does not read such a path: rename the file.`);
  }
}

/**
 * The file inside the recording folder. Refuses "..", a path or a link that leads out of the folder, and anything that
 * is not a regular file. A path outside the folder is refused by its text, before any file system call: so the server
 * never touches it (a UNC path or an automount can reach the network), and one refusal text does not show whether it exists.
 */
export function resolveInFolder(folder: string, input: string): { path: string; name: string } {
  const shown = JSON.stringify(input.slice(0, 200));
  const outside = new VerifyError(`${shown} is outside the recording folder, or a link leads out of it. The check reads only files inside the recording folder.`);
  if (!input) throw new VerifyError('Give the name of a file in the recording folder.');
  refuseHidden(input);
  if (input.split(/[\\/]/).includes('..')) throw new VerifyError(`The path ${shown} has "..". Give a file inside the recording folder.`);
  // A UNC, device or namespace path: \\host\share, //host/share, \\?\ and \\.\
  if (/^[\\/]{2}/.test(input)) throw outside;
  let root: string;
  try {
    root = realpathSync(folder);
  } catch {
    throw new VerifyError('The recording folder cannot be read.');
  }
  const asked = resolve(root, input); // an absolute input stays as it is
  if (!inside(resolve(folder), asked) && !inside(root, asked)) throw outside;
  let real: string;
  try {
    real = realpathSync(asked);
  } catch {
    throw new VerifyError(`No file ${shown} in the recording folder.`);
  }
  if (!inside(root, real)) throw outside;
  refuseHidden(real);
  if (!statSync(real).isFile()) throw new VerifyError(`${shown} is not a regular file.`);
  return { path: real, name: relative(root, real) };
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
function run(cmd: string, args: string[], timeoutMs: number, limitS = timeoutMs / 1000): Promise<{ code: number | null; out: string; err: string; stopped?: string }> {
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
    const timer = setTimeout(() => stop(`the check passed its time limit of ${limitS} s (OBS_MCP_VERIFY_TIMEOUT_S)`), timeoutMs);
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

/**
 * What ffprobe says: the container duration, the first video stream and each audio stream, in file order. The timeline
 * of the file starts at the start time of the container (originS): 0 in an OBS MOV or MKV, about 1.4 s in MPEG-TS, and
 * any time in a file made with an offset. Each start here is on that timeline. The ffmpeg pass keeps the times of the
 * file (-copyts), so measure takes originS from each time of the pass. By default ffmpeg moves the times in a different
 * way per format (in MPEG-TS, to the start of each stream), so its default times are not on one timeline.
 */
export type Probe = { originS: number; durationS?: number; video?: { durationS?: number; startS: number }; audio: { sampleRate?: number; channels?: number; durationS?: number; startS: number }[] };

const num = (v: unknown) => (v === undefined || v === null || v === '' || v === 'N/A' || !Number.isFinite(Number(v)) ? undefined : Number(v));

const PROBE_ENTRIES = 'format=duration,start_time:stream=codec_type,sample_rate,channels,duration,start_time';

/**
 * Parses the JSON of "ffprobe -show_entries <PROBE_ENTRIES> -of json". In Matroska (demuxer "matroska") the duration
 * that ffprobe gives is the end time of the file, from time 0; in the other formats it is the time from originS to the end.
 */
export function parseProbe(json: string, format = ''): Probe {
  type Stream = { codec_type?: string; sample_rate?: string; channels?: number; duration?: string; start_time?: string };
  const j = JSON.parse(json) as { format?: { duration?: string; start_time?: string }; streams?: Stream[] };
  const streams = j.streams ?? [];
  const originS = num(j.format?.start_time) ?? 0;
  const startOf = (s: Stream) => Math.max(0, (num(s.start_time) ?? originS) - originS);
  const video = streams.find((s) => s.codec_type === 'video');
  const duration = num(j.format?.duration);
  return {
    originS,
    durationS: duration !== undefined && format === 'matroska' ? Math.max(0, duration - originS) : duration,
    video: video ? { durationS: num(video.duration), startS: startOf(video) } : undefined,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({ sampleRate: num(s.sample_rate), channels: num(s.channels), durationS: num(s.duration), startS: startOf(s) })),
  };
}

/** What the ffmpeg pass of one track says: level, the peak of each channel, decoded samples and silent intervals (times of the file, from -copyts; dropped: the count over MAX_INTERVALS). */
export type TrackLog = { peakDb?: number; rmsDb?: number; samples?: number; channelPeaksDb?: number[]; silences: { start: number; end?: number }[]; dropped?: number };

const db = (s: string) => (s.trim() === '-inf' ? -Infinity : num(s.trim()));

/**
 * The filters of the ffmpeg pass of one track. The first ametadata deletes any metadata that comes with the audio, so
 * only the filters set it. silencedetect sets lavfi.silence_start and lavfi.silence_end on short frames (512 samples or
 * less: shorter than d from 8 kHz up), so each frame holds at most one start and one end, in time order. astats keeps
 * running totals over the track and sets them on long frames, so its last values are for the whole track, with one
 * print for each 480,000 samples. ametadata prints each set to stdout, one write for each line (direct). The text is the
 * same in ffmpeg 8 and 9.
 */
const trackFilter = (silenceDb: number, d: number) =>
  [
    'ametadata=mode=delete',
    'asetnsamples=n=512:p=0',
    `silencedetect=noise=${silenceDb}dB:d=${d}`,
    'ametadata=mode=print:file=-:direct=1',
    'ametadata=mode=delete',
    'asetnsamples=n=480000:p=0',
    'astats=metadata=1:measure_overall=Peak_level+RMS_level+Number_of_samples:measure_perchannel=Peak_level',
    'ametadata=mode=print:file=-:direct=1',
  ].join(',');

/**
 * Parses the stdout of the ffmpeg pass of one track: "key=value" lines from trackFilter. A channel counts only from 1 to
 * the channel count of the track (from ffprobe); any other channel is ignored.
 */
export function parseMetadata(text: string, channels = 0): TrackLog {
  const t: TrackLog = { silences: [] };
  for (const line of text.split('\n')) {
    const m = /^lavfi\.(silence_start|silence_end|astats\.(\w+)\.(Peak_level|RMS_level|Number_of_samples))=(\S+)$/.exec(line);
    if (!m) continue;
    const [, key, channel, stat, value] = m;
    if (key === 'silence_start' && num(value) !== undefined) {
      if (t.silences.length < MAX_INTERVALS) t.silences.push({ start: Number(value) });
      else t.dropped = (t.dropped ?? 0) + 1;
    } else if (key === 'silence_end' && num(value) !== undefined && !t.dropped) {
      const open = t.silences.at(-1);
      if (open && open.end === undefined) open.end = Number(value);
    } else if (channel === 'Overall') {
      if (stat === 'Peak_level') t.peakDb = db(value);
      if (stat === 'RMS_level') t.rmsDb = db(value);
      if (stat === 'Number_of_samples') t.samples = num(value);
    } else if (stat === 'Peak_level') {
      const c = Number(channel);
      if (Number.isInteger(c) && c >= 1 && c <= channels) (t.channelPeaksDb ??= [])[c - 1] = db(value) ?? NaN;
    }
  }
  return t;
}

/** The error lines of a pass (ffmpeg runs with "-v error"): at most 5, without the memory addresses and the full path. */
export function errorLines(text: string, file = ''): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return [...new Set(lines.map((l) => (file ? l.split(file).join(basename(file)) : l).replace(/ @ 0x[0-9a-f]+/gi, '').slice(0, 200)))].slice(0, 5);
}

/** One audio track, measured: where its audio data ends and should end, its levels and its silent intervals over the full timeline. */
type Measure = { track: number; endS: number; expectedEndS: number; declaredS?: number; peakDb?: number; rmsDb?: number; channelPeaksDb?: number[]; silences: Interval[]; soundS: number };

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

/** The times when both lists are silent: the silence that a backup track does not cover. Both lists come sorted from merge, so one walk through each is enough. */
function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    const [x, y] = [a[i], b[j]];
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end, why: x.why === 'no audio data' && y.why === 'no audio data' ? 'no audio data' : 'silent' });
    if (x.end < y.end) i++;
    else j++;
  }
  return merge(out);
}

/** Puts the probe and the ffmpeg pass together, per track, on the timeline of the file: each time of the pass less originS. */
export function measure(probe: Probe, logs: TrackLog[]): Measure[] {
  const duration = probe.durationS ?? 0;
  return probe.audio.map((a, i) => {
    const t = logs[i] ?? { silences: [] };
    const start = a.startS;
    // A pass with no sample count decoded no sample: astats prints at least once for any audio data. So the stated
    // length of a track never stands in for its audio data.
    const decoded = a.sampleRate ? (t.samples ?? 0) / a.sampleRate : 0;
    const endS = Math.min(duration, start + decoded);
    const silent: Interval[] = t.silences.map((s) => ({ start: Math.max(start, s.start - probe.originS), end: Math.min(endS, s.end === undefined ? endS : s.end - probe.originS), why: 'silent' as const })).filter((s) => s.end > s.start);
    // Sound is audio data that is not silent. A time with no audio data is never sound, however short.
    const soundS = Math.max(0, endS - start - total(merge(silent)));
    // Before the track starts and after it ends, the file holds no audio data for it: that is silence too.
    const silences = [...silent];
    if (start >= MIN_SOUND_S) silences.push({ start: 0, end: start, why: 'no audio data' });
    if (duration - endS >= MIN_SOUND_S) silences.push({ start: endS, end: duration, why: 'no audio data' });
    const expectedEndS = a.durationS !== undefined ? start + a.durationS : duration;
    return { track: i + 1, endS, expectedEndS, declaredS: a.durationS, peakDb: t.peakDb, rmsDb: t.rmsDb, channelPeaksDb: t.channelPeaksDb, silences: merge(silences), soundS };
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
/** A count with its noun: "1 audio track", "2 audio tracks". */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
/** The shortest silence that the detector reports: every gap that a rule can use, and no shorter. */
const shortestGap = (limits: Limits) => Math.min(...Object.values(limits.gap).map((g) => g.warn), MIN_SOUND_S);
/** The silent intervals of a track that the result shows: the ones the detector reports, from shortestGap up. */
const shownOf = (m: Measure, limits: Limits) => m.silences.filter((g) => g.end - g.start >= shortestGap(limits));

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
  const levelNote = (m: Measure) => {
    const peaks = m.channelPeaksDb ?? [];
    const loud = peaks.map((p, i) => (p >= limits.silenceDb ? i + 1 : 0)).filter(Boolean);
    const dead = loud.length ? peaks.map((p, i) => (p < limits.silenceDb ? `Channel ${i + 1} is silent (peak ${dbText(p)})` : '')).filter(Boolean) : [];
    const level = m.peakDb !== undefined && m.peakDb < LOW_PEAK_DB ? `Low level: peak ${dbText(m.peakDb)} is below ${LOW_PEAK_DB} dB` : m.peakDb !== undefined && m.peakDb >= CLIP_PEAK_DB ? `Peak ${dbText(m.peakDb)}: it may clip` : '';
    const notes = [...(dead.length ? [`${dead.join(', ')}, and ${loud.length === 1 ? `channel ${loud[0]} has` : `channels ${loud.join(', ')} have`} sound`] : []), level].filter(Boolean);
    return notes.length ? notes.join('; ') : undefined;
  };
  // Every claim about a track names its silent intervals, also the ones below the limits: the verdict uses the limits.
  const summary = (m: Measure) => {
    const shown = shownOf(m, limits);
    const named = shown.slice(0, NAMED_GAPS).map((g) => `${timecode(g.start)} to ${timecode(g.end)}${g.why === 'no audio data' ? ' (no audio data)' : ''}`);
    const intervals = shown.length ? `, ${count(shown.length, 'silent interval')}: ${named.join(', ')}${shown.length > NAMED_GAPS ? `, and ${shown.length - NAMED_GAPS} more` : ''}` : '';
    return `Track ${m.track}: peak ${dbText(m.peakDb)}, RMS ${dbText(m.rmsDb)}, sound ${m.soundS.toFixed(1)} s of ${duration.toFixed(1)} s${intervals}`;
  };
  const tracks = count(measures.length, 'audio track');

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
    // A backup track that the file does not have is a warning: the source has no backup, against the expectation.
    const noBackup = e.backup && !backup ? `Backup track ${e.backup} is missing: the file has ${tracks}` : '';
    const facts = [own ? summary(own) : `the file has ${tracks}`, backup ? `backup ${summary(backup)}` : ''].filter(Boolean);
    const rule = e.kind === 'any' ? 'kind any needs some sound' : `gap limit ${fail} s, a warning from ${warn} s`;
    if (covered.failing) {
      const why = !own ? `Track ${e.track} is missing` : duration - total(left) < MIN_SOUND_S ? 'No sound' : `A gap of ${fail} s or more`;
      claims.push({ claim, verdict: 'fail', evidence: `${why}${backup ? ', and the backup does not cover it' : noBackup ? `, and backup track ${e.backup} is missing` : ''}: ${facts.join('; ')}. Rule: ${rule}.`, ...listed(covered.long) });
    } else if (alone.failing) {
      claims.push({ claim, verdict: 'warn', evidence: `Track ${e.track} fails alone, and backup track ${e.backup} has sound there: use the backup track for those times. ${facts.join('; ')}. Rule: ${rule}.`, ...listed(alone.long) });
    } else {
      const gaps = e.kind === 'any' ? [] : covered.long;
      const level = own ? levelNote(own) : undefined;
      const notes = [gaps.length ? `${count(gaps.length, 'gap')} of ${warn} s or more, below the limit of ${fail} s` : '', noBackup, level ?? ''].filter(Boolean);
      claims.push({ claim, verdict: notes.length ? 'warn' : 'pass', evidence: `${notes.length ? `${notes.join('; ')}. ` : ''}${facts.join('; ')}. Rule: ${rule}.`, ...listed(gaps) });
    }
  }

  const named = new Set(expect.flatMap((e) => [e.track, e.backup ?? 0]));
  for (const m of measures.filter((x) => !named.has(x.track))) {
    const silent = m.soundS < MIN_SOUND_S;
    const missing = m.silences.filter((g) => g.why === 'no audio data');
    const notes = silent ? ['Silent'] : [missing.length ? `No audio data for ${total(missing).toFixed(1)} s` : '', levelNote(m) ?? ''].filter(Boolean);
    // With expected sources, a track that none names only informs. Without them, each track counts.
    const verdict: Verdict = expect.length ? 'info' : notes.length ? 'warn' : 'pass';
    claims.push({ claim: `Track ${m.track} has sound`, verdict, evidence: `${notes.map((x) => `${x}. `).join('')}${summary(m)}.${expect.length ? ' No expected source names this track.' : ''}`, ...(silent ? {} : listed(missing)) });
  }
  if (!expect.length && measures.length) {
    const any = measures.some((m) => m.soundS >= MIN_SOUND_S);
    const loud = measures.filter((m) => m.soundS >= MIN_SOUND_S).map((m) => m.track);
    claims.push({ claim: 'The file has sound on at least one track', verdict: any ? 'pass' : 'fail', evidence: any ? `Sound on ${loud.length === 1 ? 'track' : 'tracks'} ${loud.join(', ')}.` : measures.length === 1 ? 'The only audio track is silent.' : `All ${tracks} are silent.` });
  }
  return claims;
}

/** The result for the model: the state first, then one verdict per claim with the timecode of each gap, then the measurements. */
export async function verifyFile(path: string, name: string, expect: Expected[] = [], env: NodeJS.ProcessEnv = process.env) {
  checkExpect(expect);
  const format = FORMATS[extname(path).toLowerCase()];
  if (!format) throw new VerifyError(`The check reads only the file types that OBS records: ${Object.keys(FORMATS).join(', ')}. ${JSON.stringify(name)} is not one of them.`);
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
  // One deadline for the whole check, from before the first tool runs: ffprobe, the version line and every ffmpeg pass.
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const done = (claims: Claim[], extra: Record<string, unknown> = {}) => ({ state: stateOf(claims), ...head, claims, ...extra, limits: settings, note });

  if (!tools.ffmpeg || !tools.ffprobe) {
    const missing = `${[tools.ffmpeg ? '' : 'ffmpeg', tools.ffprobe ? '' : 'ffprobe'].filter(Boolean).join(' and ')} not found`;
    const notChecked = `Sound not checked: ${missing} (PATH, or OBS_MCP_FFMPEG). Install: ${tools.install}`;
    if (!tools.afinfo) return done([{ claim: 'The file was checked', verdict: 'not_checked', evidence: `${notChecked}. Nothing in the file was checked.` }], { checked_with: 'nothing' });
    return done(await afinfoClaims(tools.afinfo, path, expect, notChecked, timeoutMs), { checked_with: 'afinfo (macOS fallback)' });
  }

  const input = `file:${path}`; // an absolute path with the file protocol: never read as an option or as another protocol
  const p = await run(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', PROBE_ENTRIES, '-of', 'json', '-f', format, '-i', input], left(), limits.timeoutS);
  const version = p.stopped ? 'ffprobe' : (await run(tools.ffmpeg, ['-hide_banner', '-version'], Math.min(10000, left()), limits.timeoutS)).out.split('\n')[0].replace(/ Copyright.*$/, '');
  const clean = (s: string) => s.replace(/ @ 0x[0-9a-f]+/gi, '').split(path).join(name).trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
  let probe: Probe | undefined;
  try {
    probe = p.code === 0 && !p.stopped ? parseProbe(p.out, format) : undefined;
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
  const fileFacts = [`Duration ${timecode(duration)}`, count(n, 'audio track'), probe.video ? 'a video stream' : 'no video stream'];
  const fileProblems: string[] = [];
  const errors: string[] = []; // the error lines of the ffmpeg passes
  const d = shortestGap(limits);
  if (n) {
    // One pass per track, one after another, all within one time limit. The metadata of a pass has no track label.
    const logs: TrackLog[] = [];
    // Below MIN_RATE_HZ a frame of 512 samples is longer than d, so one frame can hold two silences and hide one. A
    // track with no sample rate (0 in MPEG-TS) has no audio data that ffprobe could read, or a format that it does not know.
    const slow = probe.audio.findIndex((a) => !a.sampleRate || a.sampleRate < MIN_RATE_HZ);
    if (slow >= 0) {
      soundChecked = false;
      const rate = probe.audio[slow].sampleRate;
      fileProblems.push(rate ? `Track ${slow + 1} has a sample rate of ${rate} Hz, below ${MIN_RATE_HZ} Hz: the check cannot time its silent intervals` : `Track ${slow + 1} states no sample rate: ffprobe read no audio data of it, or does not know its format`);
    }
    for (let i = 0; i < n && soundChecked; i++) {
      const args = ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-copyts', '-protocol_whitelist', 'file', '-f', format, '-i', input, '-map', `0:a:${i}`, '-af', trackFilter(limits.silenceDb, d), '-f', 'null', '-'];
      const f = await run(tools.ffmpeg, args, left(), limits.timeoutS);
      const track = parseMetadata(f.out, probe.audio[i].channels);
      const trackErrors = errorLines(f.err, path);
      logs.push(track);
      for (const e of trackErrors) if (errors.length < 5 && !errors.includes(e)) errors.push(e);
      if (f.stopped || f.code !== 0 || track.dropped) {
        soundChecked = false;
        fileProblems.push(
          f.stopped
            ? `ffmpeg stopped on track ${i + 1}: ${f.stopped}`
            : f.code !== 0
              ? `ffmpeg exit code ${f.code} on track ${i + 1}: ${trackErrors.join(' | ') || 'no message'}`
              : `ffmpeg reported more than ${MAX_INTERVALS} silent intervals on track ${i + 1} (${track.dropped} more), more than a real track can have`,
        );
      }
    }
    measures = measure(probe, logs);
    if (soundChecked) {
      for (const m of measures.filter((x) => x.expectedEndS - x.endS >= CUT_S)) {
        const start = probe.audio[m.track - 1].startS;
        fileProblems.push(m.endS <= start ? `Track ${m.track} has no audio data: ffmpeg decoded no sample of it` : m.declaredS !== undefined ? `Track ${m.track} says ${m.declaredS.toFixed(1)} s, but its audio data ends at ${timecode(m.endS)}` : `Track ${m.track} states no length, and its audio data ends at ${timecode(m.endS)}, but the file runs to ${timecode(duration)}`);
      }
    }
  }
  // The error lines of ffmpeg are evidence, not a verdict: the log can hold text from the file. They go with a measured
  // problem; alone, they are a warning, as each track has its full audio data.
  const errorText = soundChecked && errors.length ? `ffmpeg reported: ${errors.join(' | ')}` : '';
  claims.push({
    claim: 'The file is readable and complete',
    verdict: fileProblems.length ? (soundChecked ? 'fail' : 'not_checked') : errorText ? 'warn' : 'pass',
    evidence: fileProblems.length
      ? `${[...fileProblems, errorText].filter(Boolean).join('; ')}. ${soundChecked ? 'The file may be cut short or damaged.' : 'So the sound is not checked.'} ${fileFacts.join(', ')}.`
      : `${errorText ? `${errorText}. Each track has audio data to its end, so the file is not cut short; the errors can be damage inside the file. ` : ''}${fileFacts.join(', ')}.`,
  });
  // Where the video ends on the timeline of the file. MKV and FLV state no length for it: then its packets give the end.
  const video = probe.video;
  let videoEndS = video?.durationS === undefined ? undefined : video.startS + video.durationS;
  let videoNotRead = '';
  if (video && videoEndS === undefined) {
    const v = await run(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', '-f', format, '-i', input], left(), limits.timeoutS);
    let end = -Infinity;
    for (const line of v.out.split('\n')) {
      const [pts, length] = line.split(',');
      if (num(pts) !== undefined) end = Math.max(end, Number(pts) + (num(length) ?? 0));
    }
    if (v.stopped || v.code !== 0) videoNotRead = v.stopped ? `ffprobe stopped: ${v.stopped}` : `ffprobe exit code ${v.code}: ${clean(v.err) || 'no message'}`;
    else if (end > -Infinity) videoEndS = Math.max(0, end - probe.originS);
    else videoNotRead = 'the video stream has no packets';
  }
  const videoShort = videoEndS !== undefined && duration - videoEndS >= 2;
  claims.push({
    claim: 'The file has a video stream for the full timeline',
    verdict: !video || videoShort ? 'warn' : videoEndS === undefined ? 'not_checked' : 'pass',
    evidence: !video
      ? 'No video stream.'
      : videoEndS === undefined
        ? `The video stream states no length, and reading its packets did not finish: ${videoNotRead}.`
        : `Video ${timecode(videoEndS)} of ${timecode(duration)}${video.durationS === undefined ? ', from its packets: the video stream states no length' : ''}.`,
  });
  claims.push({ claim: 'The file has audio', verdict: n ? 'pass' : 'fail', evidence: n ? `${count(n, 'audio track')}.` : 'No audio stream.' });
  if (n && soundChecked) claims.push(...judge(probe, measures, expect, limits));
  else if (expect.length) claims.push(...expect.map((e) => ({ claim: `Source ${JSON.stringify(e.name)} (${e.kind}) has sound on track ${e.track}`, verdict: (n ? 'not_checked' : 'fail') as Verdict, evidence: n ? `Sound not checked: ${fileProblems.join('; ')}.` : 'The file has no audio stream.' })));

  const roles = new Map<number, string>();
  for (const e of expect) {
    roles.set(e.track, `source ${JSON.stringify(e.name)} (${e.kind})`);
    if (e.backup && !roles.has(e.backup)) roles.set(e.backup, `backup of ${JSON.stringify(e.name)}`);
  }
  const tracks = soundChecked
    ? measures.map((m) => {
        // Every silent interval that the detector reports, from d up; the verdicts use the gap limits.
        const shown = shownOf(m, limits);
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
  return done(claims, { checked_with: version, duration: timecode(duration), video_duration: videoEndS === undefined ? null : timecode(videoEndS), tracks });
}

/** The macOS fallback: afinfo reads the audio tracks and their durations. It cannot read sound levels or video. */
async function afinfoClaims(afinfo: string, path: string, expect: Expected[], notChecked: string, timeoutMs: number): Promise<Claim[]> {
  const r = await run(afinfo, [path], timeoutMs);
  const n = Number(/Num Tracks:\s+(\d+)/.exec(r.out)?.[1] ?? (/estimated duration/.test(r.out) ? 1 : 0));
  const durations = [...r.out.matchAll(/estimated duration: ([\d.]+) sec/g)].map((m) => Number(m[1]));
  if (r.code !== 0 || r.stopped || !durations.length) {
    // afinfo cannot tell a file with no audio from a damaged file, so this says nothing about the file.
    const why = r.stopped
      ? `afinfo stopped: ${r.stopped}`
      : FORMATS[extname(path).toLowerCase()] === 'mov'
        ? 'afinfo cannot read audio in this file: it may hold no audio, be damaged or be cut short'
        : 'afinfo cannot read this format: it reads MOV and MP4, not MKV, FLV or TS';
    return [
      { claim: 'The file is readable and complete', verdict: 'not_checked', evidence: `${why}. Nothing in the file was checked. ${notChecked}.` },
      { claim: 'The file has sound', verdict: 'not_checked', evidence: notChecked },
    ];
  }
  const claims: Claim[] = [
    { claim: 'The file is readable and complete', verdict: 'not_checked', evidence: `afinfo reads ${count(n, 'audio track')}, ${durations.map((d, i) => `track ${i + 1} ${timecode(d)}`).join(', ')}. afinfo does not show a cut-short file or the video. ${notChecked}.` },
  ];
  // afinfo reads no sound, so a source with a track in the file stays not_checked; its evidence names a missing track.
  for (const e of expect) {
    const has = (t?: number) => t !== undefined && t <= n;
    const tracks = [`Track ${e.track} is ${has(e.track) ? 'present' : 'missing'}`, ...(e.backup ? [`backup track ${e.backup} is ${has(e.backup) ? 'present' : 'missing'}`] : [])].join(', and ');
    const anyTrack = has(e.track) || has(e.backup);
    claims.push({ claim: `Source ${JSON.stringify(e.name)} (${e.kind}) has sound on track ${e.track}`, verdict: anyTrack ? 'not_checked' : 'fail', evidence: `${tracks}: the file has ${count(n, 'audio track')}.${anyTrack ? ` ${notChecked}.` : ''}` });
  }
  if (!expect.length) claims.push({ claim: 'The file has sound', verdict: 'not_checked', evidence: notChecked });
  return claims;
}
