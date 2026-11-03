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
 * options: password, recording (bool), platform, obsVersion, inputs ({name: kind}), streamKey, token, crashOn (request name).
 * Each input has the UUID "uuid-<name>". Like OBS, the fake resolves inputName first and inputUuid only when no name is given.
 * Returns { port, log, close() }. log holds every request type that reached the fake, in order.
 */
export async function startFakeObs(options = {}) {
  const o = { platform: 'macos', obsVersion: '33.0.1', inputs: { Display: 'screen_capture', 'App audio': 'sck_audio_capture' }, ...options };
  const log = [];
  const key = () => o.streamKey ?? 'sample-stream-key';
  const token = () => o.token ?? 'sample-refresh-token';
  const inputOf = (d) => d?.inputName ?? (typeof d?.inputUuid === 'string' ? d.inputUuid.replace(/^uuid-/, '') : undefined);
  // Settings with a key in a URL path or query, as RTMP, SRT and RIST outputs, filters and media sources hold them.
  const keyUrls = () => ({ server: `rtmp://live.example.com/app/${key()}`, srt_url: `srt://ingest.example.com:9000?streamid=${key()}`, rist_url: `rist://ingest.example.com:8000?secret=${key()}`, widget: `https://alerts.example.com/widget/${key()}` });
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
        return { inputKind: o.inputs[inputOf(data)] ?? 'sample_kind', inputSettings: { url: 'https://example.com/overlay?token=abc123', show_cursor: true, ...keyUrls() } };
      }
      case 'GetStreamServiceSettings':
        return { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: 'rtmp://live.example.com/app/secretpath?k=1', key: o.streamKey ?? 'sample-stream-key', use_auth: true, username: 'someone', password: o.password ?? 'none' } };
      case 'GetOutputSettings':
        return { outputSettings: keyUrls() };
      case 'GetSourceFilter':
        return { filterEnabled: true, filterIndex: 0, filterKind: 'sample_kind', filterSettings: keyUrls() };
      case 'GetProfileParameter':
        return { parameterValue: profile()[`${data?.parameterCategory}/${data?.parameterName}`] ?? null, defaultParameterValue: null };
      case 'GetPersistentData':
        return { slotValue: data?.slotName === 'count' ? 3 : token() };
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
      const data = known ? answer(requestType, requestData) : { error: 204 };
      const status = data?.error ? { result: false, code: data.error, comment: 'simulated failure' } : { result: true, code: 100 };
      ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: status, ...(status.result ? { responseData: data } : {}) } }));
    });
  });

  return {
    port: wss.address().port,
    log,
    options: o,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }),
  };
}
