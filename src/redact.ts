// Every reply passes here before it goes to the model.
//
// Settings are free-form: OBS, plugins and scripts keep any value in them, stream keys, passwords and tokens too.
// So a value inside settings passes only when its shape is known to be safe: a number, a boolean, null, or a string
// that the allow-list below accepts for its (kind, key). Every other string becomes {"hidden":"text","length":n}.
// No string is searched for secrets: the server does not try to recognise a secret, so it cannot miss one.

/** A reply field that holds free-form settings: inputSettings, filterSettings, transitionSettings and the like. */
const isSettings = (key: string) => key.endsWith('Settings') || key === 'slotValue' || key === 'responseData';

type Shape = readonly string[] | 'uuid';
const PROTOCOLS = ['RTMP', 'RTMPS', 'SRT', 'RIST', 'WHIP', 'HLS'];
const AUDIO_DEVICE = { device_id: ['default'] };
const KEY_COLOR = { key_color_type: ['green', 'blue', 'magenta', 'custom'] };
const DIRECTION = { direction: ['left', 'right', 'up', 'down'] };

/**
 * The allow-list: kind -> key -> safe shape. The kind is the input, filter or transition kind, or the stream service
 * type. A key that is not here, or a value with another shape, is hidden. Add a row only for a value that cannot hold
 * a secret: an enum, or a UUID that OBS makes.
 */
export const SAFE_SETTINGS: ReadonlyMap<string, ReadonlyMap<string, Shape>> = new Map(
  Object.entries({
    screen_capture: { display_uuid: 'uuid' },
    coreaudio_input_capture: AUDIO_DEVICE,
    coreaudio_output_capture: AUDIO_DEVICE,
    wasapi_input_capture: AUDIO_DEVICE,
    wasapi_output_capture: AUDIO_DEVICE,
    pulse_input_capture: AUDIO_DEVICE,
    pulse_output_capture: AUDIO_DEVICE,
    noise_suppress_filter_v2: { method: ['speex', 'rnnoise', 'denoiser'] },
    color_key_filter_v2: KEY_COLOR,
    chroma_key_filter_v2: KEY_COLOR,
    scale_filter: { sampling: ['point', 'bilinear', 'bicubic', 'lanczos', 'area'] },
    swipe_transition: DIRECTION,
    slide_transition: DIRECTION,
    rtmp_common: { service: ['Twitch', 'YouTube - RTMPS', 'YouTube - HLS', 'Facebook Live', 'Kick', 'Restream.io'], server: ['auto'], protocol: PROTOCOLS },
    rtmp_custom: { protocol: PROTOCOLS },
  }).map(([kind, keys]) => [kind, new Map(Object.entries(keys as Record<string, Shape>))]),
);

// The length check comes first, so no regex ever reads a long text. This regex has no nested quantifier.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safe(kind: string, key: string, s: string): boolean {
  const shape = SAFE_SETTINGS.get(kind)?.get(key);
  if (!shape || s.length > 64) return false;
  return shape === 'uuid' ? s.length === 36 && UUID.test(s) : shape.includes(s);
}

/** A value inside settings. Arrays and objects recurse, and an array item keeps the key of its parent. */
function settings(v: unknown, kind: string, key: string): unknown {
  if (typeof v === 'string') return safe(kind, key, v) ? v : { hidden: 'text', length: v.length };
  if (Array.isArray(v)) return v.map((x) => settings(x, kind, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, settings(x, kind, k)]));
  return v;
}

const kindOf = (o: Record<string, unknown>, fallback: string) => {
  const k = o.inputKind ?? o.filterKind ?? o.transitionKind ?? o.streamServiceType;
  return typeof k === 'string' ? k : fallback;
};

/**
 * The reply as the model sees it. Fields outside settings (names, kinds, states, numbers) pass. Inside settings, only
 * numbers, booleans, null and allow-listed strings pass. params give the kind for a default-settings request.
 */
export function redact(reply: unknown, params: Record<string, unknown> = {}): unknown {
  const p = params.inputKind ?? params.filterKind;
  const walk = (v: unknown, kind: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, kind));
    if (!v || typeof v !== 'object') return v;
    const k = kindOf(v as Record<string, unknown>, kind);
    return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, isSettings(key) ? settings(x, k, key) : walk(x, k)]));
  };
  return walk(reply, typeof p === 'string' ? p : '');
}

const MAX_CHARS = 24000;
/** JSON text for a reply, cut at a size limit with a clear note. */
export function capped(o: unknown): string {
  const s = JSON.stringify(o);
  return s.length <= MAX_CHARS ? s : `${s.slice(0, MAX_CHARS)}\n[cut at ${MAX_CHARS} of ${s.length} characters. Ask for less, for example one item by name.]`;
}
