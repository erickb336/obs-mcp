// SIMULATED media for the file check: made by ffmpeg in a temporary folder, never by OBS, and never committed.
// Each file has a small video stream (64x64, 2 fps) and AAC audio tracks in a MOV container, as OBS records by default.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioTools } from '../dist/platform.js';

const tools = audioTools();
/** Why the fixture tests skip, or undefined when ffmpeg and ffprobe are on PATH. */
export const SKIP = tools.ffmpeg && tools.ffprobe ? undefined : `SIMULATED fixture tests skipped: ffmpeg and ffprobe are not on PATH. Install: ${tools.install}`;
export const FFMPEG_VERSION = SKIP ? undefined : execFileSync(tools.ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0].replace(/ Copyright.*$/, '');

const sine = (f, d, amp = 0.3) => ['-f', 'lavfi', '-i', `aevalsrc=${amp}*sin(${f}*2*PI*t):s=48000:d=${d}`];
const silence = (d) => ['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${d}`];
const video = (d) => ['-f', 'lavfi', '-i', `testsrc=size=64x64:rate=2:d=${d}`];

function make(dir, name, inputs, extra = []) {
  const file = join(dir, name);
  const n = inputs.length;
  const maps = Array.from({ length: n }, (_, i) => ['-map', String(i)]).flat();
  execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs.flat(), ...maps, '-c:v', 'mpeg4', '-c:a', 'aac', ...extra, file]);
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
  };
  const cut = (from, name, fraction) => {
    const to = join(dir, name);
    copyFileSync(from, to);
    truncateSync(to, Math.floor(statSync(to).size * fraction));
    return to;
  };
  f.truncatedNoIndex = cut(f.healthy, 'SIMULATED-truncated-no-index.mov', 0.6);
  f.truncatedIndexKept = cut(f.faststart, 'SIMULATED-truncated-index-kept.mov', 0.5);
  // A name that a shell or an option parser would misread.
  f.odd = join(dir, "-i odd 'name' ;$(touch PWNED).mov");
  copyFileSync(f.healthy, f.odd);
  return { dir, f };
}
