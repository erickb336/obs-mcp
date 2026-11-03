import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capped, redact } from '../dist/redact.js';
import { search } from '../dist/catalogue.js';

const K = 'live_123456789_fakeStreamKeyK9w4';
const hidden = (s) => ({ hidden: 'text', length: s.length });

test('inside settings, numbers, booleans and null pass, every other string is hidden as type and length, and so is every key off the allow-list', () => {
  const settings = { password: 'p1', pwd: K, name: 'Mic', url: 'https://example.com', volume: 0.5, on: true, unset: null };
  assert.deepEqual(redact({ inputKind: 'browser_source', inputSettings: settings }), {
    inputKind: 'browser_source',
    inputSettings: { hidden_key_1: hidden('p1'), hidden_key_2: hidden(K), hidden_key_3: hidden('Mic'), hidden_key_4: hidden('https://example.com'), hidden_key_5: 0.5, hidden_key_6: true, hidden_key_7: null },
  });
});

test('F-T12-38: a secret in a key of settings or of a slot value never reaches the model; an allow-listed key passes', () => {
  const out = JSON.stringify([
    redact({ slotValue: { sk_live_SECRET123: true } }),
    redact({ inputKind: 'screen_capture', inputSettings: { sk_live_SECRET123: 1, nested: { sk_live_SECRET123: [{ sk_live_SECRET123: 'x' }] } } }),
    redact({ outputSettings: { sk_live_SECRET123: null } }),
  ]);
  assert.equal(out.includes('SECRET123'), false, out);
  assert.deepEqual(redact({ slotValue: { sk_live_SECRET123: true } }), { slotValue: { hidden_key_1: true } });
  assert.deepEqual(redact({ inputKind: 'screen_capture', inputSettings: { display_uuid: 1, sk_live_SECRET123: { a: 2 } } }).inputSettings, { display_uuid: 1, hidden_key_1: { hidden_key_1: 2 } });
});

test('F-T12-43: the name and value of a list item are hidden as type and length; a number and the item state pass', () => {
  const out = redact({ propertyItems: [{ itemName: 'My bank - Safari', itemValue: 'com.apple.Safari', itemEnabled: true }, { itemName: 'Display 1', itemValue: 0, itemEnabled: false }] });
  assert.deepEqual(out, { propertyItems: [{ itemName: hidden('My bank - Safari'), itemValue: hidden('com.apple.Safari'), itemEnabled: true }, { itemName: hidden('Display 1'), itemValue: 0, itemEnabled: false }] });
});

test('fields outside settings pass, so names, kinds and states stay readable', () => {
  const reply = { sceneName: 'Main', scenes: [{ sceneName: 'Main', sceneIndex: 0 }], outputActive: false };
  assert.deepEqual(redact(reply), reply);
});

test('an allow-listed (kind, key) passes only a value of its shape', () => {
  const uuid = '5d1f3c2a-8b4e-4f6a-9c7d-0e1f2a3b4c5d';
  assert.deepEqual(redact({ inputKind: 'screen_capture', inputSettings: { display_uuid: uuid } }).inputSettings, { display_uuid: uuid });
  assert.deepEqual(redact({ inputKind: 'screen_capture', inputSettings: { display_uuid: K } }).inputSettings, { display_uuid: hidden(K) });
  // The same key under another kind is hidden, its value too.
  assert.deepEqual(redact({ inputKind: 'browser_source', inputSettings: { display_uuid: uuid } }).inputSettings, { hidden_key_1: hidden(uuid) });
  // A default-settings reply has no kind field: the kind comes from the request.
  assert.deepEqual(redact({ defaultFilterSettings: { sampling: 'lanczos', file: 'a' } }, { filterKind: 'scale_filter' }), { defaultFilterSettings: { sampling: 'lanczos', hidden_key_1: hidden('a') } });
});

test('F-T12-9: a stream server with no scheme and a key in its path is hidden; an enum passes', () => {
  const server = `live.example.com:1935/app/${K}`;
  const out = redact({ streamServiceType: 'rtmp_custom', streamServiceSettings: { server, key: K, protocol: 'RTMP', use_auth: true } });
  assert.deepEqual(out.streamServiceSettings, { hidden_key_1: hidden(server), hidden_key_2: hidden(K), protocol: 'RTMP', hidden_key_3: true });
  const common = redact({ streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'Twitch', server: 'auto', key: K } });
  assert.deepEqual(common.streamServiceSettings, { service: 'Twitch', server: 'auto', hidden_key_1: hidden(K) });
});

test('F-T12-11, F-T12-13: a password with "@" or "/", other secret names, a flag in text and JSON text are hidden whole', () => {
  const values = { password: `pa@ss/${K}`, pass: K, psk: K, rtmp_key: K, args: `--key=${K} --fast`, json: JSON.stringify({ token: K }) };
  const out = redact({ outputSettings: values });
  assert.deepEqual(out.outputSettings, Object.fromEntries(Object.values(values).map((v, i) => [`hidden_key_${i + 1}`, hidden(v)])));
});

test('F-T12-12: an array item keeps its parent key, at any depth', () => {
  const out = redact({ filterKind: 'scale_filter', filterSettings: { sampling: ['lanczos', K], list: [{ value: K, on: true }, [K, 2]] } });
  assert.deepEqual(out.filterSettings, { sampling: ['lanczos', hidden(K)], hidden_key_1: [{ hidden_key_1: hidden(K), hidden_key_2: true }, [hidden(K), 2]] });
});

test('GetPersistentData: a slot value is settings, so text is hidden and a number passes', () => {
  assert.deepEqual(redact({ slotValue: K }), { slotValue: hidden(K) });
  assert.deepEqual(redact({ slotValue: 3 }), { slotValue: 3 });
  assert.deepEqual(redact({ slotValue: { token: K, n: 1 } }), { slotValue: { hidden_key_1: hidden(K), hidden_key_2: 1 } });
});

test('F-T12-10: a 200,000-character value returns within 50 ms', () => {
  for (const s of ['a'.repeat(200000), `a:${'b'.repeat(199998)}`, 'x://'.repeat(50000), 'a@'.repeat(100000)]) {
    const t = performance.now();
    const out = capped(redact({ inputKind: 'screen_capture', inputSettings: { display_uuid: s, note: s } }));
    const ms = performance.now() - t;
    assert.equal(out, '{"inputKind":"screen_capture","inputSettings":{"display_uuid":{"hidden":"text","length":200000},"hidden_key_1":{"hidden":"text","length":200000}}}');
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
  assert.equal(search('constructor input volume', 2)[0].request, 'GetInputVolume');
});

test('search finds the request for plain words', () => {
  assert.equal(search('input volume')[0].request, 'GetInputVolume');
  assert.equal(search('list of scenes')[0].request, 'GetSceneList');
});

test('F-T12-33: an exact request name comes first, then the read that runs, before change and guarded requests', () => {
  const top = (q, n = 5) => search(q, n).map((e) => e.request);
  assert.deepEqual(top('GetInputVolume', 2), ['GetInputVolume', 'GetInputMute']);
  assert.equal(top('SetInputVolume')[0], 'SetInputVolume');
  assert.equal(top('is OBS recording')[0], 'GetRecordStatus');
  assert.ok(top('current scene').includes('GetCurrentProgramScene'), top('current scene').join());
  assert.ok(top('scene list', 3).includes('GetSceneList'), top('scene list').join());
  assert.ok(top('items in a scene').includes('GetSceneItemList'), top('items in a scene').join());
  // A change request still shows, after the reads with the same words.
  assert.deepEqual(top('stop recording', 3), ['GetRecordStatus', 'GetRecordDirectory', 'StopRecord']);
});
