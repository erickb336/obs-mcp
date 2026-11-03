// Opt-in: the file check on real OBS recordings in a folder of your own. It skips unless OBS_MCP_REAL_DIR names that
// folder. Nothing here holds a real file or a path: they come only from the settings below.
//
//   OBS_MCP_REAL_DIR      folder of real recordings (each .mov, .mp4 and .mkv of 1 GB or less is checked, through obs_verify_file)
//   OBS_MCP_REAL_EXPECT   optional JSON file: [{ "file": name, "expect": [expected sources], "sound": { "<track>": true|false } }]
//                         measured another way; each source must then pass or warn when its track has sound, and fail when not
//   OBS_MCP_REAL_SCRATCH  folder for a cut copy of the first file (default: the system temporary folder); the copy is deleted
//   OBS_MCP_REAL_SOAK     optional name of one long file in the folder, checked once to time the check; it is skipped otherwise
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { closedPort, connect, obsConfigDir, testEnv } from './helpers.mjs';

const dir = process.env.OBS_MCP_REAL_DIR;
const soak = process.env.OBS_MCP_REAL_SOAK;
const manifest = process.env.OBS_MCP_REAL_EXPECT ? JSON.parse(readFileSync(process.env.OBS_MCP_REAL_EXPECT, 'utf8')) : [];
// A file over 1 GB is checked only when OBS_MCP_REAL_SOAK names it, so that one run reads it at most once.
const files = dir ? readdirSync(dir).filter((f) => /\.(mov|mp4|mkv)$/i.test(f) && f !== soak && statSync(join(dir, f)).size <= 1e9).sort() : [];
const line = (f, r) => `${f} | ${r.state} | ${r.checked_with} | ${r.claims.map((c) => `${c.verdict}: ${c.claim}`).join('; ')} | ${(r.tracks ?? []).map((t) => `T${t.track} peak ${t.peak_db} sound ${t.sound_s}s`).join(', ')}`;

describe('REAL OBS recordings (opt-in)', { skip: !dir && 'set OBS_MCP_REAL_DIR to a folder of real OBS recordings to run these tests' }, () => {
  let s;
  const env = async (folder) => testEnv(obsConfigDir(null), await closedPort(), { OBS_MCP_RECORDING_DIR: folder });
  before(async () => (s = await connect(await env(dir))));
  after(() => s?.close());

  test(`REAL: each of the ${files.length} files gives a result, with a readable verdict per claim`, async () => {
    for (const f of files) {
      const entry = manifest.find((m) => m.file === f);
      const r = (await s.call('obs_verify_file', { path: f, ...(entry ? { expect: entry.expect } : {}) })).json;
      console.log(`REAL ${line(f, r)}`);
      assert.ok(['verified', 'verified_with_warnings', 'failed', 'not_checked'].includes(r.state), f);
      assert.equal(r.claims[0].claim, 'The file is readable and complete');
      if (!entry) continue;
      for (const e of entry.expect) {
        const c = r.claims.find((x) => x.claim.startsWith(`Source ${JSON.stringify(e.name)}`));
        const want = entry.sound[e.track] ? ['pass', 'warn'] : ['fail'];
        assert.ok(want.includes(c.verdict), `${f}: ${c.claim} is ${c.verdict}, want ${want.join(' or ')}. ${c.evidence}`);
      }
      for (const [track, sound] of Object.entries(entry.sound)) assert.equal(r.tracks[track - 1].sound_s >= 0.5, sound, `${f}: track ${track}`);
    }
  });

  test('REAL: a cut copy of a real file is failed, and the copy is deleted after', { skip: !files.length && 'no file' }, async () => {
    const scratch = mkdtempSync(join(process.env.OBS_MCP_REAL_SCRATCH ?? tmpdir(), 'cut-'));
    const copy = join(scratch, `cut-${files[0]}`);
    try {
      copyFileSync(join(dir, files[0]), copy);
      truncateSync(copy, Math.floor(statSync(copy).size / 2));
      const c = await connect(await env(scratch));
      const r = (await c.call('obs_verify_file', { path: `cut-${files[0]}` })).json;
      await c.close();
      console.log(`REAL cut copy (50% of ${files[0]}) ${line(`cut-${files[0]}`, r)}`);
      assert.equal(r.state, 'failed');
      assert.equal(r.claims[0].verdict, 'fail');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('REAL: one timed check of a long file', { skip: !soak && 'set OBS_MCP_REAL_SOAK to time one long file' }, async () => {
    const t = Date.now();
    // The SDK client waits 60 s for a reply by default; a long file can take longer.
    const reply = await s.client.callTool({ name: 'obs_verify_file', arguments: { path: soak } }, { timeout: 900000 });
    const r = JSON.parse(reply.content[0].text);
    console.log(`REAL soak ${soak} (${(statSync(join(dir, soak)).size / 1e9).toFixed(2)} GB) checked in ${((Date.now() - t) / 1000).toFixed(1)} s: ${line(soak, r)}`);
    assert.notEqual(r.state, 'not_checked');
  });
});
