#!/usr/bin/env node
import { doctor, printDoctor } from './doctor.js';
import { startServer } from './server.js';

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd && !rest.length) startServer();
else if (cmd === 'doctor' && !rest.length) process.exitCode = printDoctor(await doctor());
else {
  console.error(
    [
      'Usage:',
      '  obs-mcp          start the MCP server on stdio',
      '  obs-mcp doctor   check OBS and its WebSocket server; changes nothing',
      '',
      'The OBS password comes from the obs-websocket settings file or OBS_WEBSOCKET_PASSWORD, never from an argument.',
      'Other settings: OBS_WEBSOCKET_PORT, OBS_STUDIO_CONFIG_DIR.',
    ].join('\n'),
  );
  process.exitCode = 2;
}
