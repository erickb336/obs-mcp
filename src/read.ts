// The read path of obs_read: which requests run, and the guard of each one that needs a guard.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brief, checkFields, entry, readRule, READ_GUARDED, search } from './catalogue.js';
import { Obs, ObsError } from './obs.js';
import { redact } from './redact.js';

export type ReadResult = { ok: true; data: unknown } | { ok: false; refused: string; [k: string]: unknown };

/**
 * GetInputPropertiesListPropertyItems runs only on a row of this table. A list request can crash OBS: a list with
 * a null item closes the socket with 1006. A row is added only after a test on real OBS on that platform.
 * os is the platform that OBS reports in GetVersion.
 */
export const CLEARED_LIST_ROWS = [{ os: 'macos', obsVersion: '33.0.1', inputKind: 'screen_capture', propertyName: 'type' }];

/**
 * GetProfileParameter runs only on these (category, name) pairs. A profile also holds service tokens (for example
 * RefreshToken) and output URLs with a stream key (for example FFURL), so any other pair is refused and not sent.
 */
export const SAFE_PROFILE_PARAMETERS = new Map(Object.entries({
  Output: ['Mode'],
  Video: ['BaseCX', 'BaseCY', 'OutputCX', 'OutputCY', 'FPSType', 'FPSCommon', 'FPSInt', 'FPSNum', 'FPSDen', 'ScaleType', 'ColorFormat', 'ColorSpace', 'ColorRange'],
  Audio: ['SampleRate', 'ChannelSetup'],
  SimpleOutput: ['FilePath', 'RecFormat2', 'RecQuality', 'RecEncoder', 'StreamEncoder', 'VBitrate', 'ABitrate', 'RecRB', 'RecRBTime', 'RecRBSize'],
  AdvOut: ['RecType', 'RecFilePath', 'RecFormat2', 'RecEncoder', 'Encoder', 'RecTracks', 'TrackIndex', 'RecRB', 'RecRBTime', 'RecRBSize',
    'Track1Bitrate', 'Track2Bitrate', 'Track3Bitrate', 'Track4Bitrate', 'Track5Bitrate', 'Track6Bitrate'],
}));

const refuse =(refused: string, extra: Record<string, unknown> = {}): ReadResult => ({ ok: false, refused, ...extra });

export async function read(obs: Obs, request: string, params: Record<string, unknown> = {}): Promise<ReadResult> {
  const e = entry(request);
  if (!e) {
    return refuse(`${request} is not in the catalogue of documented requests, so it is not sent.`, {
      nearest: search(request, 3).map((x) => x.request),
    });
  }
  if (e.class !== 'read' && !READ_GUARDED.has(e.request)) return refuse(`${e.request}: ${readRule(e)}. It was not sent.`);
  const bad = checkFields(e, params);
  if (bad) return refuse(`${e.request}: ${bad}. It was not sent.`, { fields: brief(e).fields });
  if (e.request === 'GetProfileParameter') {
    const { parameterCategory: c, parameterName: n } = params as Record<string, string>;
    if (!SAFE_PROFILE_PARAMETERS.get(c)?.includes(n)) {
      return refuse(`${e.request}: (${c}, ${n}) is not on the list of safe profile parameters, because a profile can hold tokens and stream keys. It was not sent.`, {
        safe: Object.fromEntries(SAFE_PROFILE_PARAMETERS),
      });
    }
  }

  try {
    const v = await obs.connect();
    if (!v.availableRequests.includes(e.request)) return refuse(`This OBS does not offer ${e.request}. It was added in obs-websocket ${e.initialVersion}.`);
    if (e.request === 'GetInputPropertiesListPropertyItems') {
      const why = await listGuard(obs, params);
      if (why) return refuse(`${e.request}: ${why} It was not sent.`);
    }
    const reply = await obs.call(e.request, params);
    if (e.request === 'GetSourceScreenshot') return { ok: true, data: saveScreenshot(reply, params) };
    return { ok: true, data: redact(reply, params) };
  } catch (err) {
    if (err instanceof ObsError) return refuse(err.message);
    throw err;
  }
}

/** Returns why a list request must not run, or null. Reads the recording state just before, whoever started the recording. */
async function listGuard(obs: Obs, params: Record<string, unknown>): Promise<string | null> {
  // With both fields, the guard could clear one input while OBS resolves the other.
  if (params.inputName !== undefined && params.inputUuid !== undefined) return 'give inputName or inputUuid, not both.';
  const status = await obs.call('GetRecordStatus');
  if (status.outputActive) return 'a recording is active, and a list request can crash OBS.';
  const input = params.inputUuid !== undefined ? { inputUuid: params.inputUuid } : { inputName: params.inputName };
  const { inputKind } = await obs.call('GetInputSettings', input);
  const v = obs.version!;
  const row = CLEARED_LIST_ROWS.find(
    (r) => r.os === v.platform && r.obsVersion === v.obsVersion && r.inputKind === inputKind && r.propertyName === params.propertyName,
  );
  return row ? null : `no cleared row for (${v.platform}, OBS ${v.obsVersion}, ${String(inputKind)}, ${String(params.propertyName)}). A list request can crash OBS, so only rows tested on real OBS run.`;
}

// Screenshots go to a folder that the server owns. The image never goes to the model, and the model cannot set the path.
let shotDir: string | undefined;
let shotCount = 0;
function saveScreenshot(reply: Record<string, unknown>, params: Record<string, unknown>) {
  const data = String(reply.imageData ?? '');
  const format = /^[a-z0-9]{1,8}$/i.test(String(params.imageFormat)) ? String(params.imageFormat).toLowerCase() : 'img';
  const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  shotDir ??= mkdtempSync(join(tmpdir(), 'obs-mcp-screenshots-'));
  const file = join(shotDir, `screenshot-${++shotCount}.${format}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file, bytes: bytes.length, note: 'The image is saved to a file that this server owns. It is not sent to the model.' };
}
