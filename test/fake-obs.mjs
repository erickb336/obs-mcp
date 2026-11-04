// An in-memory fake of OBS with obs-websocket 5 (JSON). SIMULATED: it is not real OBS.
// It replays the stored traces in test/traces: a request type and request data, in an output state, give the
// response status, code, data and events of the trace, and its effect on the output state. A request with no trace
// gets sample values in the shape of protocol.json. It logs each request it gets, alone or in a RequestBatch (op 8),
// counts each recording stop, and
// closes the socket with no close frame (the client sees 1006) on a list request that real OBS can crash on.
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

const protocol = JSON.parse(readFileSync(new URL('../protocol/protocol.json', import.meta.url), 'utf8'));
const DOCUMENTED = new Map(protocol.requests.map((r) => [r.requestType, r]));
// The subscription bit of each event ("(1 << 6)" in protocol.json): a client gets an event only when it subscribed to its category.
const BITS = new Map(protocol.enums.find((e) => e.enumType === 'EventSubscription').enumIdentifiers.map((i) => [i.enumIdentifier, /^\(1 << (\d+)\)$/.exec(i.enumValue)?.[1]]));
const EVENT_BIT = new Map(protocol.events.map((e) => [e.eventType, 2 ** Number(BITS.get(e.eventSubscription))]));
const ALL_EVENTS = 2047; // obs-websocket's default: every category that is not high-volume

export const TRACE_DIR = new URL('./traces/', import.meta.url);
/** The stored traces, each with its file name. */
export const loadTraces = (dir = TRACE_DIR) =>
  readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((file) => ({ file, ...JSON.parse(readFileSync(new URL(file, dir), 'utf8')) }));
const STORED = loadTraces();
// A trace value matches when each of its fields matches; a field that the trace leaves out matches anything.
const matches = (want, got) =>
  want === undefined || (want && typeof want === 'object' ? !!got && typeof got === 'object' && Object.entries(want).every(([k, v]) => matches(v, got[k])) : Object.is(want, got));
export const PRIVATE_REQUESTS = ['GetSourcePrivateSettings', 'SetSourcePrivateSettings', 'GetSceneItemPrivateSettings', 'SetSceneItemPrivateSettings'];
const sha = (s) => createHash('sha256').update(s).digest('base64');
const SAMPLE = { String: 'sample', Number: 1, Boolean: false, Object: {}, Any: null };
const sample = (type) => (type.startsWith('Array') ? [] : SAMPLE[type]);

/**
 * options: password, recording, streaming, replayBuffer, virtualCam (bool: the output state at start), traces (default: the stored traces),
 * port (default: any free port), platform, obsVersion, inputs ({name: kind}), streamKey, token, crashOn (request name),
 * outputs (the GetOutputList items; by default four outputs, each active when its output state is on),
 * silentOn (request names that never get an answer), failOn (request names that get a failed status),
 * recordDirectory (the GetRecordDirectory folder), plant (bool: see plantReply below; each planted secret is listed in `planted` as { secret, field }).
 * Each input has the UUID "uuid-<name>". Like OBS, the fake resolves inputName first and inputUuid only when no name is given.
 * Returns { port, log, sent, planted, state, stops, crashes, connections, close() }. log holds every request type that reached the fake, in order;
 * sent holds { requestType, requestData } for each; connections() is the count of WebSocket connections that the fake accepted.
 * state is the output state now. stops holds { requestType, cause } for each recording that a request or a crash stopped;
 * crashes() is the count of simulated crashes (each closes the socket with 1006 and ends every output, as a real crash does).
 */
export const DISPLAY_UUID = '5d1f3c2a-8b4e-4f6a-9c7d-0e1f2a3b4c5d';
export async function startFakeObs(options = {}) {
  const o = { platform: 'macos', obsVersion: '33.0.1', inputs: { Display: 'screen_capture', 'App audio': 'sck_audio_capture' }, ...options };
  const log = [];
  const sent = [];
  const planted = [];
  const state = { recording: !!o.recording, streaming: !!o.streaming, replayBuffer: !!o.replayBuffer, virtualCam: !!o.virtualCam };
  const stops = [];
  let crashes = 0;
  const timers = new Set();
  const entries = (o.traces ?? STORED).flatMap((t) => t.entries);
  const traceFor = (requestType, requestData) => {
    const now = { ...state, videoActive: Object.values(state).some(Boolean) };
    return entries.find((e) => e.requestType === requestType && matches(e.when, now) && matches(e.requestData, requestData ?? {}));
  };
  // A real crash ends OBS and every output with it, so a crash during a take counts as a stop.
  const crash = (ws, requestType) => {
    crashes++;
    if (state.recording) stops.push({ requestType, cause: 'crash' });
    for (const k of Object.keys(state)) state[k] = false;
    ws.terminate();
  };
  const later = (ms, fn) => {
    const t = setTimeout(() => (timers.delete(t), fn()), ms);
    timers.add(t);
  };
  const key = () => o.streamKey ?? 'sample-stream-key';
  const token = () => o.token ?? 'sample-refresh-token';
  const inputOf = (d) => d?.inputName ?? (typeof d?.inputUuid === 'string' ? d.inputUuid.replace(/^uuid-/, '') : undefined);
  // Settings as inputs, filters, outputs, transitions and scripts hold them: a key can be in any string, at any depth.
  const settings = () => ({
    // F-T12-4 and F-T12-8: a key in a URL path, query or user name, with any scheme, in text, or with no scheme.
    server: `rtmp://live.example.com/app/${key()}`, srt_url: `srt://ingest.example.com:9000?streamid=${key()}`, rist_url: `rist://ingest.example.com:8000?secret=${key()}`, widget: `https://alerts.example.com/widget/${key()}`,
    rtsp_url: `rtsp://admin:${key()}@cam.local/stream`, udp_url: `udp://239.0.0.1:1234?key=${key()}`, tcp_url: `tcp://ingest.example.com:9000/${key()}`,
    icecast_url: `icecast://source:${key()}@radio.example.com:8000/mount`, spaced: ` rtmp://live.example.com/app/${key()}`,
    note: `Ingest at rtmp://live.example.com/app/${key()} today`, login: `admin:${key()}@cam.local/stream`, input: `cam.local:554/live/${key()}`,
    // F-T12-11: a password with "@" and "/". F-T12-13: other secret names, a flag in text, and JSON text in a string.
    password: `pa@ss/${key()}`, pwd: key(), pass: key(), psk: key(), rtmp_key: key(), args: `--key=${key()} --fast`, json: JSON.stringify({ token: key() }),
    // F-T12-12: secrets in arrays, in objects in arrays, and in nested arrays.
    playlist: [{ value: `live.example.com/app/${key()}`, hidden: false }], headers: [`Authorization: Bearer ${key()}`, ['nested', key()]],
    show_cursor: true, volume: 0.5, unset: null,
  });
  // With plant on, every string value of a reply, at any depth, becomes a unique secret, and so does every key, except the
  // keys that OBS fixes: the reply fields of the protocol and the fields of an item in a reply list. Each secret is listed
  // with its field: the nearest key that the fake kept. A test then checks each secret it finds against its own list.
  // The rule does not depend on any field name, so it does not share a blind spot with the server.
  const plant = (field) => planted[planted.push({ secret: `PLANTED_${planted.length}_K9w4`, field }) - 1].secret;
  // at: 'reply' (the reply: keys kept), 'field' (a reply field: a list holds items), 'item' (an item: keys kept), 'deep'.
  const plantIn = (v, field, at) => {
    if (typeof v === 'string') return plant(field);
    if (Array.isArray(v)) return v.map((x) => plantIn(x, field, at === 'field' ? 'item' : 'deep'));
    if (!v || typeof v !== 'object') return v;
    const keep = at === 'reply' || at === 'item';
    return Object.fromEntries(Object.entries(v).map(([k, x]) => (keep ? [k, plantIn(x, k, at === 'reply' ? 'field' : 'deep')] : [plant(field), plantIn(x, field, 'deep')])));
  };
  const plantReply = (v) => plantIn(v, '', 'reply');
  const profile = () => ({ 'Twitch/RefreshToken': token(), 'AdvOut/FFURL': `rtmp://live.example.com/app/${key()}`, 'Video/BaseCX': '1920' });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: o.port ?? 0 });
  let connections = 0;
  await new Promise((r) => wss.once('listening', r));

  const outputs = () =>
    o.outputs ?? [
      { outputName: 'adv_file_output', outputKind: 'ffmpeg_muxer', outputActive: state.recording },
      { outputName: 'adv_stream', outputKind: 'rtmp_output', outputActive: state.streaming },
      { outputName: 'virtualcam_output', outputKind: 'virtualcam_output', outputActive: state.virtualCam },
      { outputName: 'Replay Buffer', outputKind: 'replay_buffer', outputActive: state.replayBuffer },
    ].map((x) => ({ outputWidth: 1920, outputHeight: 1080, outputFlags: {}, ...x }));
  const answer = (type, data) => {
    switch (type) {
      case 'GetOutputList':
        return { outputs: outputs() };
      case 'GetInputList':
        return { inputs: Object.entries(o.inputs).map(([inputName, inputKind]) => ({ inputName, inputUuid: `uuid-${inputName}`, inputKind, unversionedInputKind: inputKind, inputKindCaps: 0 })) };
      case 'GetVersion':
        return { obsVersion: o.obsVersion, obsWebSocketVersion: '5.7.6', rpcVersion: 1, availableRequests: [...DOCUMENTED.keys(), ...PRIVATE_REQUESTS], supportedImageFormats: ['png', 'jpg'], platform: o.platform, platformDescription: `${o.platform} (simulated)` };
      case 'GetRecordDirectory':
        return { recordDirectory: o.recordDirectory ?? 'sample' };
      case 'GetRecordStatus':
        return { outputActive: state.recording, outputPaused: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputBytes: 0 };
      case 'GetStreamStatus':
        return { outputActive: state.streaming, outputReconnecting: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputCongestion: 0, outputBytes: 0, outputSkippedFrames: 0, outputTotalFrames: 0 };
      case 'GetInputSettings': {
        return { inputKind: o.inputs[inputOf(data)] ?? 'sample_kind', inputSettings: { url: 'https://example.com/overlay?token=abc123', display_uuid: DISPLAY_UUID, ...settings() } };
      }
      case 'GetInputDefaultSettings':
        return { defaultInputSettings: { display_uuid: DISPLAY_UUID, ...settings() } };
      case 'GetStreamServiceSettings': // F-T12-9: a server with no scheme and the key in its path
        return { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: `live.example.com:1935/app/${key()}`, protocol: 'RTMP', key: key(), use_auth: true, username: 'someone', password: o.password ?? 'none' } };
      case 'GetOutputSettings':
        return { outputSettings: { ...settings(), url: `ingest.example.com:1935/app/${key()}` } }; // a custom FFmpeg output URL with no scheme
      case 'GetSourceFilter':
        return { filterEnabled: true, filterIndex: 0, filterKind: 'sample_kind', filterSettings: settings() };
      case 'GetSourceFilterList':
        return { filters: [{ filterEnabled: true, filterIndex: 0, filterKind: 'scale_filter', filterName: 'Scale', filterSettings: { sampling: 'lanczos', ...settings() } }] };
      case 'GetSourceFilterDefaultSettings':
        return { defaultFilterSettings: settings() };
      case 'GetCurrentSceneTransition':
        return { transitionName: 'Swipe', transitionUuid: 'uuid-Swipe', transitionKind: 'swipe_transition', transitionFixed: false, transitionDuration: 300, transitionConfigurable: true, transitionSettings: { direction: 'left', ...settings() } };
      case 'GetProfileParameter':
        return { parameterValue: profile()[`${data?.parameterCategory}/${data?.parameterName}`] ?? null, defaultParameterValue: null };
      case 'GetPersistentData':
        return { slotValue: data?.slotName === 'count' ? 3 : data?.slotName === 'blob' ? settings() : token() };
      case 'GetSourceScreenshot':
        return { imageData: `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}` };
      case 'GetInputPropertiesListPropertyItems':
        return { propertyItems: [{ itemName: 'Display', itemValue: 0, itemEnabled: true }] };
      default: {
        const r = DOCUMENTED.get(type);
        return Object.fromEntries(r.responseFields.filter((f) => !f.valueName.includes('.')).map((f) => [f.valueName, sample(f.valueType)]));
      }
    }
  };

  wss.on('connection', (ws) => {
    connections++;
    const challenge = randomBytes(16).toString('base64');
    const salt = randomBytes(16).toString('base64');
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.7.6', rpcVersion: 1, ...(o.password ? { authentication: { challenge, salt } } : {}) } }));
    ws.on('message', (raw) => {
      const { op, d } = JSON.parse(String(raw));
      if (op === 1) {
        if (o.password && d.authentication !== sha(sha(o.password + salt) + challenge)) return ws.close(4009, 'Authentication failed.');
        ws.subscriptions = d.eventSubscriptions ?? ALL_EVENTS;
        return ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      }
      if (op === 6) {
        const reply = handle(ws, d);
        if (reply) ws.send(JSON.stringify({ op: 7, d: reply }));
      } else if (op === 8) {
        // A RequestBatch: each request is logged, answered and counted like a single one, in order. A crash ends the batch.
        const results = [];
        for (const r of d.requests ?? []) {
          const reply = handle(ws, r);
          if (ws.readyState !== ws.OPEN) return;
          if (reply) results.push(reply);
        }
        ws.send(JSON.stringify({ op: 9, d: { requestId: d.requestId, results } }));
      }
    });
  });
  /** Logs and answers one request, and plays its trace. Returns the reply, or nothing on a crash or a silent request. */
  const handle = (ws, { requestType, requestId, requestData }) => {
    log.push(requestType);
    sent.push({ requestType, requestData });
    if (requestType === o.crashOn) return crash(ws, requestType);
    if (o.silentOn?.includes(requestType)) return undefined;
    if (requestType === 'GetInputPropertiesListPropertyItems') {
      const cleared = o.inputs[inputOf(requestData)] === 'screen_capture' && requestData?.propertyName === 'type';
      if (!cleared) return crash(ws, requestType);
    }
    const known = DOCUMENTED.has(requestType) || PRIVATE_REQUESTS.includes(requestType);
    const failed = !known ? 204 : o.failOn?.includes(requestType) ? 600 : undefined;
    const t = failed ? undefined : traceFor(requestType, requestData);
    const status = failed ? { result: false, code: failed, comment: 'simulated failure' } : (t?.status ?? { result: true, code: 100 });
    const answered = t ? (t.responseData ?? {}) : answer(requestType, requestData);
    // GetVersion is the handshake that the server needs to run, so it is never planted.
    const data = o.plant && requestType !== 'GetVersion' ? plantReply(answered) : answered;
    if (t) {
      // The trace's events go out at their delays; its effect on the output state lands with the last one, as in OBS.
      // A stop counts at once: OBS accepted the request, so the take ends.
      if (t.effect?.recording === false && state.recording) stops.push({ requestType, cause: 'request' });
      for (const ev of t.events ?? []) later(ev.delayMs ?? 0, () => broadcast(ev));
      later(Math.max(0, ...(t.events ?? []).map((ev) => ev.delayMs ?? 0)), () => Object.assign(state, t.effect));
    }
    return { requestType, requestId, requestStatus: status, ...(status.result ? { responseData: data } : {}) };
  };
  const broadcast = ({ eventType, eventData }) => {
    const message = JSON.stringify({ op: 5, d: { eventType, eventIntent: EVENT_BIT.get(eventType), eventData } });
    for (const c of wss.clients) if (c.subscriptions & EVENT_BIT.get(eventType)) c.send(message);
  };

  return {
    port: wss.address().port,
    log,
    sent,
    planted,
    state,
    stops,
    crashes: () => crashes,
    connections: () => connections,
    options: o,
    close: () => new Promise((r) => {
      for (const t of timers) clearTimeout(t);
      for (const c of wss.clients) c.terminate();
      wss.close(r);
    }),
  };
}
