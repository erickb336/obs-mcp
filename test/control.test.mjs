// G32: exactly one obs-mcp process for each OBS endpoint controls recording. The lock is a TCP port of 127.0.0.1
// (control.ts). These tests run real processes: lock children, and real server processes (dist/cli.js over stdio) on
// one fake OBS and one journal folder. SIMULATED: no real OBS.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Control, lockPorts } from '../dist/control.js';
import { Journal } from '../dist/journal.js';
import { TEXT } from '../dist/take.js';
import { tracked } from './cleanup.mjs';
import { connect, obsConfigDir, testEnv } from './helpers.mjs';
import { recordRequests, tmp, until, world } from './take-app.mjs';

const accept = async () => ({ action: 'accept', content: {} });
const last = (text) => text.split('\n').at(-1);
const rows = (w) => {
  const j = new Journal(w.dir);
  return j.openTakes().flatMap((id) => j.read(id).filter((r) => r.t === 'state').map((r) => r.row));
};
/** Ends a process as a crash does: no end of input, no clean exit. */
const crash = async (s) => {
  const pid = s.pid();
  process.kill(pid, 'SIGKILL');
  assert.ok(await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000), 'the process is gone');
};
const endpoint = () => `ws://127.0.0.1:${1 + Math.floor(Math.random() * 65535)}/test-${process.pid}-${Math.random()}`;
/** The first line that a port sends, 'free' when nothing listens, or 'silent' when nothing comes in 1 s. */
const lineOn = (port, host = '127.0.0.1') =>
  new Promise((resolve) => {
    const s = net.connect({ host, port });
    let got = '';
    const end = (v) => (clearTimeout(timer), s.destroy(), resolve(v));
    const timer = setTimeout(() => end('silent'), 1000);
    s.setEncoding('utf8');
    s.on('data', (d) => (got += d).includes('\n') && end(got));
    s.on('error', (e) => end(e.code === 'ECONNREFUSED' ? 'free' : e.code));
  });
const listenOn = (port, onConnection) =>
  new Promise((resolve, reject) => {
    const server = net.createServer(onConnection).once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(tracked(() => new Promise((r) => server.close(r)))));
  });
/** A temporary folder holds no lock file: no socket, and no file with the lock name of round 4. */
const lockFiles = (dir) => readdirSync(dir).filter((f) => /\.sock$|^obs-mcp-[0-9a-f]{16}/.test(f));

const CHILD = fileURLToPath(new URL('./lock-child.mjs', import.meta.url));
/** n lock children of one endpoint take the lock at the same moment. Returns their answers. */
async function race(n, ep) {
  const kids = Array.from({ length: n }, () => spawn(process.execPath, [CHILD, ep], { stdio: ['pipe', 'pipe', 'inherit'] }));
  const kill = tracked(() => kids.forEach((k) => k.kill()));
  const lines = kids.map((k) => createInterface({ input: k.stdout })[Symbol.asyncIterator]());
  for (const l of lines) assert.equal((await l.next()).value, 'ready');
  for (const k of kids) k.stdin.write('go\n');
  const answers = await Promise.all(lines.map(async (l) => (await l.next()).value));
  await Promise.all(kids.map((k) => new Promise((r) => (k.once('exit', r), k.stdin.end()))));
  await kill();
  return answers;
}

for (const n of [2, 3, 8]) {
  test(`F-T7-63, F-T7-68, F-T7-71, F-T7-72: ${n} processes take the lock of one OBS at the same moment, 40 rounds: exactly one controls each time`, async () => {
    const ep = endpoint();
    const bad = [];
    for (let round = 1; round <= 40; round++) {
      const answers = await race(n, ep);
      if (answers.filter((a) => a === 'controls').length !== 1 || answers.filter((a) => a === 'reads').length !== n - 1) bad.push(`round ${round}: ${answers.join(',')}`);
    }
    assert.deepEqual(bad, []);
  });
}

test('F-T7-74: a program on the first lock port is passed, silent or with another line; a copy that comes when it goes still reads', async () => {
  const ep = endpoint();
  const { id, ports } = lockPorts(ep);
  const closeSilent = await listenOn(ports[0], () => {}); // takes the connection, sends nothing
  const a = new Control(() => ep);
  assert.equal(await a.acquire(), true, 'the next port of the sequence');
  assert.equal(await lineOn(ports[1]), `obs-mcp-control ${id} ${process.pid}\n`);
  const b = new Control(() => ep);
  assert.equal(await b.acquire(), false);
  assert.equal(b.error, undefined, 'another copy controls');
  // The program goes. A new copy takes the first port, sees the controller on the second, and lets its port go.
  await closeSilent();
  const c = new Control(() => ep);
  assert.equal(await c.acquire(), false);
  assert.equal(await lineOn(ports[0]), 'free');
  // A program that sends another line is passed too.
  a.close();
  const closeOther = await listenOn(ports[0], (s) => s.end('SSH-2.0-OpenSSH_9.9\n'));
  const d = new Control(() => ep);
  assert.equal(await d.acquire(), true);
  assert.match(await lineOn(ports[1]), new RegExp(`^obs-mcp-control ${id} \\d+\\n$`));
  d.close();
  await closeOther();
});

test('F-T7-70: a listen error other than EADDRINUSE makes a reader whose X16 says that it cannot confirm control', async () => {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function () {
    process.nextTick(() => this.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })));
    return this;
  };
  try {
    const c = new Control(endpoint);
    assert.equal(await c.acquire(), false);
    assert.equal(c.error, 'EACCES');
    assert.equal(
      TEXT.X16('start', c.error),
      'I did not send the start. I cannot confirm that this obs-mcp copy alone controls recording in this OBS (the controller lock gave EACCES), so this copy only reads. To start the recording, click Start Recording in the Controls dock of OBS.',
    );
  } finally {
    net.Server.prototype.listen = listen;
  }
});

test('F-T7-73: when the OBS endpoint changes, the lock of the old one goes and the lock of the new one is taken', async () => {
  const [e1, e2] = [endpoint(), endpoint()];
  let ep = e1;
  const c = new Control(() => ep);
  assert.equal(await c.acquire(), true);
  assert.match(await lineOn(lockPorts(e1).ports[0]), new RegExp(`^obs-mcp-control ${lockPorts(e1).id} `));
  ep = e2;
  assert.equal(c.holds(), false);
  assert.equal(await c.acquire(), true);
  assert.equal(await lineOn(lockPorts(e1).ports[0]), 'free');
  assert.match(await lineOn(lockPorts(e2).ports[0]), new RegExp(`^obs-mcp-control ${lockPorts(e2).id} `));
  c.close();
});

test('G32: the lock listens on 127.0.0.1 only: another address of this computer gets no connection', async (t) => {
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!lan) return t.skip('this computer has no other IPv4 address');
  const ep = endpoint();
  const c = new Control(() => ep);
  assert.equal(await c.acquire(), true);
  try {
    assert.notEqual((await lineOn(lockPorts(ep).ports[0], lan)).slice(0, 15), 'obs-mcp-control');
  } finally {
    c.close();
  }
});

test('F-T7-69: two clients whose environments differ in TMPDIR and XDG_RUNTIME_DIR get one controller, and no lock file', async () => {
  const w = await world();
  const base = testEnv(obsConfigDir(null), w.fake.port, { OBS_MCP_STATE_DIR: w.dir, OBS_MCP_RECORDING_DIR: w.rec });
  const dirs = [tmp('ta'), tmp('tb'), tmp('xdg')];
  const envs = [{ ...base, TMPDIR: dirs[0], XDG_RUNTIME_DIR: dirs[2] }, { ...base, TMPDIR: dirs[1], XDG_RUNTIME_DIR: '' }];
  const cs = await Promise.all(envs.map((e) => connect(e, { elicit: accept })));
  try {
    const replies = await Promise.all(cs.map((c, i) => c.call('obs_record_start', { token: `env-token-${i}-xyz` })));
    const kinds = replies.map((r) => (r.text === TEXT.X16('start') ? 'X16' : /^Recording for /.test(last(r.text)) ? 'recording' : r.text)).sort();
    assert.deepEqual(kinds, ['X16', 'recording']);
    assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
    for (const d of dirs) assert.deepEqual(lockFiles(d), [], d);
  } finally {
    for (const c of cs) await c.close().catch(() => {});
    await w.fake.close();
  }
});

test('F-T7-73: a server whose OBS port changes in the settings file while it runs takes the lock of the new port, and frees the old one', async () => {
  const [w1, w2] = [await world(), await world()];
  const dir = obsConfigDir({ server_port: w1.fake.port });
  const settings = (port) => writeFileSync(join(dir, 'plugin_config', 'obs-websocket', 'config.json'), JSON.stringify({ server_port: port }));
  const extra = (w) => ({ OBS_MCP_STATE_DIR: w.dir, OBS_MCP_RECORDING_DIR: w.rec });
  const a = await connect(testEnv(dir, null, extra(w1)), { elicit: accept });
  let b;
  let c;
  try {
    await a.call('obs_status');
    settings(w2.fake.port);
    await a.call('obs_status'); // the next tool call takes the lock of the new port
    b = await connect(testEnv(obsConfigDir(null), w2.fake.port, extra(w2)), { elicit: accept });
    assert.equal((await b.call('obs_record_start', { token: 'moved-token-b' })).text, TEXT.X16('start'));
    c = await connect(testEnv(obsConfigDir(null), w1.fake.port, extra(w1)), { elicit: accept });
    assert.match(last((await c.call('obs_record_start', { token: 'moved-token-c' })).text), /^Recording for /, 'the old port is free');
  } finally {
    for (const x of [a, b, c]) await x?.close().catch(() => {});
    await w1.fake.close();
    await w2.fake.close();
  }
});

test('F-T7-63, F-T7-68, G32: two real server processes on one OBS: one controller; the reader refuses start and stop; after the controller crashes, the reader controls and runs the restart rows', async () => {
  for (let round = 1; round <= 3; round++) {
    const w = await world();
    const env = testEnv(obsConfigDir(null), w.fake.port, { OBS_MCP_STATE_DIR: w.dir, OBS_MCP_RECORDING_DIR: w.rec });
    const [a, b] = await Promise.all([connect(env, { elicit: accept }), connect(env, { era: 'modern', elicit: accept })]);
    try {
      // Both accept a start at the same moment: one StartRecord, and the other copy says why it sent nothing.
      const replies = await Promise.all([a.call('obs_record_start', { token: `two-token-a-${round}` }), b.call('obs_record_start', { token: `two-token-b-${round}` })]);
      assert.deepEqual(recordRequests(w.fake), ['StartRecord'], `round ${round}: ${replies.map((r) => r.text).join(' | ')}`);
      const texts = replies.map((r) => last(r.text));
      assert.deepEqual(texts.map((t) => (t === TEXT.X16('start') ? 'X16' : /^Recording for /.test(t) ? 'recording' : t)).sort(), ['X16', 'recording'], texts.join('\n'));
      const [ctl, reader] = texts[0] === TEXT.X16('start') ? [b, a] : [a, b];
      // The reader reads OBS and the take, and refuses every recording request before any prompt.
      assert.equal((await reader.call('obs_record_stop')).text, TEXT.X16('stop'));
      assert.equal((await reader.call('obs_record_start', { token: `again-token-${round}` })).text, TEXT.X16('start'));
      assert.match(last((await reader.call('obs_take_status')).text), /^Recording for /);
      assert.equal((await reader.call('obs_status')).json?.recording.active, true);
      assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
      if (round < 3) continue;
      // The controller crashes (SIGKILL). The OS frees its port; the reader's next tool call takes over.
      await crash(ctl);
      assert.equal(await lineOn(lockPorts(`ws://127.0.0.1:${w.fake.port}`).ports[0]), 'free');
      const after = (await reader.call('obs_take_status')).text;
      assert.match(after, /^OBS still records the take that I started \(00:00:0\d, file `[^`]+`\)\. I watch it again from \d\d:\d\d:\d\d\./, after);
      assert.match(last(after), /^Recording for /);
      assert.ok(rows(w).includes('R3'), 'the restart row is in the journal');
      // Now it controls: a stop with consent sends StopRecord once.
      assert.match(last((await reader.call('obs_record_stop')).text), /^The recording stopped at \d\d:\d\d:\d\d \(OBS confirmed it\)\./);
      assert.deepEqual(recordRequests(w.fake), ['StartRecord', 'StopRecord']);
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
      await w.fake.close();
    }
  }
});

test('F-T7-58, D4: a 2026-era client sends no initialized notice; the new process still runs the restart rows at its start, and obs_status gives the notice', async () => {
  const w = await world();
  const env = testEnv(obsConfigDir(null), w.fake.port, { OBS_MCP_STATE_DIR: w.dir, OBS_MCP_RECORDING_DIR: w.rec });
  const a = await connect(env, { elicit: accept });
  let b;
  try {
    assert.match((await a.call('obs_record_start', { token: 'modern-restart-1' })).text, /^Recording for /);
    await crash(a);
    b = await connect(env, { era: 'modern', elicit: accept });
    assert.ok(await until(() => rows(w).includes('R3'), 5000), 'R3 ran before any tool call');
    const r = await b.client.callTool({ name: 'obs_status', arguments: {} });
    assert.match(r.content[0].text, /^OBS still records the take that I started/, 'the notice comes first, before the status JSON');
    assert.equal(JSON.parse(r.content[1].text).recording.active, true);
    assert.deepEqual(recordRequests(w.fake), ['StartRecord']);
  } finally {
    await a.close().catch(() => {});
    await b?.close().catch(() => {});
    await w.fake.close();
  }
});
