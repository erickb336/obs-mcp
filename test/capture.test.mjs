// The capture script, against the fake OBS only. SIMULATED: no real OBS.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OBSWebSocket } from 'obs-websocket-js/json';
import { findLeaks } from '../scripts/trace-scrub.mjs';
import { loadTraces, startFakeObs } from './fake-obs.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/capture-traces.mjs', import.meta.url));
const PASSWORD = 'capture-test-password-W3q8';

const STOP_PROMPT = 'type stop and press Enter';
/**
 * Runs the capture. answer is what the operator types at each stop prompt: a string, an async function that gives it, or
 * null for an open input with no answer. With no answer, the input is empty, as when no one is at the terminal. early is
 * text that the operator types at once, before any prompt: a line ends with a newline.
 */
function run(args, env = {}, answer, early) {
  return new Promise((resolve) => {
    const base = { ...process.env, ...env };
    if (!('OBS_WEBSOCKET_PASSWORD' in env)) delete base.OBS_WEBSOCKET_PASSWORD;
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: base, stdio: [answer === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (early !== undefined) p.stdin.write(early);
    let stderr = '';
    let prompts = 0;
    p.stderr.on('data', (d) => {
      stderr += d;
      const seen = stderr.split(STOP_PROMPT).length - 1;
      for (; prompts < seen; prompts++) if (answer) Promise.resolve(typeof answer === 'function' ? answer() : answer).then((a) => a !== null && p.stdin.write(`${a}\n`));
    });
    p.on('close', (code) => resolve({ code, stderr }));
  });
}
const files = () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-mcp-capture-'));
  return { plan: join(dir, 'plan.json'), out: join(dir, 'trace.json') };
};

const PLAN = [
  { requestType: 'GetStats' },
  { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'App audio', propertyName: 'application' } },
  { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'App audio', propertyName: 'Application' } },
  { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'Display', propertyName: 'display_uuid' } },
  { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'Display', propertyName: 'type' } },
  { requestType: 'StartStream' },
  { requestType: 'ToggleOutput', requestData: { outputName: 'adv_file_output' } },
  // F-T6-1: requests that R41 refuses for a crash (obs-studio #14105) or for plugin code.
  { requestType: 'OpenInputPropertiesDialog', requestData: { inputName: 'Display' } },
  { requestType: 'PressInputPropertiesButton', requestData: { inputName: 'Display', propertyName: 'reactivate_capture' } },
  { requestType: 'CallVendorRequest', requestData: { vendorName: 'x', requestType: 'stop' } },
  { requestType: 'SetOutputSettings', requestData: { outputName: 'adv_file_output', outputSettings: {} } },
  { requestType: 'GetProfileParameter', requestData: { parameterCategory: 'Twitch', parameterName: 'RefreshToken' } },
  { requestType: 'StartRecord' },
  { requestType: 'StopRecord' },
  { requestType: 'GetStreamServiceSettings' },
];
const GUARD_READS = ['GetRecordStatus', 'GetStreamStatus', 'GetOutputList', 'GetInputList'];
const NO_ROW = (kind, property) => `no cleared row for (macos, OBS 33.0.1, ${kind}, ${property}). A list request can crash OBS, so only rows tested on real OBS run.`;
const NOT_A_READ = (cls) => `it is in the class ${cls}. The capture sends what obs_read runs, and a record start or stop with --allow-record.`;

test('the capture sends only what obs_read runs, with its guards, and writes a scrubbed trace', async () => {
  const fake = await startFakeObs({ password: PASSWORD, streamKey: 'live_123456789_captureKey' });
  const f = files();
  writeFileSync(f.plan, JSON.stringify(PLAN));
  const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0'], { OBS_WEBSOCKET_PASSWORD: PASSWORD });
  await fake.close();
  assert.equal(r.code, 0, r.stderr);
  // Before each list request, the server's guard reads the outputs and the inputs (F-T6-9).
  assert.deepEqual(fake.log, ['GetVersion', 'GetStreamStatus', 'GetRecordStatus', 'GetStats', ...GUARD_READS, ...GUARD_READS, ...GUARD_READS, ...GUARD_READS, 'GetInputPropertiesListPropertyItems', 'GetStreamServiceSettings']);
  assert.deepEqual(fake.sent.find((s) => s.requestType === 'GetInputPropertiesListPropertyItems').requestData, { inputUuid: 'uuid-Display', propertyName: 'type' });
  assert.equal(fake.crashes(), 0);
  const text = readFileSync(f.out, 'utf8');
  const trace = JSON.parse(text);
  assert.equal(trace.source, 'captured');
  assert.deepEqual(trace.refused.map((x) => `${x.requestType}: ${x.refused}`), [
    `GetInputPropertiesListPropertyItems: ${NO_ROW('sck_audio_capture', 'application')}`,
    `GetInputPropertiesListPropertyItems: ${NO_ROW('sck_audio_capture', 'Application')}`,
    `GetInputPropertiesListPropertyItems: ${NO_ROW('screen_capture', 'display_uuid')}`,
    `StartStream: ${NOT_A_READ('guarded')}`,
    `ToggleOutput: ${NOT_A_READ('guarded')}`,
    `OpenInputPropertiesDialog: ${NOT_A_READ('change')}`,
    `PressInputPropertiesButton: ${NOT_A_READ('change')}`,
    `CallVendorRequest: ${NOT_A_READ('guarded')}`,
    `SetOutputSettings: ${NOT_A_READ('change')}`,
    'GetProfileParameter: it is not on the list of safe profile parameters, because a profile can hold tokens and stream keys.',
    'StartRecord: it starts or stops a recording; give --allow-record to send it.',
    'StopRecord: it starts or stops a recording; give --allow-record to send it.',
  ]);
  // The fake's stream settings hold a server URL with a key, a user name and the password: the scrub took them out.
  // The keys of settings are hidden too (F-T6-16): server, protocol, key, use_auth, username, password.
  assert.deepEqual(trace.entries.find((e) => e.requestType === 'GetStreamServiceSettings').responseData.streamServiceSettings, {
    hidden_key_1: '[scrubbed]', hidden_key_2: '[scrubbed]', hidden_key_3: '[scrubbed]', hidden_key_4: true, hidden_key_5: '[scrubbed]', hidden_key_6: '[scrubbed]',
  });
  for (const secret of [PASSWORD, 'live_123456789_captureKey', 'someone']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(findLeaks(trace), []);
  assert.match(r.stderr, /6 requests recorded, 12 refused, written to .* after the scrub\./);
  assert.equal(r.stderr.includes(PASSWORD), false);

  // The fake OBS replays the captured trace: the captured GetStats reply comes back.
  const replay = await startFakeObs({ traces: [trace] });
  const obs = new OBSWebSocket();
  await obs.connect(`ws://127.0.0.1:${replay.port}`);
  assert.deepEqual(await obs.call('GetStats'), trace.entries.find((e) => e.requestType === 'GetStats').responseData);
  await obs.disconnect();
  await replay.close();
});

test('with --allow-record, the capture records a take with its events and its effect on the record state', async () => {
  const fake = await startFakeObs();
  const f = files();
  writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'GetRecordStatus' }, { requestType: 'StopRecord' }]));
  const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--allow-record'], {}, 'stop');
  await fake.close();
  assert.equal(r.code, 0, r.stderr);
  const take = JSON.parse(readFileSync(f.out, 'utf8')).entries.slice(3);
  assert.deepEqual(take.map((e) => [e.requestType, e.when.recording, e.events?.map((ev) => ev.eventData.outputState.replace('OBS_WEBSOCKET_OUTPUT_', '')), e.effect]), [
    ['StartRecord', false, ['STARTING', 'STARTED'], { recording: true }],
    ['GetRecordStatus', true, undefined, undefined],
    ['StopRecord', true, ['STOPPING', 'STOPPED'], { recording: false }],
  ]);
  // The stored real trace (real-record.json) has STOPPED 235 ms after StopRecord.
  assert.ok(take[2].events[1].delayMs >= 235, `STOPPED after ${take[2].events[1].delayMs} ms`);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
});

test('F-T6-1: during a take that --allow-record started, the capture still refuses each request that obs_read refuses, and a list request', async () => {
  const fake = await startFakeObs();
  const f = files();
  writeFileSync(f.plan, JSON.stringify([
    { requestType: 'StartRecord' },
    { requestType: 'OpenInputPropertiesDialog', requestData: { inputName: 'Display' } },
    { requestType: 'CallVendorRequest', requestData: { vendorName: 'x', requestType: 'stop' } },
    { requestType: 'TriggerHotkeyByName', requestData: { hotkeyName: 'OBSBasic.StopRecording' } },
    { requestType: 'GetInputPropertiesListPropertyItems', requestData: { inputName: 'Display', propertyName: 'type' } },
    { requestType: 'StopRecord' },
  ]));
  const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--allow-record'], {}, 'stop');
  await fake.close();
  assert.equal(r.code, 0, r.stderr);
  // Before its own StartRecord (twice), and before and after the stop prompt, the capture reads GetRecordStatus again (F-T6-19, F-T25-1).
  assert.deepEqual(fake.log, ['GetVersion', 'GetStreamStatus', 'GetRecordStatus', 'GetRecordStatus', 'GetRecordStatus', 'StartRecord', ...GUARD_READS, 'GetRecordStatus', 'GetRecordStatus', 'StopRecord']);
  assert.deepEqual(JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`), [
    `OpenInputPropertiesDialog: ${NOT_A_READ('change')}`,
    `CallVendorRequest: ${NOT_A_READ('guarded')}`,
    `TriggerHotkeyByName: ${NOT_A_READ('guarded')}`,
    'GetInputPropertiesListPropertyItems: a recording is active, and a list request can crash OBS.',
  ]);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
  assert.equal(fake.crashes(), 0);
});

// F-T6-19: a take that the user starts is never stopped by the capture, whenever the user starts it. The user is a
// second client of the fake OBS. Each plan asks for every record request; ToggleRecord is never sent.
const until = async (ok) => {
  const deadline = Date.now() + 10000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('the fake OBS did not reach the state in 10 s');
    await new Promise((r) => setTimeout(r, 5));
  }
};
/** A fake OBS with a second client, the user. Both close after the test, also when it fails. */
const userAndFake = async (t) => {
  const fake = await startFakeObs();
  const user = new OBSWebSocket();
  await user.connect(`ws://127.0.0.1:${fake.port}`);
  t.after(async () => {
    await user.disconnect();
    await fake.close();
  });
  return { fake, user };
};
const NOT_OWN = 'the active recording is not a take that the capture started, or that is not certain: the capture stops only its own take.';
const NOT_IDLE = 'a recording is active, or its state is not known: the capture starts a take only when no recording is active.';
const NO_ANSWER = 'the operator did not type stop at the prompt: the capture stops its own take only when the operator asks. The take is still running: stop it in OBS.';
const TAKE_PLAN = [{ requestType: 'GetStats' }, { requestType: 'GetStats' }, { requestType: 'StopRecord' }, { requestType: 'ToggleRecord' }, { requestType: 'StartRecord' }, { requestType: 'StopRecord' }];
for (const [moment, ready] of [
  // The R154 reproduction: the user starts a take just after the capture's first GetRecordStatus has its reply.
  ['just after the first record status read', (log) => log.includes('GetRecordStatus')],
  ['between two plan steps', (log) => log.includes('GetStats')],
  ['while the capture checks a StopRecord', (log) => log.filter((x) => x === 'GetRecordStatus').length >= 2],
  ['while the capture checks a StartRecord', (log) => log.filter((x) => x === 'GetRecordStatus').length >= 3],
]) {
  test(`F-T6-19: a user take started ${moment} is never stopped, and ToggleRecord is never sent`, async (t) => {
    const { fake, user } = await userAndFake(t);
    const f = files();
    writeFileSync(f.plan, JSON.stringify(TAKE_PLAN));
    const capture = run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '400', '--allow-record']);
    await until(() => ready(fake.log));
    await user.call('StartRecord');
    const r = await capture;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.state.recording, true);
    assert.deepEqual(fake.stops, []);
    assert.equal(fake.log.includes('ToggleRecord'), false);
    // The user's StartRecord is the only one that OBS got.
    assert.equal(fake.log.filter((x) => x === 'StartRecord').length, 1);
    const refused = JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`);
    assert.deepEqual(refused.filter((x) => !x.startsWith('ToggleRecord')).slice(-2), [`StartRecord: ${NOT_IDLE}`, `StopRecord: ${NOT_OWN}`]);
    assert.deepEqual(refused.find((x) => x.startsWith('ToggleRecord')), `ToggleRecord: ${NOT_A_READ('guarded')}`);
  });
}

test('F-T6-19: when the user stops the capture\'s take and starts a new one, the capture does not stop the new take', async (t) => {
  const { fake, user } = await userAndFake(t);
  const f = files();
  writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'GetStats' }, { requestType: 'StopRecord' }]));
  const capture = run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '1500', '--allow-record']);
  await until(() => fake.log.includes('GetStats'));
  await user.call('StopRecord');
  await until(() => !fake.state.recording);
  await user.call('StartRecord');
  await until(() => fake.state.recording);
  const r = await capture;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.recording, true);
  // The one stop is the user's own stop of the capture's take.
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
  assert.equal(fake.log.filter((x) => x === 'StopRecord').length, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`), [`StopRecord: ${NOT_OWN}`]);
});

// F-T25-1: OBS can answer a user's start, sent a few ms after the capture's StartRecord, with an ok reply and no events of
// its own, so the one STARTED event is the capture's and the user's take at once. In this simulated trace the user's
// StartRecord carries a marker field, so that only it gets that reply.
const LENIENT = { format: 'obs-mcp-trace/1', source: 'simulated', basis: 'SIMULATED: a lenient OBS that merges a second start into the take that is STARTING.', entries: [
  { requestType: 'StartRecord', requestData: { user: true }, when: { recording: false }, status: { result: true, code: 100 } },
] };
test('F-T25-1: when OBS merges a user start into the capture\'s take, the capture never sends StopRecord without the operator\'s answer', async (t) => {
  const fake = await startFakeObs({ traces: [LENIENT, ...loadTraces()] });
  const user = new OBSWebSocket();
  await user.connect(`ws://127.0.0.1:${fake.port}`);
  t.after(async () => {
    await user.disconnect();
    await fake.close();
  });
  const f = files();
  writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'GetStats' }, { requestType: 'StopRecord' }]));
  const capture = run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--allow-record']);
  await until(() => fake.log.includes('StartRecord'));
  await new Promise((r) => setTimeout(r, 20));
  // The call throws on a failed status: OBS gave the user's start an ok reply.
  await user.call('StartRecord', { user: true });
  const r = await capture;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.recording, true);
  assert.deepEqual(fake.stops, []);
  assert.equal(fake.log.includes('StopRecord'), false);
  assert.deepEqual(JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`), [`StopRecord: ${NO_ANSWER}`]);
});

// F-T25-1: the capture sends StopRecord only when the operator types stop. An open input with no answer for
// --confirm-ms, another answer, or a stop typed after the operator stopped the take and started a new one, sends none.
for (const [name, answer, act] of [
  ['the operator gives no answer in --confirm-ms', null],
  ['the operator types another answer', 'no'],
  ['the operator stops the take in OBS, starts a new one, then types stop', 'stop', async (user, fake) => {
    await user.call('StopRecord');
    await until(() => !fake.state.recording);
    await user.call('StartRecord');
    await until(() => fake.state.recording);
  }],
]) {
  test(`F-T25-1: when ${name}, the capture sends no StopRecord and the take keeps running`, async (t) => {
    const { fake, user } = await userAndFake(t);
    const f = files();
    writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'StopRecord' }]));
    const reply = act ? async () => (await act(user, fake), answer) : answer;
    // With no answer, the prompt waits 0.5 s. The operator's own stop and start take about 0.5 s, so the others wait 5 s.
    const confirmMs = answer === null ? '500' : '5000';
    const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--confirm-ms', confirmMs, '--allow-record'], {}, reply);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.state.recording, true);
    assert.ok(r.stderr.includes(`type stop and press Enter to send StopRecord. Waiting ${confirmMs / 1000} s.`), r.stderr);
    // The one StopRecord, if any, is the user's own.
    assert.equal(fake.log.filter((x) => x === 'StopRecord').length, act ? 1 : 0);
    assert.deepEqual(JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`), [`StopRecord: ${act ? NOT_OWN : NO_ANSWER}`]);
  });
}

// F-T25-2: only a line typed after the prompt shows answers it. A stop typed while no prompt shows is dropped: a late stop
// after a prompt timed out, or a stop typed before the first prompt. Each plan has two prompts for the capture's own take.
const LATE = 'the operator types stop after the first prompt timed out, and gives no answer at the second';
for (const [name, answer, early] of [
  [LATE, (() => {
    let prompt = 0;
    return async () => (++prompt === 1 ? (await new Promise((r) => setTimeout(r, 700)), 'stop') : null);
  })()],
  ['the operator types stop before the first prompt, and gives no answer at the prompts', null, 'stop\n'],
]) {
  test(`F-T25-2: when ${name}, the capture sends no StopRecord`, async (t) => {
    const { fake } = await userAndFake(t);
    const f = files();
    // The GetStats between the prompts waits 1.5 s, so the late stop comes while no prompt shows.
    writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'StopRecord' }, { requestType: 'GetStats' }, { requestType: 'StopRecord' }]));
    const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '1500', '--confirm-ms', '300', '--allow-record'], {}, answer, early);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr.split(STOP_PROMPT).length - 1, 2, r.stderr);
    assert.equal(fake.state.recording, true);
    assert.deepEqual(fake.stops, []);
    assert.equal(fake.log.includes('StopRecord'), false);
    assert.deepEqual(JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`), [`StopRecord: ${NO_ANSWER}`, `StopRecord: ${NO_ANSWER}`]);
  });
}

test('F-T25-2: a stop typed after the second prompt shows still stops the take, after a late line between the prompts', async (t) => {
  const { fake } = await userAndFake(t);
  const f = files();
  writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'StopRecord' }, { requestType: 'GetStats' }, { requestType: 'StopRecord' }]));
  let prompt = 0;
  // A stop typed before the first prompt is dropped, the first prompt times out and gets a late "no", and the second gets stop.
  const answer = async () => (++prompt === 1 ? (await new Promise((r) => setTimeout(r, 700)), 'no') : 'stop');
  const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '1500', '--confirm-ms', '5000', '--allow-record'], {}, answer, 'stop\n');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.recording, false);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
});

// F-T25-6, piped input only (not a terminal): the part of a line that came before the prompt is dropped. "st" with no
// newline, then "op" after the prompt, is the line "op", not "stop". On a terminal the rule differs: see the pty tests.
test('F-T25-6: on piped input, a part of a line that came before the prompt does not join the answer after it', async (t) => {
  const { fake } = await userAndFake(t);
  const f = files();
  writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'StopRecord' }]));
  const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--confirm-ms', '5000', '--allow-record'], {}, 'op', 'st');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.recording, true);
  assert.deepEqual(fake.stops, []);
  assert.deepEqual(JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`), [`StopRecord: ${NO_ANSWER}`]);
});

// F-T25-5: the hidden password prompt pauses the input when it ends. The stop prompt must still get the operator's line.
test('F-T25-5: when the input is paused before the capture reads it, a stop typed at the prompt still stops the take', async (t) => {
  const { fake } = await userAndFake(t);
  const f = files();
  writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'StopRecord' }]));
  // The preload pauses the input, as the end of the password prompt does.
  const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--confirm-ms', '5000', '--allow-record'], { NODE_OPTIONS: '--import=data:text/javascript,process.stdin.pause()' }, 'stop');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.recording, false);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
});

// On a terminal: a pseudo-terminal from the Python standard library (pty) runs the capture, as an operator at a terminal.
// PTY_STEPS is a list of [cue, text]: the operator types text when cue shows in the output, or at once when cue is empty.
// A carriage return is Enter. The terminal is in its normal line mode: it gives a line to the script only at Enter.
const PTY_OPERATOR = `
import json, os, pty, select, sys, time
steps = json.loads(os.environ['PTY_STEPS'])
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
out, done, deadline = b'', 0, time.time() + 30
while time.time() < deadline:
    while done < len(steps) and steps[done][0].encode() in out:
        os.write(fd, steps[done][1].encode())
        done += 1
    if select.select([fd], [], [], 0.1)[0]:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out += data
else:
    os.kill(pid, 9)
sys.stdout.write(out.decode(errors='replace'))
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;
// The pty tests need Unix and Python 3.9 or later (os.waitstatus_to_exitcode). Exit code 3 means an older Python.
const python = process.platform === 'win32' ? undefined : spawnSync('python3', ['-c', 'import os, pty, sys; sys.exit(0 if hasattr(os, "waitstatus_to_exitcode") else 3)']);
const noPty = process.platform === 'win32' ? 'no pty on Windows: Python\'s pty module works only on Unix'
  : python.status === 3 ? 'python3 is older than 3.9: it has no os.waitstatus_to_exitcode'
  : python.status !== 0 ? 'python3 with its pty module is not on this machine' : false;
/** Runs the capture on a pseudo-terminal with the operator's steps. A fake OBS without a password needs no password step. */
async function runOnTerminal(t, steps, { password, confirmMs = '5000' } = {}) {
  const fake = await startFakeObs(password ? { password } : {});
  t.after(() => fake.close());
  const f = files();
  writeFileSync(f.plan, JSON.stringify([{ requestType: 'StartRecord' }, { requestType: 'StopRecord' }]));
  const env = { ...process.env, PTY_STEPS: JSON.stringify(steps) };
  delete env.OBS_WEBSOCKET_PASSWORD;
  const args = [SCRIPT, '--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--confirm-ms', confirmMs, '--allow-record'];
  const r = await new Promise((resolve) => {
    const p = spawn('python3', ['-c', PTY_OPERATOR, process.execPath, ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    p.stdout.on('data', (d) => (output += d));
    p.on('close', (code) => resolve({ code, output }));
  });
  assert.equal(r.code, 0, r.output);
  assert.equal(r.output.split(STOP_PROMPT).length - 1, 1, r.output);
  return { fake, output: r.output, refused: JSON.parse(readFileSync(f.out, 'utf8')).refused.map((x) => `${x.requestType}: ${x.refused}`) };
}

// F-T25-5 on a terminal: the operator types the password at the hidden prompt, then stop at the stop prompt.
test('F-T25-5: on a terminal, after the hidden password prompt, a stop typed at the stop prompt stops the take once', { skip: noPty }, async (t) => {
  const { fake, output } = await runOnTerminal(t, [['password:', `${PASSWORD}\r`], [STOP_PROMPT, 'stop\r']], { password: PASSWORD });
  assert.ok(output.includes('obs-websocket password: '), output);
  assert.equal(output.includes(PASSWORD), false);
  assert.equal(fake.state.recording, false);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
});

// F-T25-7: on a terminal, a complete line typed before the prompt is dropped, so a stop from before the prompt never stops a take.
test('F-T25-7: on a terminal, a complete stop line typed before the prompt sends no StopRecord', { skip: noPty }, async (t) => {
  const { fake, refused } = await runOnTerminal(t, [['', 'stop\r']], { confirmMs: '1000' });
  assert.equal(fake.state.recording, true);
  assert.deepEqual(fake.stops, []);
  assert.deepEqual(refused, [`StopRecord: ${NO_ANSWER}`]);
});

// F-T25-7: on a terminal, an unfinished line is completed by what the operator types after the prompt, and that line is
// the answer to the prompt that shows: "st" before the prompt, then "op" and Enter after it, is "stop".
test('F-T25-7: on a terminal, "st" typed before the prompt and "op" with Enter after it stops the take once', { skip: noPty }, async (t) => {
  const { fake, refused } = await runOnTerminal(t, [['', 'st'], [STOP_PROMPT, 'op\r']]);
  assert.equal(fake.state.recording, false);
  assert.deepEqual(fake.stops, [{ requestType: 'StopRecord', cause: 'request' }]);
  assert.deepEqual(refused, []);
});

// F-T6-4 and F-T6-9: a crash of OBS or a request with no reply ends the capture with the reason, and the partial trace is written.
for (const [name, options, reason] of [
  ['OBS closes the connection', { crashOn: 'GetSceneList' }, 'OBS closed the connection (1006) while GetSceneList was in flight.'],
  ['OBS gives no reply', { silentOn: ['GetSceneList'] }, 'OBS gave no reply to GetSceneList in 300 ms.'],
]) {
  test(`when ${name} during the capture, it stops with the reason and writes the scrubbed partial trace`, async () => {
    const fake = await startFakeObs(options);
    const f = files();
    writeFileSync(f.plan, JSON.stringify([{ requestType: 'GetStats' }, { requestType: 'GetSceneList' }, { requestType: 'GetVideoSettings' }]));
    const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--plan', f.plan, '--settle-ms', '0', '--timeout-ms', '300']);
    await fake.close();
    assert.equal(r.code, 5, r.stderr);
    assert.equal(r.stderr, `capture-traces: stopped: ${reason} The partial trace (4 requests) is written to ${f.out} after the scrub.\n`);
    const trace = JSON.parse(readFileSync(f.out, 'utf8'));
    assert.equal(trace.incomplete, `The capture stopped: ${reason}`);
    assert.deepEqual(trace.entries.map((e) => e.requestType), ['GetVersion', 'GetStreamStatus', 'GetRecordStatus', 'GetStats']);
    assert.deepEqual(findLeaks(trace), []);
  });
}

for (const [name, state] of [['a recording', { recording: true }], ['a stream', { streaming: true }]]) {
  test(`during ${name}, the capture sends nothing after the two status reads and writes no file`, async () => {
    const fake = await startFakeObs(state);
    const f = files();
    const r = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--settle-ms', '0', '--allow-record']);
    await fake.close();
    assert.equal(r.code, 3);
    assert.match(r.stderr, /a stream or a recording is active, or its state is not known\. The capture sends nothing during an output, and wrote no file\./);
    assert.deepEqual(fake.log, ['GetVersion', 'GetStreamStatus', 'GetRecordStatus']);
    assert.equal(existsSync(f.out), false);
    assert.deepEqual(fake.stops, []);
  });
}

test('a password argument, a stray argument or a non-loopback URL is refused before any connection, and not echoed', async () => {
  const fake = await startFakeObs();
  const f = files();
  const url = `ws://127.0.0.1:${fake.port}`;
  const runs = [
    await run(['--url', url, '--out', f.out, '--password', PASSWORD]),
    await run(['--url', url, '--out', f.out, PASSWORD]),
    await run(['--url', 'ws://192.0.2.10:4455', '--out', f.out]),
    await run(['--url', url, '--out', f.out, '--confirm-ms', '0']),
    // F-T25-4: setTimeout fires at once for a wait above 2147483647 ms.
    await run(['--url', url, '--out', f.out, '--confirm-ms', '2147483648']),
    await run(['--url', url, '--out', f.out, '--confirm-ms', 'Infinity']),
    await run(['--url', url, '--out', f.out, '--timeout-ms', '1e10']),
  ];
  await fake.close();
  assert.deepEqual(runs.map((r) => r.code), [2, 2, 2, 2, 2, 2, 2]);
  assert.match(runs[0].stderr, /never from an argument/);
  assert.match(runs[1].stderr, /unknown argument/);
  assert.match(runs[2].stderr, /loopback address/);
  const tooLong = (name) => `capture-traces: ${name} must be a number of milliseconds above 0 and at most 2147483647.\n`;
  assert.deepEqual(runs.slice(3).map((r) => r.stderr), [tooLong('--confirm-ms'), tooLong('--confirm-ms'), tooLong('--confirm-ms'), tooLong('--timeout-ms')]);
  assert.equal(runs.some((r) => r.stderr.includes(PASSWORD)), false);
  // The longest wait passes the check: the script goes on to read the plan.
  const ok = await run(['--url', url, '--out', f.out, '--confirm-ms', '2147483647', '--timeout-ms', '2147483647', '--plan', '/nonexistent/plan.json']);
  assert.equal(ok.code, 1);
  assert.doesNotMatch(ok.stderr, /-ms/);
  assert.equal(fake.connections(), 0);
});

test('F-T27-3: a --settle-ms that is not a whole number from 0 to 60000 is refused before any connection', async () => {
  const fake = await startFakeObs();
  const f = files();
  const runs = [];
  for (const ms of ['abc', '-5', '1e9', '60001', '2.5', '']) runs.push(await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, `--settle-ms=${ms}`]));
  const ok = await run(['--url', `ws://127.0.0.1:${fake.port}`, '--out', f.out, '--settle-ms', '60000', '--plan', '/nonexistent/plan.json']);
  await fake.close();
  assert.deepEqual(runs.map((r) => [r.code, r.stderr]), Array(6).fill([2, 'capture-traces: --settle-ms must be a whole number of milliseconds from 0 to 60000.\n']));
  // 60000 passes the check: the script goes on to read the plan.
  assert.equal(ok.code, 1);
  assert.doesNotMatch(ok.stderr, /settle-ms/);
  assert.equal(fake.connections(), 0);
});
