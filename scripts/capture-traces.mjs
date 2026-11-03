// Records obs-websocket traces for the fake OBS: each request, its reply and the events after it, through the
// trace scrub. Run it only with the owner's consent, against a disposable OBS profile and scene collection.
//
//   OBS_WEBSOCKET_PASSWORD=... node scripts/capture-traces.mjs --url ws://127.0.0.1:4455 --out trace.json [--plan plan.json] [--allow-record]
//
// The password comes from OBS_WEBSOCKET_PASSWORD or a hidden prompt, never from an argument, and it is never written.
// The script:
// - connects to a loopback address only;
// - reads GetStreamStatus and GetRecordStatus first, and stops when either output is active;
// - never sends a list request on "application" or "display_uuid" (each crashed OBS 33.0.1 in T4);
// - never starts a stream or sends a raw output or hotkey request (each can start a stream or stop a recording);
// - sends a record start or stop only with --allow-record;
// - writes the trace only after the scrub, and only when the leak scan of the scrubbed trace is empty.
// plan.json is a list of { requestType, requestData }. With no plan, it sends each catalogue read that needs no field.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { findLeaks, scrub } from './trace-scrub.mjs';

const CRASH_ROWS = ['application', 'display_uuid'];
const NEVER = ['StartStream', 'ToggleStream', 'StartOutput', 'StopOutput', 'ToggleOutput', 'TriggerHotkeyByName', 'TriggerHotkeyByKeySequence'];
const RECORD = ['StartRecord', 'StopRecord', 'ToggleRecord'];
const ALL_EVENTS = 2047;

/** Why the script does not send a request, or undefined when it may send it. */
function refusal({ requestType, requestData }, allowRecord) {
  if (requestType === 'GetInputPropertiesListPropertyItems' && CRASH_ROWS.includes(requestData?.propertyName)) return `a list request on "${requestData.propertyName}" crashed OBS 33.0.1 (T4).`;
  if (NEVER.includes(requestType)) return 'it can start a stream or stop a recording, so the capture never sends it.';
  if (RECORD.includes(requestType) && !allowRecord) return 'it starts or stops a recording; give --allow-record to send it.';
  return undefined;
}

const fail = (message, code = 1) => {
  console.error(`capture-traces: ${message}`);
  process.exit(code);
};

if (process.argv.slice(2).some((a) => /^--?[\w-]*(pass|secret|token)/i.test(a))) fail('the password comes from OBS_WEBSOCKET_PASSWORD or a prompt, never from an argument.', 2);
let args;
try {
  args = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' }, plan: { type: 'string' }, 'allow-record': { type: 'boolean' }, 'settle-ms': { type: 'string', default: '300' } } }).values;
} catch {
  // The parser's message quotes the argument, and an argument can be a password typed in the wrong place.
  fail('unknown argument. Options: --url, --out, --plan, --allow-record, --settle-ms.', 2);
}
if (!args.url || !args.out) fail('give --url ws://127.0.0.1:<port> and --out <file.json>.', 2);
const url = new URL(args.url);
if (!/^wss?:$/.test(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('the URL must be ws:// on a loopback address (127.0.0.1, localhost or [::1]).', 2);
const settleMs = Number(args['settle-ms']);
const plan = args.plan
  ? JSON.parse(readFileSync(args.plan, 'utf8'))
  : JSON.parse(readFileSync(new URL('../dist/catalogue.json', import.meta.url), 'utf8'))
      .filter((e) => e.class === 'read' && e.fields.every((f) => f.optional))
      .map((e) => ({ requestType: e.request }));

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
const opened = new Promise((resolve, reject) => {
  ws.once('error', (e) => reject(new Error(`no connection to ${url.origin}: ${e.message}`)));
  ws.once('close', (code) => reject(new Error(code === 4009 ? 'OBS refused the password.' : `OBS closed the connection (${code}).`)));
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
    else if (op === 7) pending.get(d.requestId)?.(d);
  });
});
const send = (requestType, requestData) =>
  new Promise((resolve) => {
    const requestId = String(++nextId);
    pending.set(requestId, resolve);
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

const version = (await record('GetVersion')).responseData ?? {};
const stream = (await record('GetStreamStatus')).responseData;
const rec = (await record('GetRecordStatus')).responseData;
if (stream?.outputActive !== false || rec?.outputActive !== false) {
  ws.close();
  fail('a stream or a recording is active, or its state is not known. The capture sends nothing during an output, and wrote no file.', 3);
}
const refused = [];
for (const r of plan) {
  const why = refusal(r, args['allow-record']);
  if (why) refused.push({ requestType: r.requestType, ...(r.requestData ? { requestData: r.requestData } : {}), refused: why });
  else await record(r.requestType, r.requestData);
}
ws.close();

const trace = scrub(
  {
    format: 'obs-mcp-trace/1',
    source: 'captured',
    basis: `Captured with scripts/capture-traces.mjs from OBS ${version.obsVersion}, obs-websocket ${version.obsWebSocketVersion}, then scrubbed.`,
    obs: { obsVersion: version.obsVersion, obsWebSocketVersion: version.obsWebSocketVersion, rpcVersion: version.rpcVersion, platform: version.platform },
    entries,
    refused,
  },
  { secrets: [password] },
);
const leaks = findLeaks(trace, { secrets: [password] });
if (leaks.length) fail(`the scrubbed trace still holds ${leaks.length} value(s) to scrub, so no file was written.`, 4);
writeFileSync(args.out, `${JSON.stringify(trace, null, 2)}\n`);
console.error(`capture-traces: ${entries.length} requests recorded, ${refused.length} refused, written to ${args.out} after the scrub.`);
for (const r of refused) console.error(`  refused ${r.requestType}: ${r.refused}`);
