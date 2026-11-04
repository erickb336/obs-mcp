import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { obsCheck } from '../dist/doctor.js';
import { listenerCheck } from '../dist/obs.js';
import { controlLock, findObs, netstatListeners, onPath, probe, tasklistName, windowsTool } from '../dist/platform.js';

// Sample "netstat -ano -p TCP" output. The headers and the state words change with the Windows display language.
const ENGLISH = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1040
  TCP    0.0.0.0:4455           0.0.0.0:0              LISTENING       7312
  TCP    127.0.0.1:4455         127.0.0.1:50123        ESTABLISHED     7312
  TCP    127.0.0.1:50123        127.0.0.1:4455         ESTABLISHED     9001
  TCP    192.0.2.10:4455        198.51.100.7:4455      TIME_WAIT       0
`;
const GERMAN = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN          1040
  TCP    127.0.0.1:4455         0.0.0.0:0              ABHÖREN          7312
  TCP    127.0.0.1:4455         127.0.0.1:50123        HERGESTELLT      7312
  TCP    192.0.2.10:4455        198.51.100.7:4455      WARTEND          0
`;

test('F-T12-2, F-T12-22: the netstat reading finds the listener and its process id in any display language', () => {
  assert.deepEqual(netstatListeners(ENGLISH, 4455), [{ address: '0.0.0.0:4455', pid: '7312' }]);
  assert.deepEqual(netstatListeners(GERMAN, 4455), [{ address: '127.0.0.1:4455', pid: '7312' }]);
  assert.deepEqual(netstatListeners(GERMAN, 4456), []);
  assert.equal(tasklistName('"obs64.exe","7312","Console","1","250,000 K"\r\n'), 'obs64.exe');
  assert.equal(tasklistName('INFO: No tasks are running which match the specified criteria.'), undefined);
});

test('F-T12-18: Windows tools run by their full path in the Windows folder, not by a name that PATH resolves', () => {
  assert.equal(windowsTool('netstat.exe', { SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\netstat.exe');
  assert.equal(windowsTool('tasklist.exe', {}), 'C:\\Windows\\System32\\tasklist.exe');
});

test('F-T12-21: a probe that fails is no reading (null), not "nothing listens"; lsof exit 1 with no text is "nothing"', () => {
  const node = process.execPath;
  assert.equal(probe(node, ['-e', 'process.stderr.write("lsof: WARNING: can\'t stat()"); process.exit(1)'], 1), null);
  assert.equal(probe(node, ['-e', 'process.exit(1)'], 1), '');
  assert.equal(probe(node, ['-e', 'process.exit(2)'], 1), null);
  assert.equal(probe(node, ['-e', 'process.stdout.write("x")']), 'x');
  assert.equal(probe(join(tmpdir(), 'no-such-tool-K9w4'), []), null);
});

test('F-T12-21, F-T12-22, F-T12-27: the listener check reads one way, names the program and warns when it is not OBS', () => {
  assert.deepEqual(listenerCheck(4455, null, false), { result: 'info', text: 'Port 4455: unknown, because the OS tool that lists listeners gave no reading.' });
  assert.deepEqual(listenerCheck(4455, [], false), { result: 'info', text: 'Nothing listens on port 4455 now.' });
  assert.deepEqual(listenerCheck(4455, [], true), { result: 'info', text: 'OBS answers on port 4455, but the OS tool lists no listener there, so its exposure is unknown.' });
  assert.deepEqual(listenerCheck(4455, null, true), { result: 'info', text: 'OBS answers on port 4455, but the OS tool that lists listeners gave no reading, so its exposure is unknown.' });
  assert.deepEqual(listenerCheck(4455, [{ address: '127.0.0.1:4455', process: 'obs64.exe' }], true), { result: 'info', text: 'Port 4455 listens on 127.0.0.1:4455 only. Program: obs64.exe.' });
  const all = listenerCheck(4455, [{ address: '*:4455', process: 'OBS' }, { address: '[::]:4455', process: 'OBS' }], true);
  assert.equal(all.result, 'info');
  assert.match(all.text, /^Port 4455 listens on all network interfaces \(\*:4455, \[::\]:4455\)\. .* Program: OBS\.$/);
  const other = listenerCheck(4455, [{ address: '0.0.0.0:4455', process: 'python3' }], true);
  assert.equal(other.result, 'warn');
  assert.match(other.text, /Program: python3\. python3 is not OBS, and obs-mcp connects to it as OBS\. Close that program, or give OBS another port and set OBS_WEBSOCKET_PORT to it\.$/);
  assert.equal(listenerCheck(4455, [{ address: '127.0.0.1:4455' }], true).text, 'Port 4455 listens on 127.0.0.1:4455 only. Program: unknown.');
});

test('F-T12-37: PATH discovery ignores an empty segment and folders; a file counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'obs-mcp-path-'));
  mkdirSync(join(root, 'folder', 'obs'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'obs'), '');
  writeFileSync(join(root, 'obs'), '');
  const cwd = process.cwd();
  process.chdir(root); // an empty PATH segment means this folder, which holds a file named obs
  try {
    assert.equal(onPath({ PATH: ['', join(root, 'folder')].join(delimiter) }, 'obs'), undefined);
    assert.equal(onPath({ PATH: ['', join(root, 'folder'), join(root, 'bin')].join(delimiter) }, 'obs'), join(root, 'bin', 'obs'));
  } finally {
    process.chdir(cwd);
  }
});

test('F-T12-37: a Steam install of OBS on Windows is found', () => {
  const root = mkdtempSync(join(tmpdir(), 'obs-mcp-steam-'));
  const exe = join(root, 'Steam', 'steamapps', 'common', 'OBS Studio', 'bin', '64bit', 'obs64.exe');
  mkdirSync(join(exe, '..'), { recursive: true });
  assert.equal(findObs({ 'ProgramFiles(x86)': root }, 'win32'), null);
  writeFileSync(exe, '');
  assert.deepEqual(findObs({ 'ProgramFiles(x86)': root }, 'win32'), { path: exe });
});

test('F-T12-37: OBS not found is a warning when OBS answers, and a failure when it does not', () => {
  assert.equal(obsCheck(null, undefined, true).result, 'warn');
  assert.equal(obsCheck(null, undefined, false).result, 'FAIL');
  assert.equal(obsCheck({ path: '/opt/obs' }, '33.0.1', false).text, 'OBS found at /opt/obs, version 33.0.1');
});

test('G32: the controller lock is a named pipe on Windows and a short socket path elsewhere, one for each OBS address and user', () => {
  const url = 'ws://127.0.0.1:4455';
  assert.match(controlLock(url, { USERNAME: 'a' }, 'win32'), /^\\\\\.\\pipe\\obs-mcp-[0-9a-f]{16}$/);
  assert.notEqual(controlLock(url, { USERNAME: 'a' }, 'win32'), controlLock(url, { USERNAME: 'b' }, 'win32'), 'another user, another name');
  assert.notEqual(controlLock(url, {}, 'win32'), controlLock('ws://127.0.0.1:4456', {}, 'win32'), 'another port, another name');
  if (process.platform === 'win32') return;
  assert.match(controlLock(url, { XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux'), /^\/run\/user\/1000\/obs-mcp-[0-9a-f]{16}\.sock$/);
  const long = controlLock(url, { XDG_RUNTIME_DIR: `/${'x'.repeat(120)}` }, 'linux');
  assert.match(long, /^\/tmp\/obs-mcp-[0-9a-f]{16}\.sock$/, 'a socket path stays under the limit of the OS');
});
