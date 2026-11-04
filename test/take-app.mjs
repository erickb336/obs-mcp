// A take server in this process, against the fake OBS, with short limits, a temporary journal folder and recording
// folder. SIMULATED: no real OBS. The limits are scaled down from section 4 so that a test of a 15 s or 120 s limit
// runs in about a second; the ratios between them stay.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionTarget } from '../dist/obs.js';
import { createApp, createServer } from '../dist/server.js';
import { LIMITS } from '../dist/take.js';
import { startFakeObs } from './fake-obs.mjs';
import { obsConfigDir, testEnv } from './helpers.mjs';
import { pair } from './mcp-pair.mjs';
import { tracked } from './cleanup.mjs';

export const FAST = {
  ...LIMITS,
  connectMs: 500,
  callMs: 1000,
  startMs: 1000,
  holdMs: 1500,
  holdReadMs: 100,
  stopMs: 1500,
  stopReadMs: 100,
  goneMs: 1000,
  consentMs: 2000,
  reminderFirstMs: 300,
  reminderMs: 500,
  beatMs: 150,
  reconnectMs: [50, 100, 200],
};

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const tmp = (name) => mkdtempSync(join(tmpdir(), `obs-mcp-${name}-`));

/** A fake OBS, and a folder for the journal and one for recordings. */
export async function world(fakeOptions = {}) {
  const rec = tmp('rec');
  const fake = await startFakeObs({ recordDirectory: rec, ...fakeOptions });
  return { fake, rec, dir: join(tmp('state'), 'takes') };
}

/** One server process of a client, joined to an SDK client in this process. */
export async function server(w, { era = 'legacy', elicit = null, client = 'Claude Code', limits = FAST, manual = false } = {}) {
  const env = { ...process.env, OBS_MCP_RECORDING_DIR: w.rec };
  const app = createApp({ target: () => connectionTarget(obsConfigDir(null), testEnv('', w.fake.port)), limits, dir: w.dir, env });
  await app.control(); // as at a server start: the first copy on this fake OBS controls, a later one reads (G32)
  const p = await pair(() => createServer(app), { era, elicit, name: client, manual });
  return {
    app,
    ...p,
    /** Ends the process as a crash would: no notice, no journal line, timers stopped, and the controller lock goes. */
    kill: tracked(async () => {
      await app.close();
      await p.close().catch(() => {});
    }),
  };
}

/** The recording requests that reached the fake OBS. */
export const recordRequests = (fake) => fake.log.filter((r) => /^(Start|Stop|Toggle|Pause|Resume)Record$/.test(r));

/** Waits until test() holds, up to ms. */
export async function until(test, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await wait(25);
  }
  return false;
}
