// obs-mcp doctor: reads and instructs. It never changes OBS, its files or its settings.
import { connectionTarget, listenerWords, Obs, ObsError } from './obs.js';
import { crashSentinels, findObs, listenAddresses, obsConfigDir, versionFromLog } from './platform.js';

type Line = { check: string; result: 'pass' | 'FAIL' | 'warn' | 'info' | 'skip'; text: string; next?: string };

export async function doctor(): Promise<Line[]> {
  const lines: Line[] = [];
  const add = (l: Line) => lines.push(l);
  const major = Number(process.versions.node.split('.')[0]);
  add({ check: 'node', result: major >= 22 ? 'pass' : 'FAIL', text: `Node ${process.versions.node}`, next: major >= 22 ? undefined : 'Install Node 22 or newer.' });

  const dir = obsConfigDir();
  const app = findObs();
  const version = app?.version ?? versionFromLog(dir);
  add(
    app
      ? { check: 'obs', result: 'pass', text: `OBS found at ${app.path}${version ? `, version ${version}` : ', version unknown'}` }
      : { check: 'obs', result: 'FAIL', text: 'OBS Studio is not found.', next: 'Install OBS Studio from https://obsproject.com.' },
  );

  const t = connectionTarget(dir);
  const s = t.settings;
  if (!s.found) add({ check: 'server', result: 'warn', text: `No obs-websocket settings file at ${s.file}. OBS has not run with obs-websocket 5, or it uses another settings folder.`, next: 'Open OBS once. For a portable install, set OBS_STUDIO_CONFIG_DIR to its settings folder.' });
  else if (s.error) add({ check: 'server', result: 'FAIL', text: `The obs-websocket settings file ${s.error}.` });
  else if (!s.enabled) add({ check: 'server', result: 'FAIL', text: 'The OBS WebSocket server is off.', next: 'In OBS: Tools, WebSocket Server Settings, Enable WebSocket server. Read the listener line first.' });
  else add({ check: 'server', result: 'pass', text: `The OBS WebSocket server is on, port ${t.port}, password ${s.authRequired ? 'required' : 'NOT required'}.` });
  if (s.found && s.enabled && !s.authRequired) add({ check: 'password', result: 'FAIL', text: 'Authentication is off, so anyone who can reach the port can control OBS.', next: 'In OBS: Tools, WebSocket Server Settings, Enable Authentication.' });
  add({ check: 'password', result: 'info', text: `Password source: ${t.passwordFrom}. The value is never shown.` });

  add({ check: 'listener', result: 'info', text: `${listenerWords(t.port, listenAddresses(t.port))} When the server is on, OBS listens on all network interfaces.` });

  if (s.found && !s.error && !s.enabled && !process.env.OBS_WEBSOCKET_PORT) {
    add({ check: 'connection', result: 'skip', text: 'Needs the WebSocket server.' });
  } else {
    const obs = new Obs(() => t);
    try {
      const v = await obs.connect();
      add({ check: 'connection', result: 'pass', text: `Connected to OBS ${v.obsVersion}, obs-websocket ${v.obsWebSocketVersion}, at ${t.url}. Authentication passed.` });
    } catch (e) {
      if (!(e instanceof ObsError)) throw e;
      add({ check: 'connection', result: 'FAIL', text: e.message, next: 'Open OBS and turn on its WebSocket server, then run doctor again.' });
    } finally {
      await obs.close();
    }
  }

  const sentinels = crashSentinels(dir);
  if (sentinels.length)
    add({ check: 'crash', result: 'warn', text: `OBS left ${sentinels.length} run file(s) in its .sentinel folder: an earlier session did not close normally, or OBS runs now. The next OBS start may ask about Safe Mode. Doctor never deletes these files.`, next: 'Answer the dialog in OBS.' });

  add({
    check: 'client',
    result: 'info',
    text: [
      'Add the server to your MCP client (each line writes nothing until you run it):',
      '  Claude Code: claude mcp add --transport stdio obs -- npx -y @erickb336/obs-mcp',
      '  Codex:       codex mcp add obs -- npx -y @erickb336/obs-mcp',
      '  JSON config: {"mcpServers":{"obs":{"command":"npx","args":["-y","@erickb336/obs-mcp"]}}}',
      '  The package is not yet published to npm.',
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
