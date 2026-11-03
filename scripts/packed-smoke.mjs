// Packs the package, starts it with npx from the tarball, and drives it with the SDK client over stdio.
// It talks only to the fake OBS of test/fake-obs.mjs, or to a closed port. SIMULATED: no real OBS.
//
//   node scripts/packed-smoke.mjs [transcript.json]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startFakeObs } from '../test/fake-obs.mjs';
import { closedPort, obsConfigDir, testEnv } from '../test/helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2];
const npm = (args, cwd = root) => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
const transcript = [];
const note = (step, data) => transcript.push({ step, ...data });

const packDir = mkdtempSync(join(tmpdir(), 'obs-mcp-pack-'));
const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', packDir]))[0];
const tarball = join(packDir, packed.filename);
note('npm pack', { file: packed.filename, size: packed.size, files: packed.files.map((f) => f.path) });

/** A client session on `npx -y <tarball>`, with every JSON-RPC message kept in the transcript. */
async function session(name, env) {
  // The SDK starts the command with cross-spawn, which finds npx.cmd on Windows.
  const inner = new StdioClientTransport({ command: 'npx', args: ['-y', '--package', tarball, 'obs-mcp'], env, cwd: packDir, stderr: 'pipe' });
  const messages = [];
  const transport = new Proxy(inner, {
    get: (t, p) => (p === 'send' ? (m, o) => (messages.push({ to: 'server', m }), t.send(m, o)) : typeof t[p] === 'function' ? t[p].bind(t) : t[p]),
    set: (t, p, v) => ((t[p] = p === 'onmessage' ? (m, e) => (messages.push({ to: 'client', m }), v(m, e)) : v), true),
  });
  let stderr = '';
  inner.stderr.on('data', (d) => (stderr += d));
  const client = new Client({ name: 'obs-mcp-smoke', version: '0.0.0' });
  await client.connect(transport).catch((e) => {
    throw new Error(`${name}: ${e.message}\nserver stderr:\n${stderr}`);
  });
  return {
    client,
    async done() {
      await client.close();
      note(name, { protocol: client.getNegotiatedProtocolVersion(), messages });
    },
  };
}

const call = async (c, name, args = {}) => JSON.parse((await c.client.callTool({ name, arguments: args })).content[0].text);
const check = (ok, what) => {
  if (!ok) throw new Error(`smoke check failed: ${what}`);
  note('check', { ok: true, what });
};

// 1. OBS closed.
const closed = await session('session with OBS closed', testEnv(obsConfigDir(null), await closedPort(), { OBS_MCP_RECORDING_DIR: mkdtempSync(join(tmpdir(), 'obs-mcp-smoke-rec-')) }));
const { tools } = await closed.client.listTools();
check(tools.map((t) => t.name).sort().join() === 'obs_find,obs_read,obs_status,obs_verify_file', 'tools/list has obs_find, obs_read, obs_status, obs_verify_file');
const status = await call(closed, 'obs_status');
check(status.connected === false && /OBS is closed/.test(status.problem), 'obs_status says that OBS is closed');
check(/has "\.\."/.test((await call(closed, 'obs_verify_file', { path: '../outside.mov' })).problem), 'obs_verify_file refuses a path with ".."');
await closed.done();

// 2. The fake OBS.
const fake = await startFakeObs({ password: 'smoke-test-password' });
const dir = obsConfigDir({ server_enabled: true, server_port: fake.port, auth_required: true, server_password: 'smoke-test-password' });
const live = await session('session with the fake OBS', testEnv(dir, fake.port));
check((await call(live, 'obs_status')).connected === true, 'obs_status connects to the fake OBS with the password from the settings file');
check((await call(live, 'obs_find', { query: 'list of scenes', limit: 2 }))[0].request === 'GetSceneList', 'obs_find finds GetSceneList');
check((await call(live, 'obs_read', { request: 'GetVersion' })).data.obsVersion === '33.0.1', 'obs_read runs GetVersion');
check(/not sent/.test((await call(live, 'obs_read', { request: 'StopRecord' })).refused), 'obs_read refuses StopRecord');
check(/no cleared row/.test((await call(live, 'obs_read', { request: 'GetInputPropertiesListPropertyItems', params: { inputName: 'App audio', propertyName: 'application' } })).refused), 'obs_read refuses an uncleared list row');
await live.done();
await fake.close();
check(!fake.log.includes('StopRecord') && !fake.log.includes('GetInputPropertiesListPropertyItems'), `the fake OBS got only: ${[...new Set(fake.log)].join(', ')}`);

// 3. Doctor from the tarball, with OBS closed.
let doctor;
try {
  doctor = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', '--package', tarball, 'obs-mcp', 'doctor'], { cwd: packDir, env: testEnv(obsConfigDir(null), await closedPort()), encoding: 'utf8', shell: process.platform === 'win32' });
} catch (e) {
  doctor = e.stdout;
}
note('npx doctor with OBS closed', { output: doctor.split('\n') });
check(/connection +FAIL +No answer from OBS/.test(doctor), 'doctor reports that OBS does not answer');

if (out) writeFileSync(out, JSON.stringify(transcript, null, 1));
console.log(transcript.filter((t) => t.step === 'check').map((t) => `ok  ${t.what}`).join('\n'));
