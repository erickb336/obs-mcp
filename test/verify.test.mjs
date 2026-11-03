// The file check. Part 1 runs everywhere: the parser on captured ffmpeg text, the rules, the path guard and the
// settings. Part 2 runs ffmpeg on SIMULATED files that test/fixtures.mjs makes; it skips, with the reason, when ffmpeg
// is not on PATH. No file here comes from OBS: the real-file test is test/real-files.test.mjs, and it is opt-in.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { audioTools } from '../dist/platform.js';
import { errorLines, judge, limitsFrom, measure, parseMetadata, parseProbe, resolveInFolder, timecode, verifyFile, visible } from '../dist/verify.js';
import { startFakeObs } from './fake-obs.mjs';
import { FFMPEG_VERSION, FORGED, makeFixtures, SKIP } from './fixtures.mjs';
import { closedPort, connect, obsConfigDir, testEnv } from './helpers.mjs';

// What the ffmpeg pass of one track writes to stdout: the ametadata prints of the check's filters, captured with
// ffmpeg 9.0.2 on SIMULATED 60 s files (cut to the lines that matter). Track 1 has sound. Track 2 goes silent at 25 s
// and stays silent to the end, so silencedetect gives no end. The text of ametadata and of these keys is the same in ffmpeg 8.
const TRACK_1 = `frame:0    pts:0       pts_time:0
lavfi.astats.1.Peak_level=-6.020600
lavfi.astats.Overall.Peak_level=-6.020600
lavfi.astats.Overall.RMS_level=-9.031275
lavfi.astats.Overall.Number_of_samples=480000.000000
frame:5    pts:2400000 pts_time:50
lavfi.astats.1.Peak_level=-6.020600
lavfi.astats.Overall.Peak_level=-6.020600
lavfi.astats.Overall.RMS_level=-9.031275
lavfi.astats.Overall.Number_of_samples=2880000.000000
`;
const TRACK_2 = `frame:2390 pts:1200040 pts_time:25.000854
lavfi.silence_start=25.000854
frame:5    pts:2400000 pts_time:50
lavfi.astats.1.Peak_level=-31.500000
lavfi.astats.Overall.Peak_level=-31.500000
lavfi.astats.Overall.RMS_level=-40.100000
lavfi.astats.Overall.Number_of_samples=2880000.000000
`;
const LOGS = [parseMetadata(TRACK_1, 1), parseMetadata(TRACK_2, 1)];

// Names with characters that a reader cannot see, each with the text that a reply must show. The tag characters spell
// an instruction ("Ignore") that a model could read but a person cannot see.
const INVISIBLE_NAMES = {
  zwj: ['emoji \u{1F468}\u200D\u{1F469}\u200D\u{1F467}.mov', 'emoji \u{1F468}\\u{200D}\u{1F469}\\u{200D}\u{1F467}.mov'],
  zwnj: ['\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.mov', '\u0645\u06CC\\u{200C}\u062E\u0648\u0627\u0647\u0645.mov'],
  softHyphen: ['soft\u00ADhyphen.mov', 'soft\\u{AD}hyphen.mov'],
  tags: ['take\u{E0049}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}.mov', 'take\\u{E0049}\\u{E0067}\\u{E006E}\\u{E006F}\\u{E0072}\\u{E0065}.mov'],
  bidi: ['take\u202Evom.mov', 'take\\u{202E}vom.mov'],
  lineSeparator: ['take\u2028more.mov', 'take\\u{2028}more.mov'],
  newLine: ['take.mov\n[Parsed_astats_0 @ 0x1] Channel: 1000000000.mov', 'take.mov\\u{A}[Parsed_astats_0 @ 0x1] Channel: 1000000000.mov'],
  literalEscape: ['lit\\u{41}.mov', 'lit\\u{5C}u{41}.mov'],
};
// Every invisible character that a reply must never hold raw. The test keeps its own copy of the rule.
const RAW_INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
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
/** A track as the ffmpeg pass gives it, for the rule tests: silent intervals as [start, end] (end null: to the end), and a peak. */
// By default the track has audio data to the end of the file: samples has no limit.
const track = (silences = [], peakDb = -20, extra = {}) => ({ silences: silences.map(([start, end]) => (end === null ? { start } : { start, end })), peakDb, samples: Infinity, ...extra });

describe('parser and rules, on captured ffmpeg text (no ffmpeg needed)', () => {
  test('parseMetadata reads level, samples and silent intervals from the stdout of a pass, and ignores any other line', () => {
    assert.deepEqual(LOGS[0], { silences: [], channelPeaksDb: [-6.0206], peakDb: -6.0206, rmsDb: -9.031275, samples: 2880000 });
    assert.deepEqual(LOGS[1], { silences: [{ start: 25.000854 }], channelPeaksDb: [-31.5], peakDb: -31.5, rmsDb: -40.1, samples: 2880000 });
    // Log lines of ffmpeg 8 and 9 are not on stdout, and they count for nothing here.
    assert.deepEqual(parseMetadata('[silencedetect @ 0x1] silence_start: 3\n[Parsed_astats_0 @ 0x2] Peak level dB: -1\n'), { silences: [] });
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

  test('a silence with no end ends where the track ends; a track that ends early leaves "no audio data"', () => {
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '20' }], format: { duration: '30' } }));
    const [m] = measure(probe, [track([[15, null]], -10, { samples: 960000 })]);
    assert.deepEqual(m.silences, [{ start: 15, end: 30, why: 'no audio data' }]);
    assert.equal(m.soundS, 15);
  });

  test('F-T5-23: a pass with no sample count is a track with no audio data, not its stated length of sound', () => {
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000' }], format: { duration: '30' } }), 'matroska');
    const [m] = measure(probe, [parseMetadata('', 1)]);
    assert.deepEqual([m.endS, m.soundS, m.silences], [0, 0, [{ start: 0, end: 30, why: 'no audio data' }]]);
  });

  test('F-T5-9: a silent track whose audio data ends 0.06 s before the file has 0 s of sound, not 0.1 s', () => {
    // The numbers of a silent track as ffprobe and ffmpeg 9 give them: 718752 samples (14.974 s) in a 15.033 s file.
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '14.974', start_time: '0' }], format: { duration: '15.033333' } }));
    const [m] = measure(probe, [track([[0, 14.974]], -Infinity, { samples: 718752 })]);
    assert.equal(m.soundS, 0);
    assert.match(judge(probe, [m], [], limits)[0].evidence, /^Silent\. Track 1: peak -inf dB, RMS unknown, sound 0\.0 s of 15\.0 s, 1 silent interval: 00:00:00\.0 to 00:00:15\.0\.$/);
  });

  test('F-T5-8: parseMetadata reads the peak of each channel apart from the overall peak', () => {
    const text = ['astats.1.Peak_level=-5.362297', 'astats.2.Peak_level=-inf', 'astats.Overall.Peak_level=-5.362297', 'astats.Overall.RMS_level=-11.2', 'astats.Overall.Number_of_samples=480000.000000'].map((l) => `lavfi.${l}`).join('\n');
    assert.deepEqual(parseMetadata(text, 2), { silences: [], channelPeaksDb: [-5.362297, -Infinity], peakDb: -5.362297, rmsDb: -11.2, samples: 480000 });
  });

  test('a backup track with sound turns a silent source into a warning that names the backup', () => {
    const probe = parseProbe(PROBE_60);
    const [own] = judge(probe, measure(probe, [track([[0, 60]], -Infinity), track()]), [{ name: 'Remote', kind: 'voice', track: 1, backup: 2 }], limits);
    assert.equal(own.verdict, 'warn');
    assert.match(own.evidence, /^Track 1 fails alone, and backup track 2 has sound there/);
    // Both silent: the backup does not save it.
    const open = track([[0, null]], -Infinity);
    assert.equal(judge(probe, measure(probe, [open, open]), [{ name: 'Remote', kind: 'voice', track: 1, backup: 2 }], limits)[0].verdict, 'fail');
  });

  test('kinds: a 3 s gap fails continuous, warns nothing for voice, and any needs only some sound', () => {
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '60' }], format: { duration: '60' } }));
    const m = measure(probe, [track([[10, 13]])]);
    const v = (kind) => judge(probe, m, [{ name: 'S', kind, track: 1 }], limits)[0].verdict;
    assert.deepEqual([v('continuous'), v('voice'), v('any')], ['fail', 'pass', 'pass']);
  });

  test('error lines: at most 5, each once, without the memory address and the full path', () => {
    const text = "[in#0/mov @ 0x1] stream 1, offset 0x18b28: partial file\n[mov @ 0x2] Could not open /rec/truncated.mov: moov atom not found\n\n[mov @ 0x2] Could not open /rec/truncated.mov: moov atom not found\n";
    assert.deepEqual(errorLines(text, '/rec/truncated.mov'), ['[in#0/mov] stream 1, offset 0x18b28: partial file', '[mov] Could not open truncated.mov: moov atom not found']);
    assert.equal(errorLines('e\n'.repeat(3) + [1, 2, 3, 4, 5, 6].join('\n')).length, 5);
  });

  test('F-T5-24, F-T5-26: visible shows each invisible character as \\u{hex}, and keeps every other character', () => {
    for (const [raw, shown] of Object.values(INVISIBLE_NAMES)) assert.equal(visible(raw), shown);
    assert.equal(visible('a\uD800b\uDFFFc'), 'a\\u{D800}b\\u{DFFF}c', 'a lone surrogate');
    assert.equal(visible('pua\uE000 unassigned\u0378 fe0f\uFE0F vs\u{E0100} nul\0 del\u007F c1\u0085 bom\uFEFF zwsp\u200B ps\u2029'), 'pua\\u{E000} unassigned\\u{378} fe0f\\u{FE0F} vs\\u{E0100} nul\\u{0} del\\u{7F} c1\\u{85} bom\\u{FEFF} zwsp\\u{200B} ps\\u{2029}');
    // A backslash that starts "\u{" in the real text is escaped too, so a literal "\u{41}" is not read as an escape.
    assert.equal(visible('lit\\u{41}.mov'), 'lit\\u{5C}u{41}.mov');
    assert.equal(visible('C:\\rec\\take.mov'), 'C:\\rec\\take.mov', 'any other backslash stays');
    assert.equal(visible('Aufnahme é 録画 \u{1F600}.mov'), 'Aufnahme é 録画 \u{1F600}.mov');
    assert.deepEqual(visible({ file: 'a\u202E', claims: [{ claim: 'Source "\u{E0049}"', n: 1, ok: true, none: null }] }), { file: 'a\\u{202E}', claims: [{ claim: 'Source "\\u{E0049}"', n: 1, ok: true, none: null }] });
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
    }), 'mpegts');
    // The pass keeps the times of the file (-copyts), so a dropout from 14 s to the end of the file starts at 15.47 s there.
    const [a, b] = measure(probe, [track([[15.467666, null]], -5, { samples: 961536 }), track([], -5, { samples: 961536 })]);
    assert.deepEqual([a.endS, a.silences], [20.021334, [{ start: 14.022333, end: 20.021334, why: 'silent' }]]);
    assert.deepEqual([b.endS, b.silences, b.expectedEndS], [20.021334, [], 19.968]);
    assert.ok(a.expectedEndS < a.endS + 1, `expected end ${a.expectedEndS}`);
    assert.deepEqual(judge(probe, [a, b], [{ name: 'Music', kind: 'continuous', track: 1 }], limits)[0].gaps, [{ from: '00:00:14.0', to: '00:00:20.0', seconds: 6, why: 'silent' }]);
  });

  test('F-T5-22: in Matroska the duration is the end time, so a file that starts at 5 s and ends at 25 s runs 20 s', () => {
    const json = JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', start_time: '5.000000' }], format: { duration: '25.021000', start_time: '5.000000' } });
    assert.deepEqual([parseProbe(json, 'matroska').durationS, parseProbe(json, 'mov').durationS], [20.021, 25.021]);
  });

  test('F-T5-11: one silent track is "The only audio track is silent"; sound on one or two tracks has the right plural', () => {
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '10' }, { codec_type: 'audio', sample_rate: '48000', duration: '10' }], format: { duration: '10' } }));
    const silent = track([[0, null]], -Infinity);
    const sound = track();
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
    // SIMULATED metadata (no media needed): every 5 s, track 1 is silent 2.5 s from 0 s, and its backup 2.5 s from 2.2 s.
    const log = (offset) => {
      const lines = [];
      for (let i = 0; i < 100000; i++) lines.push(`lavfi.silence_start=${5 * i + offset}`, `lavfi.silence_end=${5 * i + offset + 2.5}`);
      return { ...parseMetadata(lines.join('\n')), samples: 500000 * 48000 };
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

  test('F-T5-15: parseMetadata keeps at most 100,000 silent intervals of a track, and counts the rest', () => {
    const lines = [];
    for (let i = 0; i < 150000; i++) lines.push(`lavfi.silence_start=${i}`, `lavfi.silence_end=${i + 0.6}`);
    const t = parseMetadata(lines.join('\n'));
    assert.deepEqual([t.silences.length, t.dropped, t.silences.at(-1)], [100000, 50000, { start: 99999, end: 99999.6 }]);
  });

  test('F-T5-16: a channel index counts only from 1 to the channel count of the track, so a forged index does nothing', () => {
    const text = ['1.Peak_level=-5', '1000000000.Peak_level=-1', '3.Peak_level=-2', '2.Peak_level=-inf', 'Overall.Peak_level=-5'].map((l) => `lavfi.astats.${l}`).join('\n');
    const t = Date.now();
    const m = parseMetadata(text, 2);
    assert.ok(Date.now() - t < 100);
    assert.deepEqual([m.channelPeaksDb, m.peakDb], [[-5, -Infinity], -5]);
    // With 1 channel, channel 2 is ignored too.
    assert.deepEqual(parseMetadata(text, 1).channelPeaksDb, [-5]);
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
  const env = standIn(`case "$0" in *ffprobe) case "$*" in *packet*) echo 'read error' >&2; exit 1;; *) echo '${probe}';; esac;; *) printf 'ffmpeg version stand-in\\nlavfi.astats.Overall.Number_of_samples=480000\\n';; esac`);
  const r = await verifyFile(standInFile(), 'take.mkv', [], env);
  assert.deepEqual(r.claims.find((c) => c.claim === 'The file has a video stream for the full timeline'), { claim: 'The file has a video stream for the full timeline', verdict: 'not_checked', evidence: 'The video stream states no length, and reading its packets did not finish: ffprobe exit code 1: read error.' });
  assert.equal(r.state, 'not_checked');
});

test('F-T5-15: a log with more than 100,000 silent intervals on a track leaves the sound not checked, and the check ends fast', { skip: process.platform === 'win32' && 'the stand-in tools are shell scripts' }, async () => {
  // SIMULATED: the stand-in ffmpeg prints 150,000 silences (about 6 MB) on stdout for the track.
  const probe = `{"format":{"duration":"200000"},"streams":[{"codec_type":"audio","sample_rate":"48000"}]}`;
  const flood = `awk 'BEGIN{for(i=0;i<150000;i++){printf "lavfi.silence_start=%d\\nlavfi.silence_end=%d.6\\n", i, i}}'`;
  const env = standIn(`case "$0" in *ffprobe) echo '${probe}';; *) case "$*" in *-version*) echo 'ffmpeg version stand-in';; *) ${flood};; esac;; esac`);
  const t = Date.now();
  const r = await verifyFile(standInFile(), 'take.mkv', [{ name: 'Mic', kind: 'voice', track: 1, backup: 2 }], env);
  assert.ok(Date.now() - t < 10000, `the check took ${Date.now() - t} ms`);
  assert.equal(r.state, 'not_checked');
  assert.match(r.claims[0].evidence, /^ffmpeg reported more than 100000 silent intervals on track 1 \(50000 more\), more than a real track can have\. So the sound is not checked\./);
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

  test('F-T5-26: a name with an invisible character is never refused, and the real name is kept to open the file, also behind a link', { skip: process.platform === 'win32' && 'a file name with a new line is not valid on Windows' }, () => {
    const names = Object.values(INVISIBLE_NAMES).map(([raw]) => raw);
    names.forEach((name, i) => {
      writeFileSync(join(folder, name), 'x');
      assert.deepEqual(resolveInFolder(folder, name), { path: join(realpathSync(folder), name), name });
      symlinkSync(join(folder, name), join(folder, `link-${i}.mov`));
      assert.equal(resolveInFolder(folder, `link-${i}.mov`).name, name);
    });
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

  // F-T5-22 (and F-T5-13): every time of the pass is on the timeline of the file, in each container, also for a track
  // that starts later than the first stream and for a file whose streams start at 5 s.
  for (const ext of ['mov', 'mp4', 'mkv', 'flv', 'ts']) {
    test(`F-T5-22: SIMULATED .${ext}, both tracks silent at 10-13 s, track 2 starts at 3 s: a continuous source with that backup fails, gap 00:00:10.0 to 00:00:13.0`, async () => {
      const r = await check(`late2-${ext}`, [{ name: 'Mic', kind: 'continuous', track: 1, backup: 2 }]);
      assert.equal(r.state, 'failed', JSON.stringify(r.claims));
      assert.equal(r.claims[0].verdict, 'pass', r.claims[0].evidence);
      assert.deepEqual(r.claims.find((c) => c.claim.startsWith('Source "Mic"')).gaps, [{ from: '00:00:10.0', to: '00:00:13.0', seconds: 3, why: 'silent' }]);
      assert.deepEqual(r.tracks[1].silent_intervals, [{ from: '00:00:00.0', to: '00:00:03.0', seconds: 3, why: 'no audio data' }, { from: '00:00:10.0', to: '00:00:13.0', seconds: 3, why: 'silent' }]);
      assert.deepEqual(r.tracks.map((t) => [t.sound_s, t.ends_at]), [[17, '00:00:20.0'], [14, '00:00:20.0']]);
    });
    test(`F-T5-22: SIMULATED .${ext}, a track that starts at 3 s and goes silent at 15 s: failed, gaps 00:00:00.0 to 00:00:03.0 and 00:00:15.0 to 00:00:20.0, sound 12 s`, async () => {
      const r = await check(`lateEnd-${ext}`, [{ name: 'Mic', kind: 'continuous', track: 1 }]);
      assert.equal(r.state, 'failed');
      assert.equal(r.claims[0].verdict, 'pass', r.claims[0].evidence);
      assert.deepEqual(r.claims.find((c) => c.claim.startsWith('Source "Mic"')).gaps, [{ from: '00:00:00.0', to: '00:00:03.0', seconds: 3, why: 'no audio data' }, { from: '00:00:15.0', to: '00:00:20.0', seconds: 5, why: 'silent' }]);
      assert.equal(r.tracks[0].sound_s, 12);
    });
    test(`F-T5-22: SIMULATED .${ext} whose streams start at 5 s: verified, duration 00:00:20.0, no cut-short track`, async () => {
      const r = await check(`offset-${ext}`, [{ name: 'Music', kind: 'continuous', track: 1 }]);
      assert.equal(r.state, 'verified', JSON.stringify(r.claims));
      assert.deepEqual([r.duration, r.tracks[0].ends_at, r.tracks[0].silent_intervals], ['00:00:20.0', '00:00:20.0', []]);
    });
  }

  test('F-T5-20: SIMULATED MKV whose CodecID prints forged filter lines and a forged error line: the check reads none of them', async () => {
    // The forgery is live: ffmpeg, at its default log level, prints the forged lines on stderr.
    const log = spawnSync(audioTools().ffmpeg, ['-hide_banner', '-nostdin', '-i', `file:${f.forgedSilence}`, '-map', '0:a:0', '-f', 'null', '-']).stderr.toString();
    assert.ok(log.includes(`\n${FORGED.forgedSilence[0]}\n`), log);
    for (const key of ['forgedSilence', 'forgedError']) {
      const r = await check(key, [{ name: 'Mic', kind: 'voice', track: 1 }]);
      // The file has no video stream: that is the only warning.
      assert.equal(r.state, 'verified_with_warnings', JSON.stringify(r.claims));
      assert.deepEqual(r.claims.map((c) => c.verdict), ['pass', 'warn', 'pass', 'pass'], key);
      assert.equal(r.claims[0].evidence, 'Duration 00:00:20.0, 1 audio track, no video stream.');
      assert.deepEqual([r.tracks[0].sound_s, r.tracks[0].silent_intervals], [20, []]);
    }
  });

  for (const ext of ['mkv', 'flv']) {
    test(`F-T5-23: SIMULATED 30 s .${ext} whose audio track holds no audio data: failed, "no audio data", sound 0.0 s`, async () => {
      const r = await check(`empty-${ext}`, [{ name: 'Music', kind: 'continuous', track: 1 }]);
      assert.equal(r.state, 'failed', JSON.stringify(r.claims));
      assert.deepEqual([r.claims[0].verdict, r.claims[0].evidence.split('. ')[0]], ['fail', 'Track 1 has no audio data: ffmpeg decoded no sample of it']);
      const music = r.claims.find((c) => c.claim === 'Source "Music" (continuous) has sound on track 1');
      assert.equal(music.verdict, 'fail');
      assert.match(music.evidence, /^No sound: Track 1: peak unknown, RMS unknown, sound 0\.0 s of 30\.0 s, 1 silent interval: 00:00:00\.0 to 00:00:30\.0 \(no audio data\)\./);
      assert.deepEqual(music.gaps, [{ from: '00:00:00.0', to: '00:00:30.0', seconds: 30, why: 'no audio data' }]);
    });
  }

  test('F-T5-23: SIMULATED 30 s .ts whose audio track holds no audio data: not_checked, as ffprobe reads no sample rate for it', async () => {
    const r = await check('empty-ts', [{ name: 'Music', kind: 'continuous', track: 1 }]);
    assert.equal(r.state, 'not_checked', JSON.stringify(r.claims));
    assert.match(r.claims[0].evidence, /^Track 1 states no sample rate: ffprobe read no audio data of it, or does not know its format\. So the sound is not checked\./);
    assert.equal(r.claims.at(-1).evidence, 'Sound not checked: Track 1 states no sample rate: ffprobe read no audio data of it, or does not know its format.');
  });

  test('F-T5-25: SIMULATED 10 Hz track with a 40 s gap that one frame hides: not_checked, "below 8000 Hz", never verified or a wrong gap', async () => {
    const r = await check('lowRate', [{ name: 'Mic', kind: 'voice', track: 1 }]);
    assert.equal(r.state, 'not_checked', JSON.stringify(r.claims));
    assert.deepEqual([r.claims[0].verdict, r.claims[0].evidence.split('. ')[0]], ['not_checked', 'Track 1 has a sample rate of 10 Hz, below 8000 Hz: the check cannot time its silent intervals']);
    assert.deepEqual([r.claims.at(-1).verdict, r.tracks], ['not_checked', []]);
  });

  test('F-T5-20: SIMULATED MOV with damaged audio data inside: ffmpeg errors alone are a warning, not a fail', async () => {
    const r = await check('damaged', []);
    assert.equal(r.state, 'verified_with_warnings', JSON.stringify(r.claims));
    assert.equal(r.claims[0].verdict, 'warn');
    assert.match(r.claims[0].evidence, /^ffmpeg reported: .*Invalid data found when processing input.*\. Each track has audio data to its end, so the file is not cut short; the errors can be damage inside the file\. Duration 00:00:20\.0/);
  });

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

  test('F-T5-24, F-T5-26: SIMULATED real files with invisible characters in their names verify, and no reply text holds a raw invisible character', { skip: SKIP || (process.platform === 'win32' && 'a file name with a new line is not valid on Windows') }, async () => {
    const { f } = makeFixtures();
    const folder = mkdtempSync(join(tmpdir(), 'obs-mcp-names-SIMULATED-'));
    for (const [raw] of Object.values(INVISIBLE_NAMES)) copyFileSync(f.healthy, join(folder, raw));
    const s = await connect(testEnv(obsConfigDir(null), await closedPort(), { OBS_MCP_RECORDING_DIR: folder }));
    const source = 'Mic\u202E\u{E0049}\u200D';
    const got = [];
    for (const [raw] of Object.values(INVISIBLE_NAMES)) got.push(await s.call('obs_verify_file', { path: raw, expect: [{ name: source, kind: 'voice', track: 1 }] }));
    // Error texts with names from the input: a missing file, and two sources with one name.
    const missing = await s.call('obs_verify_file', { path: 'gone\u{E0041}\u2066.mov' });
    const twice = await s.call('obs_verify_file', { path: INVISIBLE_NAMES.bidi[0], expect: [{ name: source, kind: 'voice', track: 1 }, { name: source, kind: 'any', track: 2 }] });
    await s.close();
    Object.entries(INVISIBLE_NAMES).forEach(([key, [, shown]], i) => {
      const r = got[i];
      assert.deepEqual([r.isError, r.json?.state, r.json?.file], [false, 'verified', shown], `${key}: ${r.text}`);
      assert.equal(r.json.claims.find((c) => c.claim.startsWith('Source')).claim, 'Source "Mic\\u{202E}\\u{E0049}\\u{200D}" (voice) has sound on track 1');
    });
    assert.equal(missing.json.problem, 'No file "gone\\u{E0041}\\u{2066}.mov" in the recording folder.');
    assert.equal(twice.json.problem, 'Two expected sources have the name "Mic\\u{202E}\\u{E0049}\\u{200D}". Give each a different name.');
    assert.equal(s.replies.length, Object.keys(INVISIBLE_NAMES).length + 2);
    for (const text of s.replies) assert.doesNotMatch(text, RAW_INVISIBLE, text);
  });
});
