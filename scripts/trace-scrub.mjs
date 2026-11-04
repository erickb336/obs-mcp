// The trace scrub. A trace goes into this public repository only after the scrub. The scrub works from an allow-list:
// a string stays only when its form or its field says that it cannot hold a secret, a name or a path. Every other
// string, and every object key that does not have the form of an obs-websocket field, becomes a placeholder. A string that stays must also
// pass a second, separate check: a deny list of secrets, addresses and the names of this machine.
// findLeaks() lists each place where scrub() changes a value, so a stored trace is clean when the scrub leaves it as it is.
//
//   node scripts/trace-scrub.mjs <in.json> <out.json>    scrub one trace file
//   node scripts/trace-scrub.mjs --in-place <file.json>... scrub files in place, with one map of fake UUIDs
//   node scripts/trace-scrub.mjs --check <file.json>...  exit 1 when a file holds a value that the scrub removes
//
// The scan output names the place and the rule, never the value, so that a log does not hold the leak.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = /^\[(scrubbed|path)\]$/;
// A field whose name says that it holds a secret: its whole value goes, also when it is an object.
const SECRET_FIELD = /pass(word|wd)?$|^pwd$|secret|token|key$|^psk$|salt|challenge|^auth(entication|orization)?$|^(user(name)?|login|email)$|cookie|bearer/i;
// A whole value that looks like a file path: POSIX, home (~), Windows drive, network share or file URL.
const PATH = /^(\/|~[/\\]|[A-Za-z]:[\\/]|\\\\|file:)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The value of a text field that the capture or a person writes: a sentence with no path, URL, address mark, quote or "=" in it.
const TEXT = /^[\w .,;:()'+-]*$/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (list) => new RegExp(`^(${[...list].map(escape).join('|')})$`);
const protocol = JSON.parse(readFileSync(new URL('../protocol/protocol.json', import.meta.url), 'utf8'));
// The text of a failed request: only the obs-websocket messages that hold no value of the request (F-T27-2). A message
// such as "No source was found by the name of ..." holds a name, so it goes.
const COMMENTS = ['Video settings cannot be changed while an output is active.', 'You cannot change stream service settings while streaming.'];
// The outputs that OBS itself makes, by their fixed names. A name field holds any other value only as a placeholder.
const OUTPUT_NAMES = ['adv_stream', 'adv_file_output', 'adv_ffmpeg_output', 'simple_stream', 'simple_file_output', 'simple_ffmpeg_output', 'virtualcam_output', 'Replay Buffer'];
// A kind id that OBS or a plugin fixes in code: lower case, with at least one "_", such as "ffmpeg_muxer".
const KIND = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
// The fields whose strings may stay, each with the form that its value must have. Any other field loses its strings,
// for example every name field but the fixed ones below (a user can type a real name there) and every settings value.
const KEEP = new Map([
  ['format', /^obs-mcp-trace\/1$/],
  // captured: the output of the capture script. real: a stored capture from a real OBS.
  ['source', /^(simulated|captured|real)$/],
  // basis, refused and incomplete: the texts of the trace capture.
  ...['basis', 'refused', 'incomplete', 'platformDescription'].map((k) => [k, TEXT]),
  ['comment', exactly(COMMENTS)],
  ...['requestType', 'eventType', 'availableRequests'].map((k) => [k, exactly([...protocol.requests.map((r) => r.requestType), ...protocol.events.map((e) => e.eventType)])]),
  ['outputName', exactly(OUTPUT_NAMES)],
  // The hotkeys that OBS, its browser source and its media sources fix in code, such as "OBSBasic.StopRecording".
  ['hotkeyName', /^(OBSBasic|libobs|ObsBrowser|MediaSource|VLCSource)\.[A-Za-z][\w-]{0,63}$/],
  ...['outputKind', 'inputKind', 'unversionedInputKind', 'filterKind', 'transitionKind'].map((k) => [k, KIND]),
  ['platform', /^(macos|windows|linux|freebsd)$/],
  ...['supportedImageFormats', 'imageFormat'].map((k) => [k, /^[a-z][a-z0-9]{1,4}$/]),
]);
// The fields that hold a form with no free text, by the end of their name (F-T27-2: only there, never in any field):
// a version or a time code, and an OBS enum value.
const FORMS = [
  [/(Version|Timecode)$/, /^[\d.:+-]*\d[\d.:+-]*$/],
  [/(State|Type|Mode)$/, /^OBS_[A-Z0-9_]+$/],
];
const shapeOf = (key) => KEEP.get(key) ?? FORMS.find(([field]) => field.test(key))?.[1];
// A settings value: the free-form values that OBS, plugins and scripts keep (README, "what the AI sees"), and the value
// of a profile parameter. Every string and number in it goes, whatever its shape, because a PIN, a phone number or a
// card number can be a number. A boolean or null stays. Each key in it becomes "hidden_key_<n>" (n is its place in its
// object, from 1), as in the server's redact, because a key can be a name too.
const SETTINGS = /Settings$|^(slotValue|itemName|itemValue|parameterValue|defaultParameterValue)$/;
// The data of a custom or vendor event and of a vendor request is free-form too: the field eventData, requestData or
// responseData of an object whose eventType or requestType is one of these, or that names a vendor.
const FREE_TYPE = /^(CustomEvent|VendorEvent|BroadcastCustomEvent|CallVendorRequest)$/;
const FREE_DATA = /^(eventData|requestData|responseData)$/;
const freeData = (o) => FREE_TYPE.test(o.eventType) || FREE_TYPE.test(o.requestType) || 'vendorName' in o;
// A UUID of the OBS of the capture becomes a fake one: the same fake for the same UUID in all files of one scrub.
// A fake UUID has the form 00000000-0000-4000-8000-<12 digits>, and stays as it is.
// It has no word boundary, so that a UUID right after a letter, a digit or "_" is found too.
const ANY_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FAKE_UUID = /^00000000-0000-4000-8000-\d{12}$/;
// An object key outside settings stays only when it has the form of an obs-websocket field (F-T27-2): camel case, as
// every field of protocol.json and of a trace is, an OBS enum name (a key of outputFlags) or a number (an audio track).
// So a key such as "SamExample" goes. A UUID in a key counts as a word, so that it can become its fake.
const KEY = /^([a-z][\w-]{0,63}|OBS_[A-Z0-9_]{1,60}|\d{1,6})$/;
const keyForm = (k) => KEY.test(k.replace(ANY_UUID, 'uuid'));

// The deny list: each string that the allow-list keeps, and each key, must also match none of these.
// A rule marked "text" runs on text fields only, because an identifier such as "libobs.mute" has the shape of a host name.
const DENY = [
  ['secret in text', /\b(pass(word|wd)?|pwd|secret|token|(api|access|stream)?key)\s*[:=]/i],
  ['bearer token', /\bBearer\s+\S/],
  ['stream key', /\blive_\d{4,}_[A-Za-z0-9]+/],
  ['long token', /(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])\b[A-Za-z0-9]{16,}\b/],
  ['IPv4 address', /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)\d{1,3}(\.\d{1,3}){3}\b/],
  ['IPv6 address', /\b([0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b|\b[0-9a-f]{1,4}(:[0-9a-f]{1,4})*::([0-9a-f]{1,4}(:[0-9a-f]{1,4})*)?(?![\w:])/i],
  ['host name', /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]+\b/i, 'text'],
];

/**
 * The values of this machine and the run: the account name and the host name (4 characters or more, as a whole word,
 * so that a short name such as "obs" does not match common text), and each secret that the caller gives.
 */
function localRules({ secrets = [], user = userInfo().username, host = hostname() } = {}) {
  const word = (w, rule) => (w && w.length >= 4 ? [[rule, new RegExp(`\\b${escape(w)}\\b`, 'i')]] : []);
  return [
    ...secrets.filter(Boolean).map((s) => ['secret of the run', new RegExp(escape(s))]),
    ...word(user, 'account name of this machine'),
    ...[...new Set([host, host.split('.')[0]])].flatMap((h) => word(h, 'host name of this machine')),
  ];
}

const denied = (s, rules, text) => rules.find(([, re, scope]) => (!scope || text) && re.test(s))?.[0];

/** The rule that removes the string s in the field key, or undefined when it stays. */
function why(key, s, rules, inSettings) {
  if (s === '' || PLACEHOLDER.test(s)) return undefined;
  if (SECRET_FIELD.test(key)) return `secret field "${key}"`;
  if (PATH.test(s)) return 'file path';
  if (inSettings) return 'settings value';
  const shape = shapeOf(key);
  if (!(shape?.test(s) || (/Uuid$/.test(key) && UUID.test(s)))) return 'not on the allow-list';
  return denied(s, rules, shape === TEXT);
}

/**
 * The function that gives the fake UUID of a real one. text is all the input of the scrub: a fake UUID that is already
 * in it is not given again to another UUID.
 */
export function uuidFaker(text = '') {
  const map = new Map();
  const used = new Set((text.match(ANY_UUID) ?? []).filter((u) => FAKE_UUID.test(u)));
  let n = 0;
  return (u) => {
    if (FAKE_UUID.test(u)) return u;
    const real = u.toLowerCase();
    while (!map.has(real)) {
      const fake = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      if (!used.has(fake)) map.set(real, fake);
    }
    return map.get(real);
  };
}

/** Each change that the scrub makes, as { path, rule }, with the scrubbed value. */
function walk(value, options = {}) {
  const rules = [...localRules(options), ...DENY];
  const fakeUuid = options.fakeUuid ?? uuidFaker(JSON.stringify(value));
  const changes = [];
  const unreal = (s, path) => {
    const out = s.replace(ANY_UUID, fakeUuid);
    if (out !== s) changes.push({ path, rule: 'UUID of a real OBS' });
    return out;
  };
  const go = (v, path, key, inSettings = SETTINGS.test(key)) => {
    if (typeof v === 'string') {
      const rule = why(key, v, rules, inSettings);
      if (!rule) return unreal(v, path);
      changes.push({ path, rule });
      return rule === 'file path' ? '[path]' : '[scrubbed]';
    }
    if (typeof v === 'number' && inSettings) return changes.push({ path, rule: 'settings value' }), '[scrubbed]';
    if (Array.isArray(v)) return v.map((x, i) => go(x, `${path}[${i}]`, key, inSettings));
    if (v && typeof v === 'object') {
      if (SECRET_FIELD.test(key) && Object.keys(v).length) return changes.push({ path, rule: `secret field "${key}"` }), '[scrubbed]';
      if (inSettings) {
        return Object.fromEntries(Object.entries(v).map(([k, x], i) => {
          const name = `hidden_key_${i + 1}`;
          const at = path ? `${path}.${name}` : name;
          if (k !== name) changes.push({ path: at, rule: 'key: settings key' });
          return [name, go(x, at, name, true)];
        }));
      }
      const free = freeData(v);
      return Object.fromEntries(Object.entries(v).map(([k, x]) => {
        // A key that is not a field name can be a path, a URL or a name: it goes, and the scan output never shows it.
        const bad = PLACEHOLDER.test(k) || FAKE_UUID.test(k) ? undefined : keyForm(k) ? denied(k, rules, false) : 'not an identifier';
        // A UUID in a key becomes its fake, also in the path that the scan shows.
        const name = bad ? '[scrubbed]' : k.replace(ANY_UUID, fakeUuid);
        const at = path ? `${path}.${name}` : name;
        if (bad) changes.push({ path: at, rule: `key: ${bad}` });
        else if (name !== k) changes.push({ path: at, rule: 'key: UUID of a real OBS' });
        return [name, go(x, at, name, inSettings || SETTINGS.test(name) || (free && FREE_DATA.test(name)))];
      }));
    }
    return v;
  };
  return { value: go(value, '', ''), changes };
}

/**
 * The value with every secret and machine detail replaced, and each real UUID replaced by a fake one.
 * options: { secrets, user, host } (defaults: this machine), and fakeUuid (from uuidFaker) to share fakes between values.
 */
export const scrub = (value, options) => walk(value, options).value;
/** Each place where the value holds something that scrub() removes, as { path, rule }. An empty list means clean. */
export const findLeaks = (value, options) => walk(value, options).changes;

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === '--check' && rest.length) {
    let bad = 0;
    for (const file of rest) {
      const leaks = findLeaks(JSON.parse(readFileSync(file, 'utf8')));
      for (const l of leaks) console.log(`${file}: ${l.path}: ${l.rule}`);
      bad += leaks.length;
    }
    console.log(bad ? `${bad} value(s) to scrub.` : `clean: ${rest.length} file(s).`);
    process.exit(bad ? 1 : 0);
  } else if (first === '--in-place' && rest.length) {
    // All the files share one map of fake UUIDs, so that a UUID in two files stays one UUID.
    const texts = rest.map((file) => readFileSync(file, 'utf8'));
    const fakeUuid = uuidFaker(texts.join('\n'));
    rest.forEach((file, i) => {
      const { value, changes } = walk(JSON.parse(texts[i]), { fakeUuid });
      // A clean file stays as it is, also its layout.
      if (changes.length) writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
      console.log(`scrubbed ${changes.length} value(s) in ${file}.`);
    });
  } else if (first && rest.length === 1) {
    const { value, changes } = walk(JSON.parse(readFileSync(first, 'utf8')));
    writeFileSync(rest[0], `${JSON.stringify(value, null, 2)}\n`);
    console.log(`scrubbed ${changes.length} value(s) into ${rest[0]}.`);
  } else {
    console.error('Usage:\n  node scripts/trace-scrub.mjs <in.json> <out.json>\n  node scripts/trace-scrub.mjs --in-place <file.json>...\n  node scripts/trace-scrub.mjs --check <file.json>...');
    process.exit(2);
  }
}
