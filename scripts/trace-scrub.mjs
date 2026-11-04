// The trace scrub. A trace goes into this public repository only after the scrub. The scrub works from an allow-list:
// a string stays only when its form or its field says that it cannot hold a secret, a name or a path. Every other
// string, and every object key that is not a plain identifier, becomes a placeholder. A string that stays must also
// pass a second, separate check: a deny list of secrets, addresses and the names of this machine.
// findLeaks() lists each place where scrub() changes a value, so a stored trace is clean when the scrub leaves it as it is.
//
//   node scripts/trace-scrub.mjs <in.json> <out.json>    scrub one trace file
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
// Forms that hold no free text, in any field: an OBS enum value, and a number, time code or version.
const FORM = /^(OBS_[A-Z0-9_]+|[\d.:+-]*\d[\d.:+-]*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The value of an identifier field: a name that OBS or a plugin fixes in code, such as "adv_file_output".
const IDENT = /^[\w. -]{1,64}$/;
// The value of a text field: a sentence with no path, URL, address mark, quote or "=" in it.
const TEXT = /^[\w .,;:()'+-]*$/;
// The fields whose strings may stay, each with the form that its value must have. Any other field loses its strings,
// for example a scene, input or profile name (a user can type a real name there) and every settings value.
const KEEP = new Map([
  ['format', /^obs-mcp-trace\/1$/],
  // captured: the output of the capture script. real: a stored capture from a real OBS.
  ['source', /^(simulated|captured|real)$/],
  // basis, refused and incomplete: the texts of the trace capture. comment: the text of a failed request.
  ...['basis', 'refused', 'incomplete', 'comment', 'platformDescription'].map((k) => [k, TEXT]),
  ...['requestType', 'eventType', 'availableRequests', 'supportedImageFormats', 'platform', 'outputName', 'outputKind', 'inputKind',
    'unversionedInputKind', 'filterKind', 'transitionKind', 'sourceType', 'hotkeyName', 'imageFormat'].map((k) => [k, IDENT]),
]);
// A settings value: the free-form values that OBS, plugins and scripts keep (README, "what the AI sees"). Every string
// in it goes, whatever its shape, because a PIN, a phone number or a card number has the form of a number.
const SETTINGS = /Settings$|^(slotValue|itemName|itemValue)$/;
// An object key stays only when it is a plain identifier.
const KEY = /^[A-Za-z_][\w.-]{0,63}$/;

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

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const shape = KEEP.get(key);
  if (!(FORM.test(s) || shape?.test(s) || (/Uuid$/.test(key) && UUID.test(s)))) return 'not on the allow-list';
  return denied(s, rules, shape === TEXT);
}

/** Each change that the scrub makes, as { path, rule }, with the scrubbed value. */
function walk(value, options) {
  const rules = [...localRules(options), ...DENY];
  const changes = [];
  const go = (v, path, key, inSettings = SETTINGS.test(key)) => {
    if (typeof v === 'string') {
      const rule = why(key, v, rules, inSettings);
      if (!rule) return v;
      changes.push({ path, rule });
      return rule === 'file path' ? '[path]' : '[scrubbed]';
    }
    if (Array.isArray(v)) return v.map((x, i) => go(x, `${path}[${i}]`, key, inSettings));
    if (v && typeof v === 'object') {
      if (SECRET_FIELD.test(key) && Object.keys(v).length) return changes.push({ path, rule: `secret field "${key}"` }), '[scrubbed]';
      return Object.fromEntries(Object.entries(v).map(([k, x]) => {
        // A key that is not a plain identifier can be a path, a URL or a name: it goes, and the scan output never shows it.
        const bad = PLACEHOLDER.test(k) ? undefined : KEY.test(k) ? denied(k, rules, false) : 'not an identifier';
        const name = bad ? '[scrubbed]' : k;
        const at = path ? `${path}.${name}` : name;
        if (bad) changes.push({ path: at, rule: `key: ${bad}` });
        return [name, go(x, at, name, inSettings || SETTINGS.test(name))];
      }));
    }
    return v;
  };
  return { value: go(value, '', ''), changes };
}

/** The value with every secret and machine detail replaced. options: { secrets, user, host } (defaults: this machine). */
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
  } else if (first && rest.length === 1) {
    const { value, changes } = walk(JSON.parse(readFileSync(first, 'utf8')));
    writeFileSync(rest[0], `${JSON.stringify(value, null, 2)}\n`);
    console.log(`scrubbed ${changes.length} value(s) into ${rest[0]}.`);
  } else {
    console.error('Usage:\n  node scripts/trace-scrub.mjs <in.json> <out.json>\n  node scripts/trace-scrub.mjs --check <file.json>...');
    process.exit(2);
  }
}
