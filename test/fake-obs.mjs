// A minimal in-memory fake of OBS with obs-websocket 5 (JSON). SIMULATED: it is not real OBS.
// It answers every documented request with sample values in the shape of protocol.json, logs each request it gets,
// and closes the socket with no close frame (the client sees 1006) on a list request that real OBS can crash on.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

const protocol = JSON.parse(readFileSync(new URL('../protocol/protocol.json', import.meta.url), 'utf8'));
const DOCUMENTED = new Map(protocol.requests.map((r) => [r.requestType, r]));
export const PRIVATE_REQUESTS = ['GetSourcePrivateSettings', 'SetSourcePrivateSettings', 'GetSceneItemPrivateSettings', 'SetSceneItemPrivateSettings'];
const sha = (s) => createHash('sha256').update(s).digest('base64');
const SAMPLE = { String: 'sample', Number: 1, Boolean: false, Object: {}, Any: null };
const sample = (type) => (type.startsWith('Array') ? [] : SAMPLE[type]);

/**
 * options: password, recording (bool), platform, obsVersion, inputs ({name: kind}), streamKey, token, crashOn (request name),
 * plant (bool: each string inside the settings of a reply becomes a unique planted secret, listed in `planted`).
 * Each input has the UUID "uuid-<name>". Like OBS, the fake resolves inputName first and inputUuid only when no name is given.
 * Returns { port, log, planted, close() }. log holds every request type that reached the fake, in order.
 */
export const DISPLAY_UUID = '5d1f3c2a-8b4e-4f6a-9c7d-0e1f2a3b4c5d';
export async function startFakeObs(options = {}) {
  const o = { platform: 'macos', obsVersion: '33.0.1', inputs: { Display: 'screen_capture', 'App audio': 'sck_audio_capture' }, ...options };
  const log = [];
  const planted = [];
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
  // With plant on, each string inside settings becomes a unique secret, so a test can look for each one in the replies.
  const plantIn = (v) => {
    if (typeof v === 'string') return planted[planted.push(`PLANTED_${planted.length}_K9w4`) - 1];
    if (Array.isArray(v)) return v.map(plantIn);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plantIn(x)]));
    return v;
  };
  const plantReply = (v) => {
    if (Array.isArray(v)) return v.map(plantReply);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k.endsWith('Settings') || k === 'slotValue' ? plantIn(x) : plantReply(x)]));
  };
  const profile = () => ({ 'Twitch/RefreshToken': token(), 'AdvOut/FFURL': `rtmp://live.example.com/app/${key()}`, 'Video/BaseCX': '1920' });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));

  const answer = (type, data) => {
    switch (type) {
      case 'GetVersion':
        return { obsVersion: o.obsVersion, obsWebSocketVersion: '5.7.6', rpcVersion: 1, availableRequests: [...DOCUMENTED.keys(), ...PRIVATE_REQUESTS], supportedImageFormats: ['png', 'jpg'], platform: o.platform, platformDescription: `${o.platform} (simulated)` };
      case 'GetRecordStatus':
        return { outputActive: !!o.recording, outputPaused: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputBytes: 0 };
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
    const challenge = randomBytes(16).toString('base64');
    const salt = randomBytes(16).toString('base64');
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.7.6', rpcVersion: 1, ...(o.password ? { authentication: { challenge, salt } } : {}) } }));
    ws.on('message', (raw) => {
      const { op, d } = JSON.parse(String(raw));
      if (op === 1) {
        if (o.password && d.authentication !== sha(sha(o.password + salt) + challenge)) return ws.close(4009, 'Authentication failed.');
        return ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      }
      if (op !== 6) return;
      const { requestType, requestId, requestData } = d;
      log.push(requestType);
      if (requestType === o.crashOn) return ws.terminate();
      if (requestType === 'GetInputPropertiesListPropertyItems') {
        const cleared = o.inputs[inputOf(requestData)] === 'screen_capture' && requestData?.propertyName === 'type';
        if (!cleared) return ws.terminate();
      }
      const known = DOCUMENTED.has(requestType) || PRIVATE_REQUESTS.includes(requestType);
      const answered = known ? answer(requestType, requestData) : { error: 204 };
      const data = o.plant ? plantReply(answered) : answered;
      const status = data?.error ? { result: false, code: data.error, comment: 'simulated failure' } : { result: true, code: 100 };
      ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: status, ...(status.result ? { responseData: data } : {}) } }));
    });
  });

  return {
    port: wss.address().port,
    log,
    planted,
    options: o,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }),
  };
}
