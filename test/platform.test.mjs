import assert from 'node:assert/strict';
import { test } from 'node:test';
import { netstatListeners, netstatPath } from '../dist/platform.js';

// Sample "netstat -an -p TCP" output. The headers and the state words change with the Windows display language.
const ENGLISH = `
Active Connections

  Proto  Local Address          Foreign Address        State
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING
  TCP    0.0.0.0:4455           0.0.0.0:0              LISTENING
  TCP    127.0.0.1:4455         127.0.0.1:50123        ESTABLISHED
  TCP    127.0.0.1:50123        127.0.0.1:4455         ESTABLISHED
  TCP    192.0.2.10:4455        198.51.100.7:4455      TIME_WAIT
`;
const GERMAN = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status
  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN
  TCP    127.0.0.1:4455         0.0.0.0:0              ABHÖREN
  TCP    127.0.0.1:4455         127.0.0.1:50123        HERGESTELLT
  TCP    192.0.2.10:4455        198.51.100.7:4455      WARTEND
`;

test('F-T12-2: the netstat reading finds the listener in any display language', () => {
  assert.deepEqual(netstatListeners(ENGLISH, 4455), ['0.0.0.0:4455']);
  assert.deepEqual(netstatListeners(GERMAN, 4455), ['127.0.0.1:4455']);
  assert.deepEqual(netstatListeners(GERMAN, 4456), []);
});

test('F-T12-18: netstat runs by its full path in the Windows folder, not by a name that PATH resolves', () => {
  assert.equal(netstatPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\netstat.exe');
  assert.equal(netstatPath({}), 'C:\\Windows\\System32\\netstat.exe');
});
