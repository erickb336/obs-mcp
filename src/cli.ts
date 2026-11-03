#!/usr/bin/env node
import { doctor, printDoctor } from './doctor.js';
import { startServer, VERSION } from './server.js';

const USAGE = [
  'Usage:',
  '  obs-mcp            start the MCP server on stdio',
  '  obs-mcp doctor     check OBS and its WebSocket server; changes nothing',
  '  obs-mcp --help     show this text',
  '  obs-mcp --version  show the version',
  '',
  'The OBS password comes from the obs-websocket settings file or OBS_WEBSOCKET_PASSWORD, never from an argument.',
  'Other settings: OBS_WEBSOCKET_PORT, OBS_STUDIO_CONFIG_DIR.',
].join('\n');

const args = process.argv.slice(2);
const only = (...names: string[]) => args.length === 1 && names.includes(args[0]);
if (!args.length) startServer();
else if (only('doctor')) process.exitCode = printDoctor(await doctor());
else if (only('--help', '-h')) console.log(USAGE);
else if (only('--version', '-v')) console.log(VERSION);
else {
  console.error(USAGE);
  process.exitCode = 2;
}
