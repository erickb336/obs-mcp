// The timing loop: the added time per request of the server over loopback. Target (design R41): median under 20 ms.
// Each round sends one read twice: once through the server (MCP client, stdio, server, WebSocket) and once straight
// to OBS on the WebSocket. The added time of the round is the difference. The order flips each round, so neither
// path always runs on a warm socket. The loop sends reads only, so it changes nothing in OBS.
//
//   node scripts/timing-loop.mjs [--count 500] [--warmup 50]               against the fake OBS (SIMULATED)
//   OBS_WEBSOCKET_PASSWORD=... node scripts/timing-loop.mjs --url ws://127.0.0.1:4455   against a running OBS
//
// It prints one JSON object. It gives no detail of the machine: run it on the machine whose numbers you need.
import { parseArgs } from 'node:util';
import { OBSWebSocket } from 'obs-websocket-js/json';
import { startFakeObs } from '../test/fake-obs.mjs';
import { connect, obsConfigDir, testEnv } from '../test/helpers.mjs';

const TARGET_MS = 20;
const READS = ['GetVersion', 'GetStats', 'GetRecordStatus', 'GetSceneList', 'GetInputList'];
const fail = (message) => {
  console.error(`timing-loop: ${message}`);
  process.exit(1);
};
let values;
try {
  values = parseArgs({ options: { url: { type: 'string' }, count: { type: 'string', default: '500' }, warmup: { type: 'string', default: '50' } } }).values;
} catch {
  fail('unknown argument. Options: --url, --count, --warmup.');
}
const count = Number(values.count);
const warmup = Number(values.warmup);
if (!Number.isInteger(count) || count < 1) fail('--count must be a whole number of 1 or more.');
if (!Number.isInteger(warmup) || warmup < 0) fail('--warmup must be a whole number of 0 or more.');

let port;
let fake;
if (values.url) {
  const u = URL.canParse(values.url) ? new URL(values.url) : undefined;
  if (u?.protocol !== 'ws:' || u.hostname !== '127.0.0.1') fail('the URL must be ws://127.0.0.1:<port>: the server connects to loopback only.');
  port = Number(u.port || 4455);
} else {
  fake = await startFakeObs();
  port = fake.port;
}
const password = values.url ? process.env.OBS_WEBSOCKET_PASSWORD : undefined;
const env = testEnv(obsConfigDir(null), port, password ? { OBS_WEBSOCKET_PASSWORD: password } : {});
// The direct socket connects first, so that a closed port or a wrong password ends here with the reason.
const direct = new OBSWebSocket();
try {
  await direct.connect(`ws://127.0.0.1:${port}`, password);
} catch (e) {
  fail(`no connection to OBS on 127.0.0.1:${port}: ${e.message || `close code ${e.code}`}.`);
}
const server = await connect(env);

const time = async (fn) => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};
const viaServer = async (request) => {
  const r = await server.call('obs_read', { request });
  if (r.isError) throw new Error(`${request}: ${r.text}`);
};
const rows = [];
try {
  for (let i = 0; i < warmup + count; i++) {
    const request = READS[i % READS.length];
    const row = {};
    for (const path of i % 2 ? ['server', 'direct'] : ['direct', 'server']) {
      row[path] = await time(() => (path === 'server' ? viaServer(request) : direct.call(request)));
    }
    if (i >= warmup) rows.push(row);
  }
} catch (e) {
  await server.close();
  fail(`a timed request failed: ${e.message}`);
}
await direct.disconnect();
await server.close();
await fake?.close();

const pct = (xs, p) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(2));
};
const stats = (xs) => ({ median: pct(xs, 50), p95: pct(xs, 95) });
const added = stats(rows.map((r) => r.server - r.direct));
console.log(JSON.stringify({
  target: fake ? 'fake OBS (SIMULATED), in the same process as the timing client, on 127.0.0.1' : `OBS on 127.0.0.1:${port}`,
  requests: rows.length,
  warmup,
  // A check that each timed request reached OBS: 2 per round, plus the server's GetVersion at connect.
  ...(fake ? { requests_that_reached_the_fake: fake.log.length } : {}),
  request_types: READS,
  added_ms: added,
  through_server_ms: stats(rows.map((r) => r.server)),
  direct_ms: stats(rows.map((r) => r.direct)),
  goal: `median added under ${TARGET_MS} ms`,
  pass: added.median < TARGET_MS,
  node: process.version,
  method: 'Each round: one obs_read through the MCP SDK client over stdio to the built server, and the same request straight on a WebSocket. Added = server time minus direct time, per round. Reads only.',
}, null, 2));
