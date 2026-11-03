// The file check. Part 1 runs everywhere: the parser on captured ffmpeg text, the rules, the path guard and the
// settings. Part 2 runs ffmpeg on SIMULATED files that test/fixtures.mjs makes; it skips, with the reason, when ffmpeg
// is not on PATH. No file here comes from OBS: the real-file test is test/real-files.test.mjs, and it is opt-in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { audioTools } from '../dist/platform.js';
import { judge, limitsFrom, measure, parseLog, parseProbe, resolveInFolder, timecode, verifyFile } from '../dist/verify.js';
import { startFakeObs } from './fake-obs.mjs';
import { FFMPEG_VERSION, makeFixtures, SKIP } from './fixtures.mjs';
import { closedPort, connect, obsConfigDir, testEnv } from './helpers.mjs';

// Captured on SIMULATED 60 s files, one ffmpeg pass per track. Track 1 has sound. Track 2 goes silent at 25 s and
// stays silent to the end, so silencedetect gives the end at the end of the file. ffmpeg 9.0.2 names the filter
// "Parsed_silencedetect_1"; ffmpeg 8.0.1 (Ubuntu 26.04, captured in CI) gives only "silencedetect". Addresses as printed.
const TRACK_1_FFMPEG_9 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'file:/rec/take.mov':
  Metadata:
    title           : an error in the title is not an error line
Stream mapping:
[Parsed_astats_0 @ 0x7663021200] Overall
[Parsed_astats_0 @ 0x7663021200] Peak level dB: -6.020600
[Parsed_astats_0 @ 0x7663021200] RMS level dB: -9.031275
[Parsed_astats_0 @ 0x7663021200] Number of samples: 2880000
[out#0/null @ 0x78b1048600] video:0KiB audio:2816KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
`;
const TRACK_2_FFMPEG_8 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'file:/rec/take.mov':
Stream mapping:
Output #0, null, to 'pipe:':
[silencedetect @ 0x7700b00026c0] silence_start: 25.000854
[silencedetect @ 0x7700b00026c0] silence_end: 60 | silence_duration: 34.999146
[Parsed_astats_0 @ 0x7700b0002340] Overall
[Parsed_astats_0 @ 0x7700b0002340] Peak level dB: -31.500000
[Parsed_astats_0 @ 0x7700b0002340] RMS level dB: -40.100000
[Parsed_astats_0 @ 0x7700b0002340] Number of samples: 2880000
`;
const LOGS = [parseLog(TRACK_1_FFMPEG_9, '/rec/take.mov').track, parseLog(TRACK_2_FFMPEG_8, '/rec/take.mov').track];
const PROBE_60 = JSON.stringify({
  streams: [
    { codec_type: 'video', duration: '60.000000', start_time: '0.000000' },
    { codec_type: 'audio', sample_rate: '48000', duration: '60.000000', start_time: '0.000000' },
    { codec_type: 'audio', sample_rate: '48000', duration: '60.000000', start_time: '0.000000' },
  ],
  format: { duration: '60.000000' },
});
const limits = limitsFrom({});
const verdicts = (claims) => Object.fromEntries(claims.map((c) => [c.claim, c.verdict]));

describe('parser and rules, on captured ffmpeg text (no ffmpeg needed)', () => {
  test('parseLog reads level, samples and silent intervals in the ffmpeg 9 and 8 formats, and ignores a metadata line that says "error"', () => {
    assert.deepEqual(parseLog(TRACK_1_FFMPEG_9, '/rec/take.mov'), { track: { silences: [], peakDb: -6.0206, rmsDb: -9.031275, samples: 2880000 }, errors: [] });
    assert.deepEqual(parseLog(TRACK_2_FFMPEG_8, '/rec/take.mov'), { track: { silences: [{ start: 25.000854, end: 60 }], peakDb: -31.5, rmsDb: -40.1, samples: 2880000 }, errors: [] });
    // The instance-name format of ffmpeg 9.
    assert.deepEqual(parseLog('[silencedetect@t1 @ 0x1] silence_start: 3\n').track.silences, [{ start: 3 }]);
  });

  test('a dropout that the overall peak does not show fails a voice, with the timecode of the gap', () => {
    // This is the case in the design: track 2 peak -31.5 dB looks fine, and the track is silent from 25 s to 60 s.
    const probe = parseProbe(PROBE_60);
    const claims = judge(probe, measure(probe, LOGS), [{ name: 'Remote', kind: 'voice', track: 2 }], limits);
    const remote = claims.find((c) => c.claim === 'Source "Remote" (voice) has sound on track 2');
    assert.equal(remote.verdict, 'fail');
    assert.deepEqual(remote.gaps, [{ from: '00:00:25.0', to: '00:01:00.0', seconds: 35, why: 'silent' }]);
    assert.match(remote.evidence, /^A gap of 30 s or more: Track 2: peak -31\.5 dB/);
  });

  test('a silence with no end in the log ends where the track ends; a track that ends early leaves "no audio data"', () => {
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '20' }], format: { duration: '30' } }));
    const log = parseLog('[silencedetect @ 0x1] silence_start: 15\n[Parsed_astats_0 @ 0x2] Number of samples: 960000\n[Parsed_astats_0 @ 0x2] Peak level dB: -10\n');
    const [m] = measure(probe, [log.track]);
    assert.deepEqual(m.silences, [{ start: 15, end: 30, why: 'no audio data' }]);
    assert.equal(m.soundS, 15);
  });

  test('F-T5-9: a silent track whose audio data ends 0.06 s before the file has 0 s of sound, not 0.1 s', () => {
    // The numbers of a silent track as ffprobe and ffmpeg 9 give them: 718752 samples (14.974 s) in a 15.033 s file.
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '14.974', start_time: '0' }], format: { duration: '15.033333' } }));
    const log = parseLog('[Parsed_silencedetect_1 @ 0x1] silence_start: 0\n[Parsed_astats_0 @ 0x2] Peak level dB: -inf\n[Parsed_astats_0 @ 0x2] Number of samples: 718752\n[Parsed_silencedetect_1 @ 0x1] silence_end: 14.974 | silence_duration: 14.974\n');
    const [m] = measure(probe, [log.track]);
    assert.equal(m.soundS, 0);
    assert.match(judge(probe, [m], [], limits)[0].evidence, /^Silent\. Track 1: peak -inf dB, RMS unknown, sound 0\.0 s of 15\.0 s, 1 silent interval: 00:00:00\.0 to 00:00:15\.0\.$/);
  });

  test('F-T5-8: parseLog reads the peak of each channel apart from the overall peak', () => {
    const text = ['Channel: 1', 'Peak level dB: -5.362297', 'Channel: 2', 'Peak level dB: -inf', 'Overall', 'Peak level dB: -5.362297', 'RMS level dB: -11.2', 'Number of samples: 480000'].map((l) => `[Parsed_astats_0 @ 0x1] ${l}`).join('\n');
    assert.deepEqual(parseLog(text, '', 2).track, { silences: [], channelPeaksDb: [-5.362297, -Infinity], peakDb: -5.362297, rmsDb: -11.2, samples: 480000 });
  });

  test('a backup track with sound turns a silent source into a warning that names the backup', () => {
    const probe = parseProbe(PROBE_60);
    const silent = parseLog('[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 60 | silence_duration: 60\n').track;
    const sound = parseLog('[Parsed_astats_0 @ 0x2] Peak level dB: -20\n').track;
    const [own] = judge(probe, measure(probe, [silent, sound]), [{ name: 'Remote', kind: 'voice', track: 1, backup: 2 }], limits);
    assert.equal(own.verdict, 'warn');
    assert.match(own.evidence, /^Track 1 fails alone, and backup track 2 has sound there/);
    // Both silent: the backup does not save it.
    const open = parseLog('[silencedetect @ 0x1] silence_start: 0\n').track;
    assert.equal(judge(probe, measure(probe, [open, open]), [{ name: 'Remote', kind: 'voice', track: 1, backup: 2 }], limits)[0].verdict, 'fail');
  });

  test('kinds: a 3 s gap fails continuous, warns nothing for voice, and any needs only some sound', () => {
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '60' }], format: { duration: '60' } }));
    const log = parseLog('[silencedetect @ 0x1] silence_start: 10\n[silencedetect @ 0x1] silence_end: 13 | silence_duration: 3\n[Parsed_astats_0 @ 0x2] Peak level dB: -20\n');
    const m = measure(probe, [log.track]);
    const v = (kind) => judge(probe, m, [{ name: 'S', kind, track: 1 }], limits)[0].verdict;
    assert.deepEqual([v('continuous'), v('voice'), v('any')], ['fail', 'pass', 'pass']);
  });

  test('error lines: a file name with "truncated" is not an error, a partial file is, and the reply has no full path', () => {
    const text = "Input #0, mov, from 'file:/rec/truncated.mov':\n[in#0/mov @ 0x1] stream 1, offset 0x18b28: partial file\n[mov @ 0x2] Could not open /rec/truncated.mov: moov atom not found\n";
    assert.deepEqual(parseLog(text, '/rec/truncated.mov').errors, ['[in#0/mov] stream 1, offset 0x18b28: partial file', '[mov] Could not open truncated.mov: moov atom not found']);
  });

  test('timecode and settings', () => {
    assert.deepEqual([timecode(0), timecode(25), timecode(3725.04)], ['00:00:00.0', '00:00:25.0', '01:02:05.0']);
    assert.equal(limitsFrom({ OBS_MCP_VOICE_GAP_S: '5' }).gap.voice.fail, 5);
    assert.equal(limitsFrom({ OBS_MCP_VOICE_GAP_S: '5' }).gap.voice.warn, 5);
    assert.throws(() => limitsFrom({ OBS_MCP_SILENCE_DB: 'loud' }), /OBS_MCP_SILENCE_DB is "loud"\. It must be a number from -120 to -1/);
  });

  test('F-T5-13: on an MPEG-TS probe, a stream start counts from the container start: no false gap, and the track is not cut short', () => {
    // The numbers of a SIMULATED 20 s TS from ffprobe 9.0.2: the container and the audio start at 1.445333 s.
    const probe = parseProbe(JSON.stringify({
      streams: [
        { codec_type: 'video', duration: '20.000000', start_time: '1.466667' },
        { codec_type: 'audio', sample_rate: '48000', channels: 1, duration: '19.733333', start_time: '1.445333' },
        { codec_type: 'audio', sample_rate: '48000', channels: 1, duration: '19.968000', start_time: '1.445333' },
      ],
      format: { duration: '20.021334', start_time: '1.445333' },
    }));
    // ffmpeg moves its timeline to the container start, so a dropout at the end of the file is at 14 s to 20 s in the log.
    const log = parseLog('[Parsed_silencedetect_1 @ 0x1] silence_start: 14.022333\n[Parsed_astats_0 @ 0x2] Number of samples: 961536\n[Parsed_astats_0 @ 0x2] Peak level dB: -5\n[Parsed_silencedetect_1 @ 0x1] silence_end: 20.032 | silence_duration: 6.009667\n').track;
    const sound = parseLog('[Parsed_astats_0 @ 0x2] Number of samples: 961536\n[Parsed_astats_0 @ 0x2] Peak level dB: -5\n').track;
    const [a, b] = measure(probe, [log, sound]);
    assert.deepEqual([a.endS, a.silences], [20.021334, [{ start: 14.022333, end: 20.021334, why: 'silent' }]]);
    assert.deepEqual([b.endS, b.silences, b.expectedEndS], [20.021334, [], 19.968]);
    assert.ok(a.expectedEndS < a.endS + 1, `expected end ${a.expectedEndS}`);
    assert.deepEqual(judge(probe, [a, b], [{ name: 'Music', kind: 'continuous', track: 1 }], limits)[0].gaps, [{ from: '00:00:14.0', to: '00:00:20.0', seconds: 6, why: 'silent' }]);
  });

  test('F-T5-11: one silent track is "The only audio track is silent"; sound on one or two tracks has the right plural', () => {
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '10' }, { codec_type: 'audio', sample_rate: '48000', duration: '10' }], format: { duration: '10' } }));
    const silent = parseLog('[silencedetect @ 0x1] silence_start: 0\n').track;
    const sound = parseLog('[Parsed_astats_0 @ 0x2] Peak level dB: -20\n').track;
    const last = (logs) => judge({ ...probe, audio: probe.audio.slice(0, logs.length) }, measure({ ...probe, audio: probe.audio.slice(0, logs.length) }, logs), [], limits).at(-1).evidence;
    assert.deepEqual([last([silent]), last([silent, silent]), last([sound, silent]), last([sound, sound])], ['The only audio track is silent.', 'All 2 audio tracks are silent.', 'Sound on track 1.', 'Sound on tracks 1, 2.']);
  });

  test('F-T5-12: the rule text of a voice gives the limit and the warning, and lists no "gaps from"', () => {
    const probe = parseProbe(PROBE_60);
    const [c] = judge(probe, measure(probe, LOGS), [{ name: 'Mic', kind: 'voice', track: 1 }], limits);
    assert.match(c.evidence, /\. Rule: gap limit 30 s, a warning from 10 s\.$/);
  });

  test('F-T5-14: a backup track that the file does not have is a warning on its source, also when the source passes', () => {
    const probe = parseProbe(PROBE_60);
    const [c] = judge(probe, measure(probe, LOGS), [{ name: 'Mic', kind: 'voice', track: 1, backup: 3 }], limits);
    assert.equal(c.verdict, 'warn');
    assert.match(c.evidence, /^Backup track 3 is missing: the file has 2 audio tracks\. Track 1: peak -6\.0 dB/);
  });

  test('F-T5-15: the backup check is linear: 100,000 silences on a track and on its backup take well under a second', () => {
    // SIMULATED logs (no media needed): every 5 s, track 1 is silent 2.5 s from 0 s, and its backup 2.5 s from 2.2 s.
    const log = (offset) => {
      const lines = [];
      for (let i = 0; i < 100000; i++) lines.push(`[silencedetect @ 0x1] silence_start: ${5 * i + offset}`, `[silencedetect @ 0x1] silence_end: ${5 * i + offset + 2.5} | silence_duration: 2.5`);
      return parseLog(lines.join('\n')).track;
    };
    const [own, backup] = [log(0), log(2.2)];
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '500000' }, { codec_type: 'audio', sample_rate: '48000', duration: '500000' }], format: { duration: '500000' } }));
    const t = Date.now();
    const [c] = judge(probe, measure(probe, [own, backup]), [{ name: 'Mic', kind: 'continuous', track: 1, backup: 2 }], limits);
    const took = Date.now() - t;
    assert.ok(took < 1000, `judge took ${took} ms`);
    // Track 1 fails alone (2.5 s gaps). Both are silent together 0.3 s each time, below the continuous warning of 0.5 s.
    assert.equal(c.verdict, 'warn');
    assert.match(c.evidence, /^Track 1 fails alone, and backup track 2 has sound there/);
  });

  test('F-T5-15: parseLog keeps at most 100,000 silent intervals of a track, and counts the rest', () => {
    const lines = [];
    for (let i = 0; i < 150000; i++) lines.push(`[silencedetect @ 0x1] silence_start: ${i}`, `[silencedetect @ 0x1] silence_end: ${i + 0.6} | silence_duration: 0.6`);
    const { track } = parseLog(lines.join('\n'));
    assert.deepEqual([track.silences.length, track.dropped, track.silences.at(-1)], [100000, 50000, { start: 99999, end: 99999.6 }]);
  });

  test('F-T5-16: a channel index counts only from 1 to the channel count of the track, so a forged index does nothing', () => {
    const text = ['Channel: 1', 'Peak level dB: -5', 'Channel: 1000000000', 'Peak level dB: -1', 'Channel: 3', 'Peak level dB: -2', 'Channel: 2', 'Peak level dB: -inf', 'Overall', 'Peak level dB: -5'].map((l) => `[Parsed_astats_0 @ 0x1] ${l}`).join('\n');
    const t = Date.now();
    const { track } = parseLog(text, '', 2);
    assert.ok(Date.now() - t < 100);
    assert.deepEqual([track.channelPeaksDb, track.peakDb], [[-5, -Infinity], -5]);
    // With 1 channel, channel 2 is ignored too.
    assert.deepEqual(parseLog(text, '', 1).track.channelPeaksDb, [-5]);
  });

  test('without ffmpeg and without afinfo, the result says "sound not checked" and the install line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-mcp-nothing-'));
    writeFileSync(join(dir, 'take.mov'), 'not checked');
    const r = await verifyFile(join(dir, 'take.mov'), 'take.mov', [], { PATH: mkdtempSync(join(tmpdir(), 'obs-mcp-empty-path-')) });
    assert.equal(r.state, 'not_checked');
    assert.match(r.claims[0].evidence, new RegExp(`^Sound not checked: ffmpeg and ffprobe not found \\(PATH, or OBS_MCP_FFMPEG\\)\\. Install: ${audioTools().install.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});

test('a tool that hangs or floods its output is stopped, and the result is not_checked', { skip: process.platform === 'win32' && 'the stand-in tools are shell scripts' }, async () => {
  const tool = (body) => {
    const bin = mkdtempSync(join(tmpdir(), 'obs-mcp-standin-'));
    for (const name of ['ffmpeg', 'ffprobe']) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return join(bin, 'ffmpeg');
  };
  const file = join(mkdtempSync(join(tmpdir(), 'obs-mcp-take-')), 'take.mov');
  writeFileSync(file, 'x');
  const hang = await verifyFile(file, 'take.mov', [], { OBS_MCP_FFMPEG: tool('sleep 30'), OBS_MCP_VERIFY_TIMEOUT_S: '1' });
  assert.deepEqual([hang.state, hang.claims[0].evidence], ['not_checked', 'ffprobe stopped: the check passed its time limit of 1 s (OBS_MCP_VERIFY_TIMEOUT_S). Nothing in the file was checked.']);
  const flood = await verifyFile(file, 'take.mov', [], { OBS_MCP_FFMPEG: tool('yes | head -c 40000000') });
  assert.deepEqual([flood.state, flood.claims[0].evidence], ['not_checked', 'ffprobe stopped: its output passed 33554432 bytes. Nothing in the file was checked.']);
});

test('F-T5-3: OBS_MCP_VERIFY_TIMEOUT_S is one deadline for the whole check, ffprobe and ffmpeg together', { skip: process.platform === 'win32' && 'the stand-in tools are shell scripts' }, async () => {
  // ffprobe takes 1.5 s and answers; the ffmpeg pass hangs. With a limit of 2 s the check must end near 2 s, not at 3.5 s.
  const bin = mkdtempSync(join(tmpdir(), 'obs-mcp-standin-'));
  const probe = `{"format":{"duration":"10"},"streams":[{"codec_type":"audio","sample_rate":"48000"}]}`;
  const body = `case "$0" in *ffprobe) sleep 1.5; echo '${probe}';; *) case "$*" in *-version*) echo 'ffmpeg version stand-in';; *) sleep 30;; esac;; esac`;
  for (const name of ['ffmpeg', 'ffprobe']) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const file = join(mkdtempSync(join(tmpdir(), 'obs-mcp-take-')), 'take.mov');
  writeFileSync(file, 'x');
  const t = Date.now();
  const r = await verifyFile(file, 'take.mov', [], { OBS_MCP_FFMPEG: join(bin, 'ffmpeg'), OBS_MCP_VERIFY_TIMEOUT_S: '2' });
  const took = Date.now() - t;
  assert.equal(r.state, 'not_checked');
  assert.match(r.claims[0].evidence, /^ffmpeg stopped on track 1: the check passed its time limit of 2 s/);
  assert.ok(took < 3000, `the check took ${took} ms for a limit of 2 s`);
});

/** Stand-in ffmpeg and ffprobe: one shell script, with a case per tool and argument. Returns the env of the check. */
const standIn = (body) => {
  const bin = mkdtempSync(join(tmpdir(), 'obs-mcp-standin-'));
  for (const name of ['ffmpeg', 'ffprobe']) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { OBS_MCP_FFMPEG: join(bin, 'ffmpeg') };
};
const standInFile = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'obs-mcp-take-')), 'take.mkv');
  writeFileSync(file, 'x');
  return file;
};

test('F-T5-10: a video stream with no stated length whose packets cannot be read is not_checked, never pass', { skip: process.platform === 'win32' && 'the stand-in tools are shell scripts' }, async () => {
  const probe = `{"format":{"duration":"10"},"streams":[{"codec_type":"video"},{"codec_type":"audio","sample_rate":"48000"}]}`;
  const env = standIn(`case "$0" in *ffprobe) case "$*" in *packet*) echo 'read error' >&2; exit 1;; *) echo '${probe}';; esac;; *) echo 'ffmpeg version stand-in';; esac`);
  const r = await verifyFile(standInFile(), 'take.mkv', [], env);
  assert.deepEqual(r.claims.find((c) => c.claim === 'The file has a video stream for the full timeline'), { claim: 'The file has a video stream for the full timeline', verdict: 'not_checked', evidence: 'The video stream states no length, and reading its packets did not finish: ffprobe exit code 1: read error.' });
  assert.equal(r.state, 'not_checked');
});

test('F-T5-15: a log with more than 100,000 silent intervals on a track leaves the sound not checked, and the check ends fast', { skip: process.platform === 'win32' && 'the stand-in tools are shell scripts' }, async () => {
  // SIMULATED: the stand-in ffmpeg prints 150,000 silences (about 10 MB) for the track.
  const probe = `{"format":{"duration":"200000"},"streams":[{"codec_type":"audio","sample_rate":"48000"}]}`;
  const flood = `awk 'BEGIN{for(i=0;i<150000;i++){printf "[silencedetect @ 0x1] silence_start: %d\\n[silencedetect @ 0x1] silence_end: %d.6 | silence_duration: 0.6\\n", i, i}}' >&2`;
  const env = standIn(`case "$0" in *ffprobe) echo '${probe}';; *) case "$*" in *-version*) echo 'ffmpeg version stand-in';; *) ${flood};; esac;; esac`);
  const t = Date.now();
  const r = await verifyFile(standInFile(), 'take.mkv', [{ name: 'Mic', kind: 'voice', track: 1, backup: 2 }], env);
  assert.ok(Date.now() - t < 10000, `the check took ${Date.now() - t} ms`);
  assert.equal(r.state, 'not_checked');
  assert.match(r.claims[0].evidence, /^ffmpeg reported more than 100000 silent intervals on track 1 \(50000 more\), more than a real track can have\. The sound check did not finish/);
});

describe('path guard: only a regular file inside the recording folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'obs-mcp-rec-'));
  const folder = join(root, 'recordings');
  mkdirSync(join(folder, 'sub'), { recursive: true });
  writeFileSync(join(folder, 'take.mov'), 'x');
  writeFileSync(join(folder, '-odd ;$(name).mov'), 'x');
  writeFileSync(join(root, 'secret.txt'), 'x');

  test('accepts a name, a name in a subfolder, a full path inside, and a name that starts with "-"', () => {
    assert.equal(resolveInFolder(folder, 'take.mov').name, 'take.mov');
    assert.equal(resolveInFolder(folder, join(folder, 'take.mov')).name, 'take.mov');
    assert.equal(resolveInFolder(folder, '-odd ;$(name).mov').name, '-odd ;$(name).mov');
    writeFileSync(join(folder, 'sub', 'b.mov'), 'x');
    assert.equal(resolveInFolder(folder, join('sub', 'b.mov')).name, join('sub', 'b.mov'));
  });

  test('refuses "..", a path outside, a folder, a missing file and an empty name', () => {
    assert.throws(() => resolveInFolder(folder, '../secret.txt'), /has "\.\."/);
    assert.throws(() => resolveInFolder(folder, 'sub/../../secret.txt'), /has "\.\."/);
    assert.throws(() => resolveInFolder(folder, join(root, 'secret.txt')), /is outside the recording folder/);
    assert.throws(() => resolveInFolder(folder, 'sub'), /is not a regular file/);
    assert.throws(() => resolveInFolder(folder, 'none.mov'), /No file "none\.mov" in the recording folder/);
    assert.throws(() => resolveInFolder(folder, ''), /Give the name of a file/);
  });

  const OUTSIDE = (input) => `${JSON.stringify(input)} is outside the recording folder, or a link leads out of it. The check reads only files inside the recording folder.`;

  test('F-T5-5: an outside file that exists and one that does not get the same refusal', () => {
    for (const p of [join(root, 'secret.txt'), join(root, 'no-such-file.txt')]) assert.throws(() => resolveInFolder(folder, p), { message: OUTSIDE(p) });
  });

  test('F-T5-4: an outside, UNC, device or namespace path is refused before any file system call reads it', () => {
    const seen = [];
    const spy = (orig) => function (p, ...rest) {
      seen.push(String(p));
      return orig.call(this, p, ...rest);
    };
    const saved = { realpathSync: fs.realpathSync, statSync: fs.statSync, lstatSync: fs.lstatSync };
    const native = fs.realpathSync.native;
    fs.realpathSync = Object.assign(spy(saved.realpathSync), { native });
    fs.statSync = spy(saved.statSync);
    fs.lstatSync = spy(saved.lstatSync);
    syncBuiltinESMExports();
    try {
      const inputs = ['/net/somehost/share/take.mov', '\\\\somehost\\share\\take.mov', '//somehost/share/take.mov', '\\\\?\\C:\\rec\\take.mov', '\\\\.\\pipe\\take', join(root, 'secret.txt')];
      for (const p of inputs) assert.throws(() => resolveInFolder(folder, p), { message: OUTSIDE(p) });
      assert.deepEqual(seen.filter((p) => !p.startsWith(folder) && p !== realpathSync(folder)), [], 'a file system call got a path outside the folder');
      // A file inside is still found, by a name or by the full path of the folder.
      assert.equal(resolveInFolder(folder, join(realpathSync(folder), 'take.mov')).name, 'take.mov');
    } finally {
      Object.assign(fs, saved);
      syncBuiltinESMExports();
    }
  });

  test('F-T5-16: a path with a new line, a carriage return or NUL is refused with one text, also when a link inside leads to it', { skip: process.platform === 'win32' && 'a file name with a new line is not valid on Windows' }, () => {
    const CONTROL = 'The path has a control character, for example a new line. The check does not read such a path: rename the file.';
    const forged = 'take.mov\n[Parsed_astats_0 @ 0x1] Channel: 1000000000';
    writeFileSync(join(folder, forged), 'x');
    for (const p of [forged, 'take\r.mov', 'take\0.mov']) assert.throws(() => resolveInFolder(folder, p), { message: CONTROL });
    symlinkSync(join(folder, forged), join(folder, 'plain.mov'));
    assert.throws(() => resolveInFolder(folder, 'plain.mov'), { message: CONTROL });
  });

  test('refuses a link that leads out of the folder', { skip: process.platform === 'win32' && 'a symbolic link needs extra rights on Windows' }, () => {
    symlinkSync(join(root, 'secret.txt'), join(folder, 'link.mov'));
    assert.throws(() => resolveInFolder(folder, 'link.mov'), /a link leads out of it/);
  });
});

describe('SIMULATED files made by ffmpeg', { skip: SKIP }, () => {
  if (SKIP) return;
  console.log(`SIMULATED fixtures made and checked with ${FFMPEG_VERSION}`);
  const { f } = makeFixtures();
  const check = (key, expect) => verifyFile(f[key], key, expect);

  test('SIMULATED healthy file with 2 tracks: verified, with each track and the video measured', async () => {
    const r = await check('healthy', [{ name: 'Mic', kind: 'voice', track: 1 }, { name: 'Music', kind: 'continuous', track: 2 }]);
    assert.equal(r.state, 'verified');
    assert.equal(r.duration, '00:00:10.0');
    assert.equal(r.video_duration, '00:00:10.0');
    assert.deepEqual(r.tracks.map((t) => [t.track, t.sound_s, t.silent_intervals.length]), [[1, 10, 0], [2, 10, 0]]);
    assert.ok(r.tracks.every((t) => t.peak_db > -10 && t.peak_db < -3), JSON.stringify(r.tracks));
  });

  test('SIMULATED silent track: failed for its source, and the file is not changed', async () => {
    const before = createHash('sha256').update(readFileSync(f.silentTrack)).digest('hex');
    const mtime = statSync(f.silentTrack).mtimeMs;
    const r = await check('silentTrack', [{ name: 'Remote', kind: 'voice', track: 2 }]);
    assert.equal(r.state, 'failed');
    assert.equal(verdicts(r.claims)['Source "Remote" (voice) has sound on track 2'], 'fail');
    assert.equal(createHash('sha256').update(readFileSync(f.silentTrack)).digest('hex'), before);
    assert.equal(statSync(f.silentTrack).mtimeMs, mtime);
  });

  test('SIMULATED silent track with a backup that has sound: verified_with_warnings, naming the backup', async () => {
    const r = await check('silentTrack', [{ name: 'Remote', kind: 'voice', track: 2, backup: 1 }]);
    assert.equal(r.state, 'verified_with_warnings');
    assert.match(r.claims.find((c) => c.claim.startsWith('Source "Remote"')).evidence, /backup track 1 has sound there/);
  });

  test('SIMULATED silent track with no expected source: a warning for that track', async () => {
    const r = await check('silentTrack', []);
    assert.equal(r.state, 'verified_with_warnings');
    assert.deepEqual([verdicts(r.claims)['Track 1 has sound'], verdicts(r.claims)['Track 2 has sound']], ['pass', 'warn']);
  });

  test('SIMULATED missing track: failed, "Track 3 is missing"', async () => {
    const r = await check('healthy', [{ name: 'Remote', kind: 'voice', track: 3 }]);
    assert.equal(r.state, 'failed');
    assert.match(r.claims.find((c) => c.claim.startsWith('Source "Remote"')).evidence, /^Track 3 is missing: the file has 2 audio tracks/);
  });

  test('SIMULATED file with no audio stream: failed', async () => {
    const r = await check('noAudio', []);
    assert.equal(r.state, 'failed');
    assert.deepEqual(r.claims.find((c) => c.claim === 'The file has audio'), { claim: 'The file has audio', verdict: 'fail', evidence: 'No audio stream.' });
  });

  test('SIMULATED mid-take dropout of 35 s on a voice: failed, gap 00:00:20.0 to 00:00:55.0', async () => {
    const r = await check('gap', [{ name: 'Remote', kind: 'voice', track: 1 }]);
    assert.equal(r.state, 'failed');
    const [g] = r.claims.find((c) => c.claim.startsWith('Source "Remote"')).gaps;
    assert.deepEqual([g.from, g.to, g.why], ['00:00:20.0', '00:00:55.0', 'silent']);
  });

  test('SIMULATED 15 s pause on a voice: verified_with_warnings, below the 30 s limit', async () => {
    const r = await check('pause', [{ name: 'Remote', kind: 'voice', track: 1 }]);
    assert.equal(r.state, 'verified_with_warnings');
    const c = r.claims.find((x) => x.claim.startsWith('Source "Remote"'));
    assert.deepEqual(c.gaps.map((g) => [g.from, g.to]), [['00:00:05.0', '00:00:20.0']]);
  });

  test('SIMULATED track that stops at 8 s of 20 s: a continuous source fails, "no audio data" from 00:00:08.0', async () => {
    const r = await check('stops', [{ name: 'Music', kind: 'continuous', track: 1 }]);
    assert.equal(r.state, 'failed');
    const [g] = r.claims.find((c) => c.claim.startsWith('Source "Music"')).gaps;
    assert.deepEqual([g.from, g.to, g.why], ['00:00:08.0', '00:00:20.0', 'no audio data']);
  });

  test('SIMULATED quiet track at -45 dB: verified_with_warnings, low level', async () => {
    const r = await check('quiet', []);
    assert.equal(r.state, 'verified_with_warnings');
    assert.match(r.claims.find((c) => c.claim === 'Track 1 has sound').evidence, /^Low level: peak -45\.0 dB is below -40 dB/);
  });

  test('SIMULATED truncated file with no index: failed, readable claim says "moov atom not found"', async () => {
    const r = await check('truncatedNoIndex', []);
    assert.equal(r.state, 'failed');
    assert.match(r.claims[0].evidence, /^ffprobe cannot read it: .*moov atom not found/);
  });

  test('SIMULATED truncated file that keeps its index: failed, each track "says 10.0 s, but its audio data ends at"', async () => {
    const r = await check('truncatedIndexKept', []);
    assert.equal(r.state, 'failed');
    assert.equal(r.claims[0].verdict, 'fail');
    assert.match(r.claims[0].evidence, /^Track 1 says 10\.0 s, but its audio data ends at 00:00:0\d\.\d/);
  });

  test('SIMULATED file with a name a shell or an option parser would misread: verified, and nothing runs', async () => {
    const r = await check('odd', []);
    assert.equal(r.state, 'verified');
    assert.equal(existsSync(join(f.odd, '..', 'PWNED')), false);
    assert.equal(existsSync('PWNED'), false);
  });

  test('F-T5-1: SIMULATED 20 s stereo MKV with 2 tracks: verified, with no channel warning', async () => {
    const r = await check('stereoMkv', []);
    assert.equal(r.state, 'verified', JSON.stringify(r.claims));
    assert.equal(r.duration, '00:00:20.0');
    assert.deepEqual(r.tracks.map((t) => [t.track, t.ends_at, t.silent_intervals.length]), [[1, '00:00:20.0', 0], [2, '00:00:20.0', 0]]);
  });

  test('F-T5-1: SIMULATED MKV cut to 50%: failed, each track "ends at 00:00:10.0, but the file runs to 00:00:20.0"', async () => {
    const r = await check('cutMkv', []);
    assert.equal(r.state, 'failed');
    assert.equal(r.claims[0].verdict, 'fail');
    assert.match(r.claims[0].evidence, /^Track 1 states no length, and its audio data ends at 00:00:10\.0, but the file runs to 00:00:20\.0; Track 2 states no length, and its audio data ends at 00:00:10\.0/);
    // A track with no expected source shows the tail with no audio data too.
    const t1 = r.claims.find((c) => c.claim === 'Track 1 has sound');
    assert.equal(t1.verdict, 'warn');
    assert.match(t1.evidence, /^No audio data for 10\.0 s\./);
    assert.deepEqual(t1.gaps, [{ from: '00:00:10.0', to: '00:00:20.0', seconds: 10, why: 'no audio data' }]);
  });

  test('F-T5-7: SIMULATED 6 s gap on a voice: verified, and the track lists the gap 00:00:08.0 to 00:00:14.0', async () => {
    const r = await check('shortGap', [{ name: 'Remote', kind: 'voice', track: 1 }]);
    assert.equal(r.state, 'verified');
    assert.deepEqual(r.tracks[0].silent_intervals, [{ from: '00:00:08.0', to: '00:00:14.0', seconds: 6, why: 'silent' }]);
  });

  test('F-T5-8: SIMULATED stereo track with a dead right channel: verified_with_warnings, "Channel 2 is silent"', async () => {
    const r = await check('leftOnly', []);
    assert.equal(r.state, 'verified_with_warnings');
    assert.match(r.claims.find((c) => c.claim === 'Track 1 has sound').evidence, /^Channel 2 is silent \(peak -inf dB\), and channel 1 has sound\. Track 1: peak -/);
  });

  for (const ext of ['mp4', 'm4v', 'flv', 'ts']) {
    test(`F-T5-13: SIMULATED healthy 20 s .${ext} with 2 tracks: verified, no silent interval, each track ends at 00:00:20.0`, async () => {
      const r = await check(`healthy-${ext}`, [{ name: 'Mic', kind: 'voice', track: 1 }, { name: 'Music', kind: 'continuous', track: 2 }]);
      assert.equal(r.state, 'verified', JSON.stringify(r.claims));
      assert.deepEqual(r.tracks.map((t) => [t.track, t.ends_at, t.silent_intervals]), [[1, '00:00:20.0', []], [2, '00:00:20.0', []]]);
    });
  }
  for (const ext of ['mp4', 'flv', 'ts']) {
    test(`F-T5-13: SIMULATED .${ext} with a dropout at the end: failed, gap 00:00:14.0 to 00:00:20.0 on track 1`, async () => {
      const r = await check(`end-${ext}`, [{ name: 'Music', kind: 'continuous', track: 1 }]);
      assert.equal(r.state, 'failed');
      assert.equal(r.claims[0].verdict, 'pass', r.claims[0].evidence);
      assert.deepEqual(r.claims.find((c) => c.claim.startsWith('Source "Music"')).gaps, [{ from: '00:00:14.0', to: '00:00:20.0', seconds: 6, why: 'silent' }]);
    });
  }

  test('F-T5-10: SIMULATED MKV whose video stops at 10 s of 20 s: the video claim warns "Video 00:00:10.0 of 00:00:20.0"', async () => {
    const r = await check('videoShortMkv', []);
    assert.equal(r.state, 'verified_with_warnings');
    const v = r.claims.find((c) => c.claim === 'The file has a video stream for the full timeline');
    assert.deepEqual([v.verdict, v.evidence, r.video_duration], ['warn', 'Video 00:00:10.0 of 00:00:20.0, from its packets: the video stream states no length.', '00:00:10.0']);
  });

  test('F-T5-14: SIMULATED 2-track file with a source whose backup is track 3: verified_with_warnings, "Backup track 3 is missing"', async () => {
    const r = await check('healthy', [{ name: 'Mic', kind: 'voice', track: 1, backup: 3 }]);
    assert.equal(r.state, 'verified_with_warnings');
    assert.match(r.claims.find((c) => c.claim.startsWith('Source "Mic"')).evidence, /^Backup track 3 is missing: the file has 2 audio tracks\. Track 1: /);
  });

  test('F-T5-19: SIMULATED 6 s gap on a voice: verified, and the source claim names the interval', async () => {
    const r = await check('shortGap', [{ name: 'Remote', kind: 'voice', track: 1 }]);
    assert.equal(r.state, 'verified');
    assert.match(r.claims.find((c) => c.claim.startsWith('Source "Remote"')).evidence, /^Track 1: peak .*, sound 14\.0 s of 20\.0 s, 1 silent interval: 00:00:08\.0 to 00:00:14\.0\. Rule: gap limit 30 s, a warning from 10 s\.$/);
    // Without expected sources, the track claim names it too.
    const t = await check('shortGap', []);
    assert.match(t.claims.find((c) => c.claim === 'Track 1 has sound').evidence, /1 silent interval: 00:00:08\.0 to 00:00:14\.0\.$/);
  });

  test('F-T5-6: SIMULATED playlist in the folder that points to a file outside: refused, ffmpeg never reads it', async () => {
    const rec = mkdtempSync(join(tmpdir(), 'obs-mcp-playlist-'));
    const list = join(rec, 'take.m3u8');
    writeFileSync(list, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:${f.healthy}\n#EXT-X-ENDLIST\n`);
    await assert.rejects(verifyFile(list, 'take.m3u8', []), { message: 'The check reads only the file types that OBS records: .mov, .mp4, .m4v, .mkv, .flv, .ts. "take.m3u8" is not one of them.' });
    // A playlist with the name of a recording is read as that type only: it fails, and nothing of the outside file shows.
    const named = join(rec, 'take.mov');
    writeFileSync(named, readFileSync(list));
    const r = await verifyFile(named, 'take.mov', []);
    assert.equal(r.state, 'failed');
    assert.equal(r.duration, undefined);
  });

  test('F-T5-2: SIMULATED healthy MKV with the afinfo fallback (macOS): not_checked, "afinfo cannot read this format", not failed', { skip: !audioTools().afinfo && 'afinfo is a macOS tool and is not on PATH here' }, async () => {
    const bin = mkdtempSync(join(tmpdir(), 'obs-mcp-afinfo-only-'));
    symlinkSync(audioTools().afinfo, join(bin, 'afinfo'));
    const r = await verifyFile(f.stereoMkv, 'stereo.mkv', [], { PATH: bin });
    assert.equal(r.state, 'not_checked');
    assert.equal(r.claims[0].verdict, 'not_checked');
    assert.match(r.claims[0].evidence, /^afinfo cannot read this format: it reads MOV and MP4, not MKV, FLV or TS\. Nothing in the file was checked\. Sound not checked: ffmpeg and ffprobe not found .*Install: brew install ffmpeg\.$/);
  });

  test('SIMULATED afinfo fallback (macOS): not_checked, tracks counted, a missing track fails', { skip: !audioTools().afinfo && 'afinfo is a macOS tool and is not on PATH here' }, async () => {
    const bin = mkdtempSync(join(tmpdir(), 'obs-mcp-afinfo-only-'));
    symlinkSync(audioTools().afinfo, join(bin, 'afinfo'));
    const env = { PATH: bin };
    const r = await verifyFile(f.healthy, 'healthy', [{ name: 'Mic', kind: 'voice', track: 1 }], env);
    assert.equal(r.state, 'not_checked');
    assert.equal(r.checked_with, 'afinfo (macOS fallback)');
    assert.match(r.claims[0].evidence, /^afinfo reads 2 audio tracks, track 1 00:00:10\.0, track 2 00:00:10\.0\. afinfo does not show a cut-short file or the video\. Sound not checked: ffmpeg and ffprobe not found/);
    const missing = await verifyFile(f.healthy, 'healthy', [{ name: 'Remote', kind: 'voice', track: 3 }], env);
    assert.equal(missing.state, 'failed');
    // F-T5-9: one track is "1 audio track", not "1 audio tracks".
    const one = await verifyFile(f.quiet, 'quiet', [{ name: 'Remote', kind: 'voice', track: 2 }], env);
    assert.equal(one.claims.find((c) => c.claim.startsWith('Source "Remote"')).evidence, 'Track 2 is missing: the file has 1 audio track.');
    // F-T5-14 and F-T5-17: a missing backup track is named.
    const backup = await verifyFile(f.healthy, 'healthy', [{ name: 'Mic', kind: 'voice', track: 1, backup: 3 }], env);
    assert.match(backup.claims.find((c) => c.claim.startsWith('Source "Mic"')).evidence, /^Track 1 is present, and backup track 3 is missing: the file has 2 audio tracks\. Sound not checked/);
  });

  test('F-T5-18: SIMULATED MOV with no audio, and a damaged MOV, with the afinfo fallback: not_checked, and the format is not blamed', { skip: !audioTools().afinfo && 'afinfo is a macOS tool and is not on PATH here' }, async () => {
    const bin = mkdtempSync(join(tmpdir(), 'obs-mcp-afinfo-only-'));
    symlinkSync(audioTools().afinfo, join(bin, 'afinfo'));
    const garbage = join(mkdtempSync(join(tmpdir(), 'obs-mcp-garbage-')), 'garbage.mov');
    writeFileSync(garbage, 'SIMULATED: not a movie');
    for (const file of [f.noAudio, garbage]) {
      const r = await verifyFile(file, 'take.mov', [], { PATH: bin });
      assert.equal(r.state, 'not_checked');
      assert.match(r.claims[0].evidence, /^afinfo cannot read audio in this file: it may hold no audio, be damaged or be cut short\. Nothing in the file was checked\./);
    }
  });
});

describe('the obs_verify_file tool, over stdio', () => {
  test('OBS closed and no OBS_MCP_RECORDING_DIR: a plain error, and nothing is checked', async () => {
    const s = await connect(testEnv(obsConfigDir(null), await closedPort()));
    const r = await s.call('obs_verify_file', { path: 'take.mov' });
    await s.close();
    assert.equal(r.isError, true);
    assert.match(r.json.problem, /^The recording folder comes from OBS, and OBS gave no answer: No answer from OBS on 127\.0\.0\.1:\d+\..* Open OBS, or set OBS_MCP_RECORDING_DIR\.$/);
  });

  test('the folder comes from OBS GetRecordDirectory; ".." and a backup on its own track are refused', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'obs-mcp-recdir-'));
    writeFileSync(join(folder, 'take.mov'), 'not media');
    const fake = await startFakeObs({ recordDirectory: folder });
    // An empty PATH: no ffmpeg, no afinfo. The tool then says what it could not check.
    const s = await connect(testEnv(obsConfigDir(null), fake.port, { PATH: mkdtempSync(join(tmpdir(), 'obs-mcp-empty-path-')) }));
    const ok = await s.call('obs_verify_file', { path: 'take.mov' });
    const out = await s.call('obs_verify_file', { path: '../take.mov' });
    const self = await s.call('obs_verify_file', { path: 'take.mov', expect: [{ name: 'Mic', kind: 'voice', track: 1, backup: 1 }] });
    await s.close();
    await fake.close();
    assert.deepEqual([ok.isError, ok.json.state, ok.json.file], [false, 'not_checked', 'take.mov']);
    assert.deepEqual(fake.log, ['GetVersion', 'GetRecordDirectory', 'GetRecordDirectory', 'GetRecordDirectory']);
    assert.equal(out.isError, true);
    assert.match(out.json.problem, /has "\.\."/);
    assert.equal(self.json.problem, 'The backup of "Mic" is its own track 1. A backup must be another track.');
  });

  test('SIMULATED healthy file through the tool, with OBS_MCP_RECORDING_DIR and OBS closed: verified', { skip: SKIP }, async () => {
    const { dir } = makeFixtures();
    const s = await connect(testEnv(obsConfigDir(null), await closedPort(), { OBS_MCP_RECORDING_DIR: dir }));
    const r = await s.call('obs_verify_file', { path: 'SIMULATED-healthy.mov', expect: [{ name: 'Mic', kind: 'voice', track: 1 }] });
    await s.close();
    assert.equal(r.json.state, 'verified', r.text);
    assert.equal(r.json.claims.find((c) => c.claim === 'Source "Mic" (voice) has sound on track 1').verdict, 'pass');
  });
});
