// Records obs-websocket traces for the fake OBS: each request, its reply and the events after it, through the
// trace scrub. Run it only with the owner's consent, against a disposable OBS profile and scene collection.
//
//   OBS_WEBSOCKET_PASSWORD=... node scripts/capture-traces.mjs --url ws://127.0.0.1:4455 --out trace.json [--plan plan.json] [--allow-record] [--timeout-ms 10000]
//
// The password comes from OBS_WEBSOCKET_PASSWORD or a hidden prompt, never from an argument, and it is never written.
// The script:
// - connects to a loopback address only;
// - reads GetStreamStatus and GetRecordStatus first, and stops when either output is active;
// - sends only what obs_read of the server runs, with the same guards (a list request only on a cleared row and with
//   no output active, a profile parameter only from the safe list), and a record start or stop only with --allow-record;
// - starts a take only when GetRecordStatus, read just before, says that no recording is active, and the last record
//   event (if any) is STOPPED: a take that is STARTING is not active yet;
// - stops only its own take: GetRecordStatus, read just before, says that a recording is active, and no record event
//   came after the STARTED event of its own StartRecord. A take that the user starts at any time is never its own.
//   When that is not certain, it does not stop. It never sends ToggleRecord;
// - stops when OBS closes the connection or gives no reply in --timeout-ms, and then writes the partial trace;
// - writes the trace only after the scrub.
// plan.json is a list of { requestType, requestData }. With no plan, it sends each catalogue read that needs no field.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { CATALOGUE, entry, READ_GUARDED } from '../dist/catalogue.js';
import { listGuard, SAFE_PROFILE_PARAMETERS } from '../dist/read.js';
import { scrub } from './trace-scrub.mjs';

const RECORD = ['StartRecord', 'StopRecord'];
const ALL_EVENTS = 2047;
const START_QUIET_MS = 600;

const fail = (message, code = 1) => {
  console.error(`capture-traces: ${message}`);
  process.exit(code);
};

if (process.argv.slice(2).some((a) => /^--?[\w-]*(pass|secret|token)/i.test(a))) fail('the password comes from OBS_WEBSOCKET_PASSWORD or a prompt, never from an argument.', 2);
let args;
try {
  args = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' }, plan: { type: 'string' }, 'allow-record': { type: 'boolean' }, 'settle-ms': { type: 'string', default: '300' }, 'timeout-ms': { type: 'string', default: '10000' } } }).values;
} catch {
  // The parser's message quotes the argument, and an argument can be a password typed in the wrong place.
  fail('unknown argument. Options: --url, --out, --plan, --allow-record, --settle-ms, --timeout-ms.', 2);
}
if (!args.url || !args.out) fail('give --url ws://127.0.0.1:<port> and --out <file.json>.', 2);
const url = new URL(args.url);
if (!/^wss?:$/.test(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('the URL must be ws:// on a loopback address (127.0.0.1, localhost or [::1]).', 2);
const settleMs = Number(args['settle-ms']);
const timeoutMs = Number(args['timeout-ms']);
// A wait of more than a minute after each request is a typing error, not a plan.
if (!/^\d+$/.test(args['settle-ms']) || settleMs > 60000) fail('--settle-ms must be a whole number of milliseconds from 0 to 60000.', 2);
if (!(timeoutMs > 0)) fail('--timeout-ms must be a number above 0.', 2);
const plan = args.plan
  ? JSON.parse(readFileSync(args.plan, 'utf8'))
  : CATALOGUE.filter((e) => e.class === 'read' && e.fields.every((f) => f.optional)).map((e) => ({ requestType: e.request }));

/** Reads a password from the terminal with no echo. */
function prompt() {
  return new Promise((resolve) => {
    process.stderr.write('obs-websocket password: ');
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', function onData(chunk) {
      for (const ch of String(chunk)) {
        if (ch === '\u0003') process.exit(130);
        if (ch !== '\r' && ch !== '\n') {
          value = ch === '\u007f' ? value.slice(0, -1) : value + ch;
          continue;
        }
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stderr.write('\n');
        return resolve(value);
      }
    });
  });
}

const ws = new WebSocket(url);
const pending = new Map();
const events = [];
let password = process.env.OBS_WEBSOCKET_PASSWORD;
let nextId = 0;
let closed;
const opened = new Promise((resolve, reject) => {
  ws.on('error', (e) => reject(new Error(`no connection to ${url.origin}: ${e.message}`)));
  ws.on('close', (code) => {
    closed = code;
    reject(new Error(code === 4009 ? 'OBS refused the password.' : `OBS closed the connection (${code}).`));
    // A crash of OBS closes the socket with 1006: each request in flight ends with the reason.
    for (const p of pending.values()) p.end(new Error(`OBS closed the connection (${code}) while ${p.requestType} was in flight.`));
  });
  ws.on('message', async (raw) => {
    const { op, d } = JSON.parse(String(raw));
    if (op === 0) {
      let authentication;
      if (d.authentication) {
        if (password === undefined && process.stdin.isTTY) password = await prompt();
        const sha = (s) => createHash('sha256').update(s).digest('base64');
        authentication = sha(sha((password ?? '') + d.authentication.salt) + d.authentication.challenge);
      }
      ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: ALL_EVENTS, ...(authentication ? { authentication } : {}) } }));
    } else if (op === 2) resolve();
    else if (op === 5) events.push({ at: performance.now(), eventType: d.eventType, eventData: d.eventData ?? {} });
    else if (op === 7) pending.get(d.requestId)?.end(undefined, d);
  });
});
/** Sends one request. It fails when OBS closes the connection or gives no reply in --timeout-ms. */
const send = (requestType, requestData) =>
  new Promise((resolve, reject) => {
    if (closed !== undefined) return reject(new Error(`OBS closed the connection (${closed}) before ${requestType}.`));
    const requestId = String(++nextId);
    const timer = setTimeout(() => pending.get(requestId)?.end(new Error(`OBS gave no reply to ${requestType} in ${timeoutMs} ms.`)), timeoutMs);
    const end = (error, reply) => {
      clearTimeout(timer);
      pending.delete(requestId);
      if (error) reject(error);
      else resolve(reply);
    };
    pending.set(requestId, { requestType, end });
    ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } }));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await opened;
} catch (e) {
  fail(e.message);
}
const state = { recording: false, streaming: false };
const entries = [];
/** Sends one request and keeps it with the events that came before the next request. */
async function record(requestType, requestData) {
  const when = { ...state };
  const from = events.length;
  const t = performance.now();
  const reply = await send(requestType, requestData);
  // A record start or stop ends with STARTED or STOPPED, about 1 s later for a stop (T4): wait for it, up to 5 s.
  const final = (ev) => ev.eventType === 'RecordStateChanged' && /_(STARTED|STOPPED)$/.test(ev.eventData.outputState);
  const deadline = performance.now() + (RECORD.includes(requestType) ? 5000 : settleMs);
  while (performance.now() < deadline && !(RECORD.includes(requestType) && events.slice(from).some(final))) await wait(20);
  const after = events.slice(from).map((ev) => ({ delayMs: Math.round(ev.at - t), eventType: ev.eventType, eventData: ev.eventData }));
  for (const ev of after) {
    if (ev.eventType === 'RecordStateChanged' && /_(STARTED|STOPPED)$/.test(ev.eventData.outputState)) state.recording = ev.eventData.outputActive;
    if (ev.eventType === 'StreamStateChanged' && /_(STARTED|STOPPED)$/.test(ev.eventData.outputState)) state.streaming = ev.eventData.outputActive;
  }
  const effect = Object.fromEntries(Object.entries(state).filter(([k, v]) => when[k] !== v));
  entries.push({
    requestType,
    ...(requestData ? { requestData } : {}),
    when,
    status: reply.requestStatus,
    ...(reply.responseData ? { responseData: reply.responseData } : {}),
    ...(after.length ? { events: after } : {}),
    ...(Object.keys(effect).length ? { effect } : {}),
  });
  return reply;
}

let version = {};
/** The server's guards call OBS through this: a failed request throws, as in the server. */
const guardObs = {
  get version() {
    return version;
  },
  async call(requestType, requestData) {
    const reply = await send(requestType, requestData);
    if (!reply.requestStatus.result) throw new Error(`${requestType} failed with code ${reply.requestStatus.code}.`);
    return reply.responseData ?? {};
  },
};
/** Why the capture does not send a request, or { data } to send. The rules are those of obs_read in the server. */
async function check({ requestType, requestData }) {
  if (RECORD.includes(requestType)) {
    if (!args['allow-record']) return { why: 'it starts or stops a recording; give --allow-record to send it.' };
    const active = async () => (await guardObs.call('GetRecordStatus')).outputActive;
    if (requestType === 'StartRecord') {
      // A take that the user starts reads as not active while it is STARTING, and its first event comes about 50 ms after
      // its request (real-record.json). So the capture reads the state twice, START_QUIET_MS apart, with no record event between.
      const from = events.length;
      const quiet = (await active()) === false && idle() && (await wait(START_QUIET_MS), (await active()) === false) && !events.slice(from).some(isRecordEvent);
      return quiet ? { data: requestData } : { why: 'a recording is active, or its state is not known: the capture starts a take only when no recording is active.' };
    }
    return (await active()) === true && ownTake() ? { data: requestData } : { why: 'the active recording is not a take that the capture started, or that is not certain: the capture stops only its own take.' };
  }
  const e = entry(requestType);
  if (!e) return { why: 'it is not in the catalogue of documented requests.' };
  if (e.class !== 'read' && !READ_GUARDED.has(requestType)) return { why: `it is in the class ${e.class}. The capture sends what obs_read runs, and a record start or stop with --allow-record.` };
  if (requestType === 'GetProfileParameter' && !SAFE_PROFILE_PARAMETERS.get(requestData?.parameterCategory)?.includes(requestData?.parameterName)) {
    return { why: 'it is not on the list of safe profile parameters, because a profile can hold tokens and stream keys.' };
  }
  if (requestType === 'GetInputPropertiesListPropertyItems') {
    const guard = await listGuard(guardObs, requestData ?? {});
    return typeof guard === 'string' ? { why: guard } : { data: guard };
  }
  return { data: requestData };
}

// The index in events of the STARTED event of the capture's own take. OBS has one record output, so after a StartRecord
// that succeeded, the next STARTED event is that take. Any later record event (a stop, or another take) ends the claim.
let take;
const isRecordEvent = (ev) => ev.eventType === 'RecordStateChanged';
const ownTake = () => take !== undefined && events.slice(take + 1).every((ev) => !isRecordEvent(ev) || /_(PAUSED|RESUMED)$/.test(ev.eventData.outputState));
const idle = () => [undefined, 'OBS_WEBSOCKET_OUTPUT_STOPPED'].includes(events.findLast(isRecordEvent)?.eventData.outputState);
const refused = [];
let stopped;
try {
  version = (await record('GetVersion')).responseData ?? {};
  const stream = (await record('GetStreamStatus')).responseData;
  const rec = (await record('GetRecordStatus')).responseData;
  if (stream?.outputActive !== false || rec?.outputActive !== false) {
    ws.close();
    fail('a stream or a recording is active, or its state is not known. The capture sends nothing during an output, and wrote no file.', 3);
  }
  for (const r of plan) {
    const { why, data } = await check(r);
    if (why) refused.push({ requestType: r.requestType, ...(r.requestData ? { requestData: r.requestData } : {}), refused: why });
    else {
      const from = events.length;
      const reply = await record(r.requestType, data);
      if (r.requestType === 'StartRecord') {
        const i = events.findIndex((ev, k) => k >= from && isRecordEvent(ev) && ev.eventData.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED');
        take = reply.requestStatus.result && i >= 0 ? i : undefined;
      }
    }
  }
} catch (e) {
  stopped = e.message;
}
ws.close();

const trace = scrub(
  {
    format: 'obs-mcp-trace/1',
    source: 'captured',
    basis: `Captured with the trace capture script from OBS ${version.obsVersion}, obs-websocket ${version.obsWebSocketVersion}, then scrubbed.`,
    ...(stopped ? { incomplete: `The capture stopped: ${stopped}` } : {}),
    obs: { obsVersion: version.obsVersion, obsWebSocketVersion: version.obsWebSocketVersion, rpcVersion: version.rpcVersion, platform: version.platform },
    entries,
    refused,
  },
  { secrets: [password] },
);
writeFileSync(args.out, `${JSON.stringify(trace, null, 2)}\n`);
for (const r of refused) console.error(`  refused ${r.requestType}: ${r.refused}`);
if (stopped) fail(`stopped: ${stopped} The partial trace (${entries.length} requests) is written to ${args.out} after the scrub.`, 5);
console.error(`capture-traces: ${entries.length} requests recorded, ${refused.length} refused, written to ${args.out} after the scrub.`);
