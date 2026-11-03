import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capped, redact, streamServiceView } from '../dist/redact.js';
import { search } from '../dist/catalogue.js';

test('redact replaces secret-named values and cuts the query of a URL, at any depth', () => {
  const out = redact({ inputSettings: { password: 'p1', stream_key: 'k1', token: 7, url: 'https://example.com/page?token=abc#x', bypass: true, name: 'Mic' } });
  assert.deepEqual(out, { inputSettings: { password: '[redacted]', stream_key: '[redacted]', token: '[redacted]', url: 'https://example.com/page [cut]', bypass: true, name: 'Mic' } });
});

test('a URL with no secret part passes unchanged in form', () => {
  assert.equal(redact('https://example.com/overlay'), 'https://example.com/overlay');
});

test('stream service settings pass only service, server and protocol; the server loses its path', () => {
  const out = streamServiceView({ streamServiceType: 'rtmp_custom', streamServiceSettings: { server: 'rtmp://live.example.com/app/key123', key: 'key123', username: 'u', password: 'p', service: 'Custom' } });
  assert.deepEqual(out.streamServiceSettings, { service: 'Custom', server: 'rtmp://live.example.com [cut]' });
  assert.equal(out.streamServiceType, 'rtmp_custom');
});

test('a long reply is cut with a note that gives the full length', () => {
  const s = capped({ a: 'x'.repeat(30000) });
  assert.match(s, /\[cut at 24000 of 30008 characters/);
  assert.equal(capped({ a: 1 }), '{"a":1}');
});

test('search finds the request for plain words', () => {
  assert.deepEqual(search('input volume', 2).map((e) => e.request).sort(), ['GetInputVolume', 'SetInputVolume']);
  assert.equal(search('list of scenes')[0].request, 'GetSceneList');
});
