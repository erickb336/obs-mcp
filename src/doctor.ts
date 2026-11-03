// obs-mcp doctor: reads and instructs. It never changes OBS, its files or its settings.
import { fileURLToPath } from 'node:url';
import { connectionTarget, listenerCheck, Obs, ObsError, SETTINGS_FILE_FIX } from './obs.js';
import { crashSentinels, findObs, listeners, obsConfigDir, versionFromLog } from './platform.js';

type Line = { check: string; result: 'pass' | 'FAIL' | 'warn' | 'info' | 'skip'; text: string; next?: string };

/** The OBS install line. With no install found, it is a warning when OBS answered anyway (for example a custom install). */
export function obsCheck(app: { path: string } | null, version: string | undefined, connected: boolean): Line {
  if (app) return { check: 'obs', result: 'pass', text: `OBS found at ${app.path}${version ? `, version ${version}` : ', version unknown'}` };
  return connected
    ? { check: 'obs', result: 'warn', text: 'No OBS install is found in the usual places, but OBS answers on its port. A custom install is fine.' }
    : { check: 'obs', result: 'FAIL', text: 'OBS Studio is not found.', next: 'Install OBS Studio from https://obsproject.com.' };
}

export async function doctor(): Promise<Line[]> {
  const lines: Line[] = [];
  const add = (l: Line) => lines.push(l);
  const major = Number(process.versions.node.split('.')[0]);
  add({ check: 'node', result: major >= 22 ? 'pass' : 'FAIL', text: `Node ${process.versions.node}`, next: major >= 22 ? undefined : 'Install Node 22 or newer.' });

  const dir = obsConfigDir();
  const app = findObs();
  // The OBS line comes second, but its result waits for the connection check.
  const obsLine = lines.push(obsCheck(app, undefined, false)) - 1;

  const t = connectionTarget(dir);
  const s = t.settings;
  if (!s.found) add({ check: 'server', result: 'warn', text: `No obs-websocket settings file at ${s.file}. OBS has not run with obs-websocket 5, or it uses another settings folder.`, next: 'Open OBS once. For a portable install, set OBS_STUDIO_CONFIG_DIR to its settings folder.' });
  else if (s.error) add({ check: 'server', result: 'FAIL', text: s.error, next: SETTINGS_FILE_FIX });
  else if (!s.enabled) add({ check: 'server', result: 'FAIL', text: 'The OBS WebSocket server is off.', next: 'In OBS: Tools, WebSocket Server Settings, Enable WebSocket server. Read the listener line first.' });
  else add({ check: 'server', result: 'pass', text: `The OBS WebSocket server is on, port ${t.port}, password ${s.authRequired ? 'required' : 'NOT required'}.` });
  if (s.found && s.enabled && !s.authRequired) add({ check: 'password', result: 'FAIL', text: 'Authentication is off, so anyone who can reach the port can control OBS.', next: 'In OBS: Tools, WebSocket Server Settings, Enable Authentication.' });
  add({ check: 'password', result: 'info', text: `Password source: ${t.passwordFrom}. The value is never shown.` });
  if (t.portError) add({ check: 'port', result: 'FAIL', text: t.portError });

  let connected = false;
  if (t.portError) {
    add({ check: 'connection', result: 'skip', text: 'Needs a valid OBS_WEBSOCKET_PORT.' });
  } else if (s.found && !s.error && !s.enabled && process.env.OBS_WEBSOCKET_PORT === undefined) {
    add({ check: 'connection', result: 'skip', text: 'Needs the WebSocket server.' });
  } else {
    const obs = new Obs(() => t);
    try {
      const v = await obs.connect();
      connected = true;
      add({ check: 'connection', result: 'pass', text: `Connected to OBS ${v.obsVersion}, obs-websocket ${v.obsWebSocketVersion}, at ${t.url}. Authentication passed.` });
    } catch (e) {
      if (!(e instanceof ObsError)) throw e;
      add({ check: 'connection', result: 'FAIL', text: e.message, next: e.next });
    } finally {
      await obs.close();
    }
  }
  lines[obsLine] = obsCheck(app, app?.version ?? versionFromLog(dir), connected);
  if (!t.portError) add({ check: 'listener', ...listenerCheck(t.port, listeners(t.port), connected) });

  const sentinels = crashSentinels(dir);
  if (sentinels.length)
    add({ check: 'crash', result: 'warn', text: `OBS left ${sentinels.length} run file(s) in its .sentinel folder: an earlier session did not close normally, or OBS runs now. The next OBS start may ask about Safe Mode. Doctor never deletes these files.`, next: 'Answer the dialog in OBS.' });

  // The package is not on npm yet, so the lines run this copy of obs-mcp by its path.
  const cli = JSON.stringify(fileURLToPath(new URL('./cli.js', import.meta.url)));
  add({
    check: 'client',
    result: 'info',
    text: [
      'Add the server to your MCP client (each line writes nothing until you run it). The lines run this copy of obs-mcp:',
      `  Claude Code: claude mcp add --transport stdio obs -- node ${cli}`,
      `  Codex:       codex mcp add obs -- node ${cli}`,
      `  JSON config: {"mcpServers":{"obs":{"command":"node","args":[${cli}]}}}`,
    ].join('\n'),
  });
  return lines;
}

export function printDoctor(lines: Line[]): number {
  console.log('obs-mcp doctor');
  for (const l of lines) {
    console.log(`  ${l.check.padEnd(11)} ${l.result.padEnd(5)} ${l.text.replaceAll('\n', `\n${''.padEnd(20)}`)}`);
    if (l.next) console.log(`  ${''.padEnd(11)} next: ${l.next}`);
  }
  const problems = lines.filter((l) => l.result === 'FAIL').length;
  console.log(`\n${problems ? `${problems} problem(s). Fix them, then run doctor again.` : 'No problems found.'} Doctor changed nothing.`);
  return problems ? 1 : 0;
}
