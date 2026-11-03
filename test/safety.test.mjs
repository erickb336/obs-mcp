// Secret scan (A8), no listening socket, doctor with OBS closed, and the machine-neutral scan of the repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeObs } from './fake-obs.mjs';
import { closedPort, connect, obsConfigDir, runDoctor, sampleParams, testEnv } from './helpers.mjs';

const CATALOGUE = JSON.parse(readFileSync(new URL('../dist/catalogue.json', import.meta.url), 'utf8'));
const PASSWORD = 'fake-obs-password-K9w4';
const STREAM_KEY = 'live_123456789_fakeStreamKeyK9w4';
const TOKEN = 'fake-refresh-token-K9w4';

// Patterns for a secret, not only the known values: a secret-named field with a value, a password argument,
// a stream key in the form that services use, and a URL with a user name or a query.
const SECRET_PATTERNS = [
  /"(password|server_password|passwd|secret|token|key|stream_key|username)"\s*:\s*"(?!\[redacted\])[^"]+"/i,
  /--websocket_password[ =]\S+/,
  /\blive_\d{6,}_[A-Za-z0-9]{8,}/,
  /\b[a-z]+:\/\/[^\s"/]*@/i,
  /\b(rtmps?|https?|srt|rist):\/\/[^\s"]*\?[^\s"]*/i,
  /\b(rtmps?|srt|rist):\/\/[^\s"/]+\/[^\s"]+/i,
];
const leaks = (text) => [
  ...new Set([PASSWORD, STREAM_KEY, TOKEN].filter((v) => text.includes(v)).concat(SECRET_PATTERNS.map((p) => p.exec(text)?.[0]).filter(Boolean))),
];

test('the secret scan pattern finds a planted secret, so a pass below means something', () => {
  assert.deepEqual(leaks(`{"key":"abc","note":"x"}`), ['"key":"abc"']);
  assert.deepEqual(leaks(`run --websocket_password ${PASSWORD}`), [PASSWORD, `--websocket_password ${PASSWORD}`]);
  assert.deepEqual(leaks('key live_987654321_abcdefgh12 and rtmp://a.example/app?k=1'), ['live_987654321_abcdefgh12', 'rtmp://a.example/app?k=1']);
  assert.deepEqual(leaks('srt://h.example:9000?streamid=s1 rist://h.example/k2'), ['srt://h.example:9000?streamid=s1', 'rist://h.example/k2']);
  assert.deepEqual(leaks(`"parameterValue":"${TOKEN}"`), [TOKEN]);
  assert.deepEqual(leaks('live_requests_with_no_catalogue_row rtmp://live.example.com [cut]'), []);
});

test('no reply, server log or doctor output holds a password or a key (A8)', async () => {
  const fake = await startFakeObs({ password: PASSWORD, streamKey: STREAM_KEY, token: TOKEN });
  const dir = obsConfigDir({ server_enabled: true, server_port: fake.port, auth_required: true, server_password: PASSWORD });
  const env = testEnv(dir, fake.port);
  const s = await connect(env);
  await s.call('obs_status');
  await s.call('obs_find', { query: 'stream service settings key' });
  for (const e of CATALOGUE) await s.call('obs_read', { request: e.request, params: sampleParams(e) });
  await s.call('obs_read', { request: 'GetInputSettings', params: { inputName: 'Display' } });
  for (const [parameterCategory, parameterName] of [['Twitch', 'RefreshToken'], ['AdvOut', 'FFURL'], ['Video', 'BaseCX']]) {
    await s.call('obs_read', { request: 'GetProfileParameter', params: { parameterCategory, parameterName } });
  }
  await s.call('obs_read', { request: 'GetPersistentData', params: { realm: 'OBS_WEBSOCKET_DATA_REALM_PROFILE', slotName: 'auth' } });
  const argv = process.platform === 'win32' ? '' : execFileSync('ps', ['-o', 'args=', '-p', String(s.pid())], { encoding: 'utf8' });
  await s.close();
  const doctorRun = await runDoctor(env);
  await fake.close();
  assert.equal(fake.log.includes('GetStreamServiceSettings'), true, 'the stream settings were read, so the key was on the wire');
  const all = [...s.replies, s.stderr(), doctorRun.stdout, doctorRun.stderr, argv].join('\n');
  assert.ok(s.replies.length >= 150);
  assert.deepEqual(leaks(all), []);
});

test('F-T12-17: with DEBUG=*, no password or planted secret of an OBS reply reaches stderr', async () => {
  const fake = await startFakeObs({ password: PASSWORD, streamKey: STREAM_KEY, token: TOKEN, plant: true });
  const dir = obsConfigDir({ server_enabled: true, server_port: fake.port, auth_required: true, server_password: PASSWORD });
  const s = await connect(testEnv(dir, fake.port, { DEBUG: '*', DEBUG_DEPTH: '10' }));
  for (const request of ['GetStreamServiceSettings', 'GetInputSettings', 'GetOutputSettings']) {
    const e = CATALOGUE.find((x) => x.request === request);
    await s.call('obs_read', { request, params: { ...sampleParams(e), ...(request === 'GetInputSettings' ? { inputName: 'Display' } : {}) } });
  }
  await s.close();
  await fake.close();
  assert.ok(fake.planted.length > 50, `${fake.planted.length} secrets were on the wire`);
  const err = s.stderr();
  const leaked = [PASSWORD, ...fake.planted].filter((p) => err.includes(p));
  assert.deepEqual(leaked, [], `${leaked.length} secrets in stderr`);
});

test('F-T12-18: the packed package holds npm-shrinkwrap.json, so npx installs the pinned versions', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // The shrinkwrap is the project's only lockfile, so the pack needs no script (npm can run with ignore-scripts).
  const out = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
  const files = JSON.parse(out.slice(out.indexOf('[')))[0].files.map((f) => f.path);
  assert.ok(files.includes('npm-shrinkwrap.json'), files.join(', '));
  const shrinkwrap = JSON.parse(readFileSync(join(root, 'npm-shrinkwrap.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(shrinkwrap.packages[''].dependencies, pkg.dependencies);
  assert.equal(shrinkwrap.packages['node_modules/debug'].version, '4.4.3');
});

test('the server process opens no listening socket', { skip: process.platform === 'win32' && 'uses lsof' }, async () => {
  const s = await connect(testEnv(obsConfigDir(null), await closedPort()));
  await s.call('obs_status');
  let out = '';
  try {
    out = execFileSync('lsof', ['-nP', '-a', '-p', String(s.pid()), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  } catch (e) {
    out = e.stdout ?? '';
  }
  const anyOpen = execFileSync('lsof', ['-nP', '-a', '-p', String(s.pid()), '-d', '0-2'], { encoding: 'utf8' });
  await s.close();
  assert.match(anyOpen, /\d/, 'lsof can read the server process');
  assert.equal(out.trim(), '');
});

const hashDir = (dir) => {
  const h = createHash('sha256');
  const walk = (d) => readdirSync(d).sort().forEach((f) => {
    const p = join(d, f);
    h.update(p);
    if (statSync(p).isDirectory()) walk(p);
    else h.update(readFileSync(p));
  });
  walk(dir);
  return h.digest('hex');
};

test('doctor with OBS closed reports it plainly, keeps the crash sentinel and changes no OBS file', async () => {
  const dir = obsConfigDir({ server_enabled: true, server_port: 4455, auth_required: true, server_password: PASSWORD });
  mkdirSync(join(dir, '.sentinel'));
  writeFileSync(join(dir, '.sentinel', 'run_sample'), '');
  const before = hashDir(dir);
  const r = await runDoctor(testEnv(dir, await closedPort()));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /connection +FAIL +No answer from OBS on 127\.0\.0\.1:\d+\. OBS is closed, its WebSocket server is off, or it uses another port\./);
  assert.match(r.stdout, /server +pass +The OBS WebSocket server is on/);
  assert.match(r.stdout, /crash +warn +OBS left 1 run file\(s\) in its \.sentinel folder/);
  assert.match(r.stdout, /Doctor changed nothing\./);
  assert.ok(existsSync(join(dir, '.sentinel', 'run_sample')));
  assert.equal(hashDir(dir), before);
});

test('doctor says when the WebSocket server is off, and skips the connection', async () => {
  const r = await runDoctor(testEnv(obsConfigDir({ server_enabled: false, server_port: await closedPort() }), 0, { OBS_WEBSOCKET_PORT: '' }));
  assert.match(r.stdout, /server +FAIL +The OBS WebSocket server is off\./);
  assert.match(r.stdout, /connection +skip +Needs the WebSocket server\./);
});

test('doctor passes the connection and auth checks against the fake OBS', async () => {
  const fake = await startFakeObs({ password: PASSWORD });
  const dir = obsConfigDir({ server_enabled: true, server_port: fake.port, auth_required: true, server_password: PASSWORD });
  const r = await runDoctor(testEnv(dir, fake.port));
  await fake.close();
  assert.match(r.stdout, /connection +pass +Connected to OBS 33\.0\.1, obs-websocket 5\.7\.6, at ws:\/\/127\.0\.0\.1:\d+\. Authentication passed\./);
  assert.match(r.stdout, /password +info +Password source: obs-websocket settings file\. The value is never shown\./);
  assert.deepEqual(fake.log, ['GetVersion']);
});

test('a password given as an argument is refused, and not echoed', () => {
  let r;
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--password', PASSWORD], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    r = e;
  }
  assert.equal(r.status, 2);
  assert.match(r.stderr, /never from an argument/);
  assert.equal(r.stderr.includes(PASSWORD), false);
});

// The repository is public: no home path, account name, private address or e-mail of one machine.
test('the repository holds no machine-specific path, address or e-mail', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const patterns = [
    /\/Users\/[A-Za-z0-9._-]+/,
    /\/home\/[A-Za-z0-9._-]+/,
    /[A-Z]:\\Users\\[A-Za-z0-9._-]+/,
    /\b(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+\b/,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  ];
  const hits = files
    .filter((f) => !f.endsWith('npm-shrinkwrap.json') && existsSync(join(root, f)))
    .flatMap((f) => patterns.filter((p) => p.test(readFileSync(join(root, f), 'utf8'))).map((p) => `${f}: ${p}`));
  assert.deepEqual(hits, []);
});
