// Every value that leaves the server for the model passes here.

const SECRET_KEY = /password|passwd|passphrase|secret|token|bearer|auth|cookie|credential|api_?key|stream_?key|^key$/i;
// A URL with any scheme, anywhere in a text, and a "user:password@host" with no scheme.
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const USERINFO = /[^\s:@/]+:[^\s@/]*@([^\s/?#@]+)\S*/g;
// A key whose value is a URL, so the value can be a URL with no scheme ("host:port/path").
const URL_KEY = /url|(^|_)uri(_|$)|server|ingest|endpoint|^input$/i;

/** Keeps only the scheme and host of a URL. The user name, password, path, query and fragment can each hold a key. */
export function cutUrl(s: string): string {
  try {
    const u = new URL(s);
    const cut = !!(u.username || u.password || u.search || u.hash || u.pathname.length > 1);
    return `${u.protocol}//${u.host}${cut ? ' [cut]' : ''}`;
  } catch {
    return '[redacted]';
  }
}

/** Cuts each URL in a text to its scheme and host, and each "user:password@host" to its host. */
function cutText(s: string, key: string): string {
  const out = s.replace(URL_IN_TEXT, cutUrl).replace(USERINFO, '$1 [cut]');
  if (out !== s || s.includes('://') || !URL_KEY.test(key)) return out;
  // A URL with no scheme in a URL key: only the host and port pass.
  const [, lead, host, rest] = /^(\s*)([^\s/?#]*)(.*)$/s.exec(s)!;
  return rest ? `${lead}${host} [cut]` : s;
}

/** Replaces secret-named values with "[redacted]" and cuts URLs, at any depth. */
export function redact(v: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key) && v !== null && typeof v !== 'boolean' && typeof v !== 'object') return '[redacted]';
  if (typeof v === 'string') return cutText(v, key);
  if (Array.isArray(v)) return v.map((x) => redact(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  return v;
}

// GetStreamServiceSettings: an allow-list of fields, not a removal list. The server URL loses its path and query.
const STREAM_FIELDS = ['service', 'server', 'protocol'];
export function streamServiceView(reply: Record<string, unknown>) {
  const s = (reply.streamServiceSettings ?? {}) as Record<string, unknown>;
  const kept = Object.fromEntries(STREAM_FIELDS.filter((k) => typeof s[k] === 'string').map((k) => [k, redact(s[k])]));
  return { streamServiceType: reply.streamServiceType, streamServiceSettings: kept, note: `Only these fields pass: ${STREAM_FIELDS.join(', ')}. Keys, passwords and user names never pass.` };
}

// GetPersistentData: scripts and plugins keep any value in a slot, tokens too. Only a number, a boolean or null passes.
export function persistentView(reply: Record<string, unknown>) {
  const v = reply.slotValue;
  const safe = v === null || typeof v === 'number' || typeof v === 'boolean';
  return { slotValue: safe ? v : '[redacted]', ...(safe ? {} : { note: `The slot holds a ${Array.isArray(v) ? 'array' : typeof v}. Only a number, a boolean or null passes, because a slot can hold a token.` }) };
}

const MAX_CHARS = 24000;
/** JSON text for a reply, cut at a size limit with a clear note. */
export function capped(o: unknown): string {
  const s = JSON.stringify(o);
  return s.length <= MAX_CHARS ? s : `${s.slice(0, MAX_CHARS)}\n[cut at ${MAX_CHARS} of ${s.length} characters. Ask for less, for example one item by name.]`;
}
