import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capped, redact, streamServiceView } from '../dist/redact.js';
import { search } from '../dist/catalogue.js';

test('redact replaces secret-named values and cuts the query of a URL, at any depth', () => {
  const out = redact({ inputSettings: { password: 'p1', stream_key: 'k1', token: 7, url: 'https://example.com/page?token=abc#x', bypass: true, name: 'Mic' } });
  assert.deepEqual(out, { inputSettings: { password: '[redacted]', stream_key: '[redacted]', token: '[redacted]', url: 'https://example.com [cut]', bypass: true, name: 'Mic' } });
});

test('F-T12-4: a URL keeps only its scheme and host, because a path or query can hold a key', () => {
  assert.deepEqual(
    ['rtmp://live.example.com/app/live_123_abc', 'rtmps://a.example:443/live2/k', 'srt://ingest.example.com:9000?streamid=k1', 'rist://ingest.example.com:8000?secret=k2', 'https://alerts.example.com/widget/t0k', 'https://example.com/', 'wss://example.com'].map((u) => redact(u)),
    ['rtmp://live.example.com [cut]', 'rtmps://a.example:443 [cut]', 'srt://ingest.example.com:9000 [cut]', 'rist://ingest.example.com:8000 [cut]', 'https://alerts.example.com [cut]', 'https://example.com', 'wss://example.com'],
  );
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

test('F-T12-6: search with an Object.prototype name returns a normal result', () => {
  assert.deepEqual(search('constructor').map((e) => e.request), []);
  assert.deepEqual(search('constructor input volume', 2).map((e) => e.request).sort(), ['GetInputVolume', 'SetInputVolume']);
});

test('search finds the request for plain words', () => {
  assert.deepEqual(search('input volume', 2).map((e) => e.request).sort(), ['GetInputVolume', 'SetInputVolume']);
  assert.equal(search('list of scenes')[0].request, 'GetSceneList');
});
