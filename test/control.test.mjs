// G32: exactly one obs-mcp process for each OBS endpoint controls recording. These tests run real server processes
// (dist/cli.js over stdio) on one fake OBS and one journal folder. SIMULATED: no real OBS.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { Journal } from '../dist/journal.js';
import { controlLock } from '../dist/platform.js';
import { TEXT } from '../dist/take.js';
import { connect, obsConfigDir, testEnv } from './helpers.mjs';
import { recordRequests, until, world } from './take-app.mjs';

const accept = async () => ({ action: 'accept', content: {} });
const last = (text) => text.split('\n').at(-1);
const rows = (w) => {
  const j = new Journal(w.dir);
  return j.openTakes().flatMap((id) => j.read(id).filter((r) => r.t === 'state').map((r) => r.row));
};
/** Ends a server process as a crash does: no end of input, no clean exit. On Unix the socket file stays behind. */
const crash = async (s) => {
  const pid = s.pid();
  process.kill(pid, 'SIGKILL');
  assert.ok(await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000), 'the process is gone');
};

test('F-T7-63, G32: two real processes on one OBS: one controller; the reader refuses start and stop; after the controller crashes, the reader controls and runs the restart rows', async () => {
  for (let round = 1; round <= 3; round++) {
    const w = await world();
    const env = testEnv(obsConfigDir(null), w.fake.port, { OBS_MCP_STATE_DIR: w.dir, OBS_MCP_RECORDING_DIR: w.rec });
    const [a, b] = await Promise.all([connect(env, { elicit: accept }), connect(env, { era: 'modern', elicit: accept })]);
    try {
      // Both accept a start at the same moment: one StartRecord, and the other copy says why it sent nothing.
      const replies = await Promise.all([a.call('obs_record_start', { token: `two-token-a-${round}` }), b.call('obs_record_start', { token: `two-token-b-${round}` })]);
      assert.deepEqual(recordRequests(w.fake), ['StartRecord'], `round ${round}: ${replies.map((r) => r.text).join(' | ')}`);
      const texts = replies.map((r) => last(r.text));
      assert.deepEqual(texts.map((t) => (t === TEXT.X16 ? 'X16' : /^Recording for /.test(t) ? 'recording' : t)).sort(), ['X16', 'recording'], texts.join('\n'));
      const [ctl, reader] = texts[0] === TEXT.X16 ? [b, a] : [a, b];
      // The reader reads OBS and the take, and refuses every recording request with one text, before any prompt.
      assert.equal((await reader.call('obs_record_stop')).text, TEXT.X16);
      assert.equal((await reader.call('obs_record_start', { token: `again-token-${round}` })).text, TEXT.X16);
      assert.match(last((await reader.call('obs_take_status')).text), /^Recording for /);
      assert.equal((await reader.call('obs_status')).json?.recording.active, true);
      assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
      if (round < 3) continue;
      // The controller crashes. On Unix its socket file stays; the reader's next tool call finds it dead and takes over.
      await crash(ctl);
      if (process.platform !== 'win32') assert.equal(existsSync(controlLock(`ws://127.0.0.1:${w.fake.port}`, env)), true, 'a stale socket file');
      const after = (await reader.call('obs_take_status')).text;
      assert.match(after, /^OBS still records the take that I started \(00:00:0\d, file `[^`]+`\)\. I watch it again from \d\d:\d\d:\d\d\./, after);
      assert.match(last(after), /^Recording for /);
      assert.ok(rows(w).includes('R3'), 'the restart row is in the journal');
      // Now it controls: a stop with consent sends StopRecord once.
      assert.match(last((await reader.call('obs_record_stop')).text), /^The recording stopped at \d\d:\d\d:\d\d \(OBS confirmed it\)\./);
      assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
      await w.fake.close();
    }
  }
});

test('F-T7-58, D4: a 2026-era client sends no initialized notice; the new process still runs the restart rows at its start, and obs_status gives the notice', async () => {
  const w = await world();
  const env = testEnv(obsConfigDir(null), w.fake.port, { OBS_MCP_STATE_DIR: w.dir, OBS_MCP_RECORDING_DIR: w.rec });
  const a = await connect(env, { elicit: accept });
  let b;
  try {
    assert.match((await a.call('obs_record_start', { token: 'modern-restart-1' })).text, /^Recording for /);
    await crash(a);
    b = await connect(env, { era: 'modern', elicit: accept });
    assert.ok(await until(() => rows(w).includes('R3'), 5000), 'R3 ran before any tool call');
    const r = await b.client.callTool({ name: 'obs_status', arguments: {} });
    assert.match(r.content[0].text, /^OBS still records the take that I started/, 'the notice comes first, before the status JSON');
    assert.equal(JSON.parse(r.content[1].text).recording.active, true);
    assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  } finally {
    await a.close().catch(() => {});
    await b?.close().catch(() => {});
    await w.fake.close();
  }
});
