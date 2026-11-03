// The file check. Part 1 runs everywhere: the parser on captured ffmpeg text, the rules, the path guard and the
// settings. Part 2 runs ffmpeg on SIMULATED files that test/fixtures.mjs makes; it skips, with the reason, when ffmpeg
// is not on PATH. No file here comes from OBS: the real-file test is test/real-files.test.mjs, and it is opt-in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { audioTools } from '../dist/platform.js';
import { judge, limitsFrom, measure, parseLog, parseProbe, resolveInFolder, timecode, verifyFile } from '../dist/verify.js';
import { startFakeObs } from './fake-obs.mjs';
import { FFMPEG_VERSION, makeFixtures, SKIP } from './fixtures.mjs';
import { closedPort, connect, obsConfigDir, testEnv } from './helpers.mjs';

// Captured from ffmpeg 9.0.2 on a SIMULATED 60 s file: track 1 has sound, track 2 goes silent at 25 s and stays
// silent to the end, so silencedetect gives the end at the end of the file. Addresses are as ffmpeg prints them.
const LOG_9 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'file:/rec/take.mov':
  Metadata:
    title           : an error in the title is not an error line
Stream mapping:
[silencedetect@t2 @ 0x76630212c0] silence_start: 25.0
[astats@t1 @ 0x7663021200] Peak level dB: -6.020600
[astats@t1 @ 0x7663021200] RMS level dB: -9.031275
[astats@t1 @ 0x7663021200] Number of samples: 2880000
[silencedetect@t2 @ 0x7663021440] silence_end: 60 | silence_duration: 35
[astats@t2 @ 0x7663021380] Peak level dB: -31.500000
[astats@t2 @ 0x7663021380] RMS level dB: -40.100000
[astats@t2 @ 0x7663021380] Number of samples: 2880000
[out#0/null @ 0x78b1048600] video:0KiB audio:2816KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
`;
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
  test('parseLog reads level, samples and silent intervals per track, and ignores a metadata line that says "error"', () => {
    const log = parseLog(LOG_9, '/rec/take.mov');
    assert.deepEqual(log.tracks.get(1), { silences: [], peakDb: -6.0206, rmsDb: -9.031275, samples: 2880000 });
    assert.deepEqual(log.tracks.get(2), { silences: [{ start: 25, end: 60 }], peakDb: -31.5, rmsDb: -40.1, samples: 2880000 });
    assert.deepEqual(log.errors, []);
  });

  test('a dropout that the overall peak does not show fails a voice, with the timecode of the gap', () => {
    // This is the case in the design: track 2 peak -31.5 dB looks fine, and the track is silent from 25 s to 60 s.
    const probe = parseProbe(PROBE_60);
    const claims = judge(probe, measure(probe, parseLog(LOG_9)), [{ name: 'Remote', kind: 'voice', track: 2 }], limits);
    const remote = claims.find((c) => c.claim === 'Source "Remote" (voice) has sound on track 2');
    assert.equal(remote.verdict, 'fail');
    assert.deepEqual(remote.gaps, [{ from: '00:00:25.0', to: '00:01:00.0', seconds: 35, why: 'silent' }]);
    assert.match(remote.evidence, /^A gap of 30 s or more: Track 2: peak -31\.5 dB/);
  });

  test('a silence with no end in the log ends where the track ends; a track that ends early leaves "no audio data"', () => {
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '20' }], format: { duration: '30' } }));
    const log = parseLog('[silencedetect@t1 @ 0x1] silence_start: 15\n[astats@t1 @ 0x2] Number of samples: 960000\n[astats@t1 @ 0x2] Peak level dB: -10\n');
    const [m] = measure(probe, log);
    assert.deepEqual(m.silences, [{ start: 15, end: 30, why: 'no audio data' }]);
    assert.equal(m.soundS, 15);
  });

  test('a backup track with sound turns a silent source into a warning that names the backup', () => {
    const probe = parseProbe(PROBE_60);
    const log = parseLog('[silencedetect@t1 @ 0x1] silence_start: 0\n[silencedetect@t1 @ 0x1] silence_end: 60 | silence_duration: 60\n[astats@t2 @ 0x2] Peak level dB: -20\n');
    const [own] = judge(probe, measure(probe, log), [{ name: 'Remote', kind: 'voice', track: 1, backup: 2 }], limits);
    assert.equal(own.verdict, 'warn');
    assert.match(own.evidence, /^Track 1 fails alone, and backup track 2 has sound there/);
    // Both silent: the backup does not save it.
    const both = parseLog('[silencedetect@t1 @ 0x1] silence_start: 0\n[silencedetect@t2 @ 0x1] silence_start: 0\n');
    assert.equal(judge(probe, measure(probe, both), [{ name: 'Remote', kind: 'voice', track: 1, backup: 2 }], limits)[0].verdict, 'fail');
  });

  test('kinds: a 3 s gap fails continuous, warns nothing for voice, and any needs only some sound', () => {
    const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '48000', duration: '60' }], format: { duration: '60' } }));
    const log = parseLog('[silencedetect@t1 @ 0x1] silence_start: 10\n[silencedetect@t1 @ 0x1] silence_end: 13 | silence_duration: 3\n[astats@t1 @ 0x2] Peak level dB: -20\n');
    const m = measure(probe, log);
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
  assert.deepEqual([hang.state, hang.claims[0].evidence], ['not_checked', 'ffprobe stopped: it ran longer than 1 s (OBS_MCP_VERIFY_TIMEOUT_S). Nothing in the file was checked.']);
  const flood = await verifyFile(file, 'take.mov', [], { OBS_MCP_FFMPEG: tool('yes | head -c 40000000') });
  assert.deepEqual([flood.state, flood.claims[0].evidence], ['not_checked', 'ffprobe stopped: its output passed 33554432 bytes. Nothing in the file was checked.']);
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
