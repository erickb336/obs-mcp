import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capped, redact } from '../dist/redact.js';
import { search } from '../dist/catalogue.js';

const K = 'live_123456789_fakeStreamKeyK9w4';
const hidden = (s) => ({ hidden: 'text', length: s.length });

test('inside settings, numbers, booleans and null pass, and every other string is hidden as type and length', () => {
  const settings = { password: 'p1', pwd: K, name: 'Mic', url: 'https://example.com', volume: 0.5, on: true, unset: null };
  assert.deepEqual(redact({ inputKind: 'browser_source', inputSettings: settings }), {
    inputKind: 'browser_source',
    inputSettings: { password: hidden('p1'), pwd: hidden(K), name: hidden('Mic'), url: hidden('https://example.com'), volume: 0.5, on: true, unset: null },
  });
});

test('fields outside settings pass, so names, kinds and states stay readable', () => {
  const reply = { sceneName: 'Main', scenes: [{ sceneName: 'Main', sceneIndex: 0 }], outputActive: false };
  assert.deepEqual(redact(reply), reply);
});

test('an allow-listed (kind, key) passes only a value of its shape', () => {
  const uuid = '5d1f3c2a-8b4e-4f6a-9c7d-0e1f2a3b4c5d';
  assert.deepEqual(redact({ inputKind: 'screen_capture', inputSettings: { display_uuid: uuid } }).inputSettings, { display_uuid: uuid });
  assert.deepEqual(redact({ inputKind: 'screen_capture', inputSettings: { display_uuid: K } }).inputSettings, { display_uuid: hidden(K) });
  // The same key under another kind is hidden.
  assert.deepEqual(redact({ inputKind: 'browser_source', inputSettings: { display_uuid: uuid } }).inputSettings, { display_uuid: hidden(uuid) });
  // A default-settings reply has no kind field: the kind comes from the request.
  assert.deepEqual(redact({ defaultFilterSettings: { sampling: 'lanczos', file: 'a' } }, { filterKind: 'scale_filter' }), { defaultFilterSettings: { sampling: 'lanczos', file: hidden('a') } });
});

test('F-T12-9: a stream server with no scheme and a key in its path is hidden; an enum passes', () => {
  const server = `live.example.com:1935/app/${K}`;
  const out = redact({ streamServiceType: 'rtmp_custom', streamServiceSettings: { server, key: K, protocol: 'RTMP', use_auth: true } });
  assert.deepEqual(out.streamServiceSettings, { server: hidden(server), key: hidden(K), protocol: 'RTMP', use_auth: true });
  const common = redact({ streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'Twitch', server: 'auto', key: K } });
  assert.deepEqual(common.streamServiceSettings, { service: 'Twitch', server: 'auto', key: hidden(K) });
});

test('F-T12-11, F-T12-13: a password with "@" or "/", other secret names, a flag in text and JSON text are hidden whole', () => {
  const values = { password: `pa@ss/${K}`, pass: K, psk: K, rtmp_key: K, args: `--key=${K} --fast`, json: JSON.stringify({ token: K }) };
  const out = redact({ outputSettings: values });
  assert.deepEqual(out.outputSettings, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, hidden(v)])));
});

test('F-T12-12: an array item keeps its parent key, at any depth', () => {
  const out = redact({ filterKind: 'scale_filter', filterSettings: { sampling: ['lanczos', K], list: [{ value: K, on: true }, [K, 2]] } });
  assert.deepEqual(out.filterSettings, { sampling: ['lanczos', hidden(K)], list: [{ value: hidden(K), on: true }, [hidden(K), 2]] });
});

test('GetPersistentData: a slot value is settings, so text is hidden and a number passes', () => {
  assert.deepEqual(redact({ slotValue: K }), { slotValue: hidden(K) });
  assert.deepEqual(redact({ slotValue: 3 }), { slotValue: 3 });
  assert.deepEqual(redact({ slotValue: { token: K, n: 1 } }), { slotValue: { token: hidden(K), n: 1 } });
});

test('F-T12-10: a 200,000-character value returns within 50 ms', () => {
  for (const s of ['a'.repeat(200000), `a:${'b'.repeat(199998)}`, 'x://'.repeat(50000), 'a@'.repeat(100000)]) {
    const t = performance.now();
    const out = capped(redact({ inputKind: 'screen_capture', inputSettings: { display_uuid: s, note: s } }));
    const ms = performance.now() - t;
    assert.equal(out, '{"inputKind":"screen_capture","inputSettings":{"display_uuid":{"hidden":"text","length":200000},"note":{"hidden":"text","length":200000}}}');
    assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
  }
});

test('a long reply is cut with a note that gives the full length', () => {
  const s = capped({ a: 'x'.repeat(30000) });
  assert.match(s, /\[cut at 24000 of 30008 characters/);
  assert.equal(capped({ a: 1 }), '{"a":1}');
});

test('F-T12-6: search with an Object.prototype name returns a normal result', () => {
  assert.deepEqual(search('constructor').map((e) => e.request), []);
  assert.deepEqual(search('constructor input volume', 2).map((e) => e.request).sort(), ['GetInputVolume', 'SetInputVolume']);
});

test('search finds the request for plain words', () => {
  assert.deepEqual(search('input volume', 2).map((e) => e.request).sort(), ['GetInputVolume', 'SetInputVolume']);
  assert.equal(search('list of scenes')[0].request, 'GetSceneList');
});
