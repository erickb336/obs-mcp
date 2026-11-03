// The trace scrub. A trace goes into this public repository only after the scrub: it removes passwords, auth
// challenge and salt values, stream keys, URLs, host names, addresses, user names, home paths and file paths.
// One rule set does both jobs: scrub() replaces each value, and findLeaks() lists each place where scrub() would
// change a value. So a stored trace is clean when the scrub leaves it as it is.
//
//   node scripts/trace-scrub.mjs <in.json> <out.json>    scrub one trace file
//   node scripts/trace-scrub.mjs --check <file.json>...  exit 1 when a file holds a value that the scrub removes
//
// The scan output names the place and the rule, never the value, so that a log does not hold the leak.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

// A field whose name says that it holds a secret: its whole value goes.
const SECRET_FIELD = /pass(word|wd)?$|^pwd$|secret|token|(^|_)key$|^streamKey$|^psk$|salt|challenge|^auth(entication|orization)?$|^(user(name)?|login|email)$|cookie|bearer/i;
// A field that holds free-form text (settings, persistent data, profile values, list items). A string in it stays
// only when it is a short word, such as an enum value; any other string can be a token, a name or a path, and goes.
const FREE_FORM = (key) => /Settings$|_settings$/.test(key) || ['slotValue', 'parameterValue', 'defaultParameterValue', 'itemName', 'itemValue'].includes(key);
const WORD = /^([A-Za-z][A-Za-z0-9_.+-]{0,23})?$/;
const PLACEHOLDER = /^\[(scrubbed|path|host|address|user|email)\]$/;
// A whole value that is a file path: POSIX, home (~), Windows drive or network share.
const PATH = /^(\/[^/\s]|~[/\\]|[A-Za-z]:[\\/]|\\\\)/;

// Rules for text inside any string, in order. Each replacement is also a match of its own rule, so the scrub of a
// scrubbed value changes nothing.
const TEXT_RULES = [
  ['flag with a secret', /--[\w-]*(password|key|token|secret)[\w-]*[= ]\S+/gi, (m) => `${m.slice(0, m.search(/[= ]/))}=[scrubbed]`],
  ['URL', /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'<>]+/gi, (m, scheme) => `${scheme}://[scrubbed]`],
  ['host with a port', /\b[a-z0-9-]+(\.[a-z0-9-]+)+:\d{2,5}(\/[^\s"'<>]*)?/gi, () => '[host]'],
  ['stream key', /\blive_\d{4,}_[A-Za-z0-9]+/g, () => '[scrubbed]'],
  ['bearer token', /\bBearer\s+(?!\[scrubbed\])\S+/g, () => 'Bearer [scrubbed]'],
  ['e-mail', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, () => '[email]'],
  ['macOS home', /\/Users\/[^/\s"'\\]+/g, () => '/Users/[user]'],
  ['Linux home', /\/home\/[^/\s"'\\]+/g, () => '/home/[user]'],
  ['Windows home', /\b[A-Za-z]:\\Users\\[^\\\s"']+/gi, () => 'C:\\Users\\[user]'],
  ['.local host', /\b[A-Za-z0-9-]+\.local\b/g, () => '[host]'],
  ['IPv4 address', /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)\d{1,3}(\.\d{1,3}){3}\b/g, () => '[address]'],
  ['IPv6 address', /\b([0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b|\b[0-9a-f]{1,4}(:[0-9a-f]{1,4})*::([0-9a-f]{1,4}(:[0-9a-f]{1,4})*)?(?![\w:])/gi, () => '[address]'],
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The values of this machine and the run: the account name and the host name (4 characters or more, as a whole word,
 * so that a short name such as "obs" does not match common text), and each secret that the caller gives.
 */
function localRules({ secrets = [], user = userInfo().username, host = hostname() } = {}) {
  const word = (w, rule, to) => (w && w.length >= 4 ? [[rule, new RegExp(`\\b${escape(w)}\\b`, 'gi'), () => to]] : []);
  return [
    ...secrets.filter(Boolean).map((s) => ['secret of the run', new RegExp(escape(s), 'g'), () => '[scrubbed]']),
    ...word(user, 'account name of this machine', '[user]'),
    ...[...new Set([host, host.split('.')[0]])].flatMap((h) => word(h, 'host name of this machine', '[host]')),
  ];
}

/** Each change that the scrub makes, as { path, rule, after }, with the scrubbed value. */
function walk(value, options) {
  const rules = [...localRules(options), ...TEXT_RULES];
  const changes = [];
  const text = (s, path) => {
    let out = s;
    for (const [rule, re, to] of rules) {
      const next = out.replace(re, to);
      if (next !== out) changes.push({ path, rule });
      out = next;
    }
    return out;
  };
  const go = (v, path, key, free) => {
    if (typeof v === 'string') {
      if (PLACEHOLDER.test(v)) return v;
      if (SECRET_FIELD.test(key)) return changes.push({ path, rule: `secret field "${key}"` }), '[scrubbed]';
      if (PATH.test(v)) return changes.push({ path, rule: 'file path' }), '[path]';
      if (free && !WORD.test(v)) return changes.push({ path, rule: 'free-form text' }), '[scrubbed]';
      return text(v, path);
    }
    if (Array.isArray(v)) return v.map((x, i) => go(x, `${path}[${i}]`, key, free));
    if (v && typeof v === 'object') {
      if (SECRET_FIELD.test(key) && Object.keys(v).length) return changes.push({ path, rule: `secret field "${key}"` }), '[scrubbed]';
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, go(x, path ? `${path}.${k}` : k, k, free || FREE_FORM(k))]));
    }
    return v;
  };
  return { value: go(value, '', '', false), changes };
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
