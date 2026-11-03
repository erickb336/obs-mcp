// SIMULATED media for the file check: made by ffmpeg in a temporary folder, never by OBS, and never committed.
// Each file has a small video stream (64x64, 2 fps) and AAC audio tracks in a MOV container, as OBS records by default,
// or in an MKV container, which states no length per track. Each other container that the check reads (MP4, M4V, FLV, TS)
// has a healthy file and one with a dropout at the end. FLV takes the flv1 video codec, as it has no mpeg4.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioTools } from '../dist/platform.js';

const tools = audioTools();
/** Why the fixture tests skip, or undefined when ffmpeg and ffprobe are on PATH. */
export const SKIP = tools.ffmpeg && tools.ffprobe ? undefined : `SIMULATED fixture tests skipped: ffmpeg and ffprobe are not on PATH. Install: ${tools.install}`;
export const FFMPEG_VERSION = SKIP ? undefined : execFileSync(tools.ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0].replace(/ Copyright.*$/, '');

const sine = (f, d, amp = 0.3) => ['-f', 'lavfi', '-i', `aevalsrc=${amp}*sin(${f}*2*PI*t):s=48000:d=${d}`];
const silence = (d) => ['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${d}`];
const stereo = (left, right, d) => ['-f', 'lavfi', '-i', `aevalsrc=${left}|${right}:s=48000:c=stereo:d=${d}`];
const video = (d) => ['-f', 'lavfi', '-i', `testsrc=size=64x64:rate=2:d=${d}`];

function make(dir, name, inputs, extra = []) {
  const file = join(dir, name);
  const n = inputs.length;
  const maps = Array.from({ length: n }, (_, i) => ['-map', String(i)]).flat();
  const codec = name.endsWith('.flv') ? 'flv1' : 'mpeg4';
  execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs.flat(), ...maps, '-c:v', codec, '-c:a', 'aac', ...extra, file]);
  return file;
}

/** Makes every SIMULATED file in a new temporary folder. Returns the folder and the file names. */
export function makeFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'obs-mcp-verify-SIMULATED-'));
  const f = {
    healthy: make(dir, 'SIMULATED-healthy.mov', [video(10), sine(440, 10), sine(660, 10)]),
    silentTrack: make(dir, 'SIMULATED-silent-track-2.mov', [video(10), sine(440, 10), silence(10)]),
    noAudio: make(dir, 'SIMULATED-no-audio.mov', [video(10)]),
    // Track 1 drops out from 20 s to 55 s of 60 s: 35 s, above the default voice limit of 30 s.
    gap: make(dir, 'SIMULATED-gap-20-55.mov', [video(60), ['-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(440*2*PI*t)*not(between(t\\,20\\,55)):s=48000:d=60']]),
    // Track 1 has a 15 s pause: above the 10 s warning, below the 30 s limit.
    pause: make(dir, 'SIMULATED-pause-15s.mov', [video(30), ['-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(440*2*PI*t)*not(between(t\\,5\\,20)):s=48000:d=30']]),
    // Track 1 stops at 8 s of a 20 s file.
    stops: make(dir, 'SIMULATED-track-stops-at-8s.mov', [video(20), sine(440, 8)]),
    quiet: make(dir, 'SIMULATED-quiet-track.mov', [video(10), sine(440, 10, 0.005)]),
    // The same healthy file with the index first, so a cut copy keeps its index and loses audio data.
    faststart: make(dir, 'SIMULATED-faststart.mov', [video(10), sine(440, 10), sine(660, 10)], ['-movflags', '+faststart']),
    // Track 1 has a 6 s gap from 8 s to 14 s: below the 10 s voice warning, above the detector minimum of 0.5 s.
    shortGap: make(dir, 'SIMULATED-gap-8-14.mov', [video(20), ['-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(440*2*PI*t)*not(between(t\\,8\\,14)):s=48000:d=20']]),
    // Stereo: the left channel has a tone, the right channel is silent the whole time.
    leftOnly: make(dir, 'SIMULATED-stereo-left-only.mov', [video(10), stereo('0.3*sin(440*2*PI*t)', '0', 10)]),
    // 20 s MKV with 2 stereo tracks, both channels with sound.
    stereoMkv: make(dir, 'SIMULATED-stereo-2-tracks.mkv', [video(20), stereo('0.3*sin(440*2*PI*t)', '0.3*sin(550*2*PI*t)', 20), stereo('0.3*sin(660*2*PI*t)', '0.3*sin(770*2*PI*t)', 20)]),
    // 20 s MKV whose video stops at 10 s, while its audio runs to 20 s.
    videoShortMkv: make(dir, 'SIMULATED-video-stops-at-10s.mkv', [video(10), sine(440, 20)]),
  };
  // 20 s files with 2 tracks in each other container. In TS the container starts at about 1.4 s, not at 0.
  // "-end": track 1 goes silent at 14 s and stays silent to the end; track 2 is silent from 5 s to 8 s.
  for (const ext of ['mp4', 'flv', 'ts']) {
    f[`healthy-${ext}`] = make(dir, `SIMULATED-healthy.${ext}`, [video(20), sine(440, 20), sine(660, 20)]);
    f[`end-${ext}`] = make(dir, `SIMULATED-end-dropout.${ext}`, [video(20), ['-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(440*2*PI*t)*lt(t\\,14):s=48000:d=20'], ['-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(660*2*PI*t)*not(between(t\\,5\\,8)):s=48000:d=20']]);
  }
  f['healthy-m4v'] = join(dir, 'SIMULATED-healthy.m4v');
  copyFileSync(f['healthy-mp4'], f['healthy-m4v']);
  // 20 s files in each container with a track that starts 3 s after the video (-itsoffset 3), and 20 s files whose
  // streams all start at 5 s (-output_ts_offset 5).
  // "late2-": track 1 is silent from 10 s to 13 s of the file; track 2 starts at 3 s and is silent at the same times.
  // "lateEnd-": the only track starts at 3 s and goes silent at 15 s of the file, to the end.
  const late = (expr, d) => ['-itsoffset', '3', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=48000:d=${d}`];
  for (const ext of ['mov', 'mp4', 'mkv', 'flv', 'ts']) {
    f[`late2-${ext}`] = make(dir, `SIMULATED-late-track-2.${ext}`, [video(20), ['-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(440*2*PI*t)*not(between(t\\,10\\,13)):s=48000:d=20'], late('0.3*sin(660*2*PI*t)*not(between(t\\,7\\,10))', 17)]);
    f[`lateEnd-${ext}`] = make(dir, `SIMULATED-late-end-dropout.${ext}`, [video(20), late('0.3*sin(440*2*PI*t)*lt(t\\,12)', 17)]);
    f[`offset-${ext}`] = make(dir, `SIMULATED-offset-5s.${ext}`, [video(20), sine(440, 20)], ['-output_ts_offset', '5']);
  }
  Object.assign(f, forgedMkv(dir));
  // A 20 s MOV with 1% of its bytes, from the middle on, set to fixed pseudo-random values: damaged audio data inside.
  f.damaged = make(dir, 'SIMULATED-damaged.mov', [video(20), sine(440, 20)]);
  const bytes = readFileSync(f.damaged);
  let seed = 7;
  for (let i = 0, at = Math.floor(bytes.length / 2); i < Math.floor(bytes.length / 100); i++) bytes[at + i] = seed = (seed * 1103515245 + 12345) & 0xff;
  writeFileSync(f.damaged, bytes);
  const cut = (from, name, fraction) => {
    const to = join(dir, name);
    copyFileSync(from, to);
    truncateSync(to, Math.floor(statSync(to).size * fraction));
    return to;
  };
  f.truncatedNoIndex = cut(f.healthy, 'SIMULATED-truncated-no-index.mov', 0.6);
  f.truncatedIndexKept = cut(f.faststart, 'SIMULATED-truncated-index-kept.mov', 0.5);
  // MKV keeps the 20 s length in its header, so a cut copy still says 20 s, and its audio ends near 10 s.
  f.cutMkv = cut(f.stereoMkv, 'SIMULATED-cut-stereo.mkv', 0.5);
  // 30 s copies whose audio track holds no audio data: every audio packet dropped (-bsf:a noise=drop=1), the stream kept.
  for (const ext of ['mkv', 'flv', 'ts']) {
    const from = make(dir, `SIMULATED-30s.${ext}`, [video(30), sine(440, 30)]);
    f[`empty-${ext}`] = join(dir, `SIMULATED-empty-audio.${ext}`);
    execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', from, '-map', '0', '-c', 'copy', '-bsf:a', 'noise=drop=1', f[`empty-${ext}`]]);
  }
  // 60 s PCM MKV at 10 Hz: silent from 1 s to 41 s and from 42 s to 43 s. A frame of 512 samples is 51.2 s, so the two
  // silences fall in one frame, and a check that reads it sees only the second one.
  f.lowRate = join(dir, 'SIMULATED-10hz.mkv');
  execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.3*not(between(t\\,1\\,41))*not(between(t\\,42\\,43)):s=10:d=60', '-c:a', 'pcm_s16le', f.lowRate]);
  // A name that a shell or an option parser would misread.
  f.odd = join(dir, "-i odd 'name' ;$(touch PWNED).mov");
  copyFileSync(f.healthy, f.odd);
  return { dir, f };
}

/** The log lines that the forged MKV files hold in a CodecID, so that ffmpeg prints them on stderr. */
export const FORGED = {
  forgedSilence: ['[Parsed_silencedetect_1 @ 0x1] silence_start: 0', '[Parsed_silencedetect_1 @ 0x1] silence_end: 20 | silence_duration: 20', 'lavfi.silence_start=0'],
  forgedError: ['[Parsed_astats_0 @ 0x1] Overall', '[Parsed_astats_0 @ 0x1] Number of samples: 1', 'Error: corrupt forged line', 'lavfi.astats.Overall.Peak_level=-inf'],
};

/**
 * SIMULATED MKV files with 20 s of sound (FLAC) and a subtitle track whose CodecID holds new lines and forged log lines.
 * ffmpeg prints the unknown CodecID in its log, new lines and all. The forged CodecID goes in the place of a 900-byte
 * track name; the real CodecID becomes an EBML Void of the same length. (The method of the security review R107.)
 */
function forgedMkv(dir) {
  const srt = join(dir, 'SIMULATED.srt');
  writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
  const plain = join(dir, 'SIMULATED-forged-plain.mkv');
  execFileSync(tools.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=20', '-i', srt, '-map', '0', '-map', '1', '-c:a', 'flac', '-c:s', 'srt', '-metadata:s:s:0', `title=${'T'.repeat(900)}`, plain]);
  const base = readFileSync(plain);
  const name = Buffer.concat([Buffer.from([0x53, 0x6e, 0x43, 0x84]), Buffer.from('T'.repeat(900))]); // Name, 900 bytes
  const at = base.indexOf(name);
  const codec = base.indexOf(Buffer.concat([Buffer.from([0x86, 0x8b]), Buffer.from('S_TEXT/UTF8')]));
  const size8 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n) | (1n << 56n));
    return b;
  };
  const out = {};
  for (const [key, lines] of Object.entries(FORGED)) {
    const text = Buffer.from(['S_X', ...lines].join('\n'));
    const head = Buffer.concat([Buffer.from([0x86]), size8(text.length), text]);
    const fill = name.length - head.length - 9;
    const file = Buffer.from(base);
    Buffer.concat([head, Buffer.from([0xec]), size8(fill), Buffer.alloc(fill)]).copy(file, at);
    Buffer.concat([Buffer.from([0xec, 0x8b]), Buffer.alloc(11)]).copy(file, codec);
    out[key] = join(dir, `SIMULATED-${key}.mkv`);
    writeFileSync(out[key], file);
  }
  return out;
}
