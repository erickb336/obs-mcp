// The request catalogue, built by scripts/catalogue.mjs from the pinned protocol.json and catalogue/classes.json.
import { readFileSync } from 'node:fs';

export type Field = { name: string; type: string; optional: boolean; description: string };
export type Entry = {
  request: string;
  category: string;
  class: 'read' | 'change' | 'guarded';
  route?: string;
  from?: string;
  description: string;
  fields: Field[];
  initialVersion: string;
  deprecated: boolean;
};

export const CATALOGUE: Entry[] = JSON.parse(readFileSync(new URL('./catalogue.json', import.meta.url), 'utf8'));
const BY_NAME = new Map(CATALOGUE.map((e) => [e.request, e]));
export const entry = (name: string) => BY_NAME.get(name);

// Guarded requests that obs_read runs in 0.0, each behind its own check in read.ts.
export const READ_GUARDED = new Set(['GetInputPropertiesListPropertyItems', 'GetStreamServiceSettings', 'GetProfileParameter']);

/** What obs_read does with a request in this release. */
export function readRule(e: Entry): string {
  if (e.class === 'read') return 'obs_read runs it';
  if (READ_GUARDED.has(e.request)) return 'obs_read runs it behind a guard';
  if (e.class === 'change') return 'changes OBS; not available in 0.0';
  if (e.from === 'never') return 'refused for good';
  return `refused in 0.0; route from ${e.from}: ${e.route}`;
}

/** The short form of an entry that obs_find returns. */
export const brief = (e: Entry) => ({
  request: e.request,
  effect: e.class,
  in_0_0: readRule(e),
  summary: e.description.split('\n')[0],
  fields: e.fields.map((f) => `${f.name}${f.optional ? '?' : ''}: ${f.type}`),
});

// Search: BM25 over name words, description, field names and category, with a small synonym list.
const STOP = new Set('a an the of to for in on and or is are it this that with by from as be set get'.split(' '));
const words = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
const stem = (w: string) => w.replace(/(ing|es|s)$/, '');
// A Map, not an object, so that a query word such as "constructor" finds no inherited value.
const SYNONYMS = new Map(Object.entries({
  mic: ['input'], microphone: ['input'], source: ['input', 'sceneitem'], camera: ['virtualcam', 'input'], webcam: ['input'],
  loud: ['volume'], loudness: ['volume'], gain: ['volume'], silence: ['mute'], unmute: ['mute'], hide: ['enabled', 'item'],
  show: ['enabled', 'item'], move: ['transform', 'position'], resize: ['transform', 'scale'], crop: ['transform'],
  switch: ['current', 'program'], live: ['program'], folder: ['directory'], path: ['directory'], video: ['record', 'settings'],
  clip: ['replay'], delay: ['offset', 'sync'], track: ['tracks'], layer: ['index', 'order'], order: ['index'],
  rename: ['name'], delete: ['remove'], add: ['create'], make: ['create'], recording: ['record'],
}));

const DOCS = CATALOGUE.map((e) => {
  const name = words(e.request).map(stem);
  const text = [...name, ...name, ...name, ...words(e.description).map(stem), ...e.fields.flatMap((f) => words(f.name).map(stem)), ...words(e.category).map(stem)];
  const tf = new Map<string, number>();
  for (const w of text) tf.set(w, (tf.get(w) ?? 0) + 1);
  return { e, len: text.length, tf };
});
const DF = new Map<string, number>();
for (const d of DOCS) for (const w of d.tf.keys()) DF.set(w, (DF.get(w) ?? 0) + 1);
const AVG = DOCS.reduce((s, d) => s + d.len, 0) / DOCS.length;

export function search(query: string, limit = 5): Entry[] {
  const base = words(query);
  const terms = new Set(base.map(stem));
  for (const w of base) for (const s of SYNONYMS.get(w) ?? []) terms.add(stem(s));
  const N = DOCS.length;
  return DOCS.map((d) => {
    let s = 0;
    for (const t of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const df = DF.get(t)!;
      s += (Math.log(1 + (N - df + 0.5) / (df + 0.5)) * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.len) / AVG));
    }
    return { e: d.e, s };
  })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

/** Returns an error text when params do not match the request's fields, or null. */
export function checkFields(e: Entry, params: Record<string, unknown>): string | null {
  const known = new Set(e.fields.map((f) => f.name.split('.')[0]));
  const unknown = Object.keys(params).filter((k) => !known.has(k));
  const missing = e.fields.filter((f) => !f.optional && !f.name.includes('.') && params[f.name] === undefined).map((f) => f.name);
  const wrongType = e.fields
    .filter((f) => params[f.name] !== undefined && f.type !== 'Any' && typeof params[f.name] !== JS_TYPE[f.type])
    .map((f) => `${f.name} must be ${f.type}`);
  if (!unknown.length && !missing.length && !wrongType.length) return null;
  return [
    unknown.length && `unknown fields: ${unknown.join(', ')}`,
    missing.length && `missing fields: ${missing.join(', ')}`,
    wrongType.length && wrongType.join('; '),
  ].filter(Boolean).join('. ');
}
const JS_TYPE: Record<string, string> = { String: 'string', Number: 'number', Boolean: 'boolean', Object: 'object' };
