// Catalogue parity (A16) and the class counts of the design.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCatalogue, countClasses } from '../scripts/catalogue.mjs';

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const PROTOCOL = at('protocol/protocol.json');
const protocol = JSON.parse(readFileSync(PROTOCOL, 'utf8'));
const classes = JSON.parse(readFileSync(at('catalogue/classes.json'), 'utf8'));
const SCRIPT = at('scripts/catalogue.mjs');

test('the class table has one row per documented request: 58 read, 56 change, 33 guarded', () => {
  const catalogue = buildCatalogue(protocol, classes);
  assert.equal(catalogue.length, 147);
  assert.deepEqual(countClasses(catalogue), { read: 58, change: 56, guarded: 33 });
});

test('a request with no class row fails the build, and the error names it', () => {
  const withNew = { ...protocol, requests: [...protocol.requests, { ...protocol.requests[0], requestType: 'GetNewThing' }] };
  assert.throws(() => buildCatalogue(withNew, classes), /no row in catalogue\/classes\.json: GetNewThing\./);
});

test('a row with no documented request fails the build', () => {
  const fewer = { ...protocol, requests: protocol.requests.filter((r) => r.requestType !== 'GetVersion') };
  assert.throws(() => buildCatalogue(fewer, classes), /Rows with no documented request: GetVersion\./);
});

test('the parity check command exits 1 on a protocol.json with an unknown request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-mcp-parity-'));
  const file = join(dir, 'protocol.json');
  writeFileSync(file, JSON.stringify({ ...protocol, requests: [...protocol.requests, { ...protocol.requests[0], requestType: 'SetNewThing' }] }));
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--check', file], { stdio: 'pipe' }), (e) => e.status === 1 && /SetNewThing/.test(String(e.stderr)));
  const ok = execFileSync(process.execPath, [SCRIPT, '--check', PROTOCOL], { encoding: 'utf8' });
  assert.match(ok, /147 requests/);
});
