// Builds the request catalogue from the pinned protocol.json and the committed class table.
// The build fails when a documented request has no class row, or a row names no documented request.
//
//   node scripts/catalogue.mjs                       write dist/catalogue.json
//   node scripts/catalogue.mjs --check <protocol>    only check parity against another protocol.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export const CLASSES = ['read', 'change', 'guarded'];

/** Returns the catalogue, or throws an error that names each request with no row and each row with no request. */
export function buildCatalogue(protocol, classes) {
  const names = protocol.requests.map((r) => r.requestType);
  const missing = names.filter((n) => !classes[n]);
  const extra = Object.keys(classes).filter((n) => !names.includes(n));
  const bad = Object.entries(classes).filter(([, row]) => !CLASSES.includes(row[0])).map(([n]) => n);
  if (missing.length || extra.length || bad.length) {
    throw new Error(
      [
        missing.length && `Requests with no row in catalogue/classes.json: ${missing.join(', ')}. Add a row for each.`,
        extra.length && `Rows with no documented request: ${extra.join(', ')}.`,
        bad.length && `Rows with an unknown class: ${bad.join(', ')}.`,
      ].filter(Boolean).join('\n'),
    );
  }
  return protocol.requests.map((r) => {
    const [cls, route, from] = classes[r.requestType];
    return {
      request: r.requestType,
      category: r.category,
      class: cls,
      ...(cls === 'guarded' ? { route, from } : {}),
      description: r.description,
      fields: r.requestFields.map((f) => ({ name: f.valueName, type: f.valueType, optional: f.valueOptional, description: f.valueDescription })),
      initialVersion: r.initialVersion,
      deprecated: r.deprecated,
    };
  });
}

export const countClasses = (catalogue) =>
  catalogue.reduce((m, e) => ({ ...m, [e.class]: (m[e.class] ?? 0) + 1 }), {});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv[2] === '--check';
  const protocolPath = check ? process.argv[3] : join(root, 'protocol/protocol.json');
  if (!protocolPath) throw new Error('Usage: node scripts/catalogue.mjs --check <path to protocol.json>');
  try {
    const catalogue = buildCatalogue(readJson(protocolPath), readJson(join(root, 'catalogue/classes.json')));
    if (!check) {
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(join(root, 'dist/catalogue.json'), JSON.stringify(catalogue));
    }
    console.log(`catalogue: ${catalogue.length} requests, ${JSON.stringify(countClasses(catalogue))}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
