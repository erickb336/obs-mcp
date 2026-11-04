// Test helpers: a temporary OBS settings folder and an MCP client over stdio. No test reaches a real OBS:
// each one sets OBS_STUDIO_CONFIG_DIR to a temporary folder and OBS_WEBSOCKET_PORT to a fake or closed port.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tracked } from './cleanup.mjs';

export const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** A temporary OBS settings folder. settings is the obs-websocket config.json content, or null for none. */
export function obsConfigDir(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'obs-mcp-test-'));
  if (settings) {
    mkdirSync(join(dir, 'plugin_config', 'obs-websocket'), { recursive: true });
    writeFileSync(join(dir, 'plugin_config', 'obs-websocket', 'config.json'), JSON.stringify(settings));
  }
  return dir;
}

/** A TCP port on which nothing listens. */
export async function closedPort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * port null leaves OBS_WEBSOCKET_PORT unset, so the port comes from the settings file. Each server gets a new
 * temporary take journal folder, so that no test writes to the journal of this machine.
 */
export function testEnv(dir, port, extra = {}) {
  const state = join(mkdtempSync(join(tmpdir(), 'obs-mcp-state-')), 'takes');
  const env = { ...process.env, OBS_STUDIO_CONFIG_DIR: dir, OBS_WEBSOCKET_PORT: String(port), OBS_MCP_STATE_DIR: state, ...extra };
  if (port === null && !('OBS_WEBSOCKET_PORT' in extra)) delete env.OBS_WEBSOCKET_PORT;
  if (!('OBS_WEBSOCKET_PASSWORD' in extra)) delete env.OBS_WEBSOCKET_PASSWORD;
  return env;
}

/**
 * Starts a server process and connects an SDK client. era: 'legacy' (2025 opening) or 'modern' (2026-07-28).
 * elicit: the client's answer to each confirm prompt; without it, the client declares no elicitation.
 */
export async function connect(env, { era = 'legacy', command = process.execPath, args = [CLI], elicit } = {}) {
  const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d) => (stderr += d));
  const options = { ...(era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}), ...(elicit ? { capabilities: { elicitation: { form: {} } } } : {}) };
  const client = new Client({ name: 'obs-mcp-test', version: '0.0.0' }, options);
  if (elicit) client.setRequestHandler('elicitation/create', elicit);
  await client.connect(transport);
  const replies = [];
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join('\n');
    replies.push(text);
    return { text, isError: !!r.isError, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
  };
  return { client, call, replies, stderr: () => stderr, pid: () => transport.pid, close: tracked(() => client.close()) };
}

export function runDoctor(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'doctor'], { env, timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

/** Sample params that satisfy the required fields of a catalogue entry, and the name of each name and UUID pair. */
export function sampleParams(entry) {
  const v = { String: 'sample', Number: 1, Boolean: true, Object: {}, Any: 'sample' };
  const names = new Set(entry.fields.map((f) => f.name));
  const needed = (f) => !f.name.includes('.') && (!f.optional || (f.name.endsWith('Name') && names.has(f.name.replace(/Name$/, 'Uuid'))));
  return Object.fromEntries(entry.fields.filter(needed).map((f) => [f.name, v[f.type]]));
}
