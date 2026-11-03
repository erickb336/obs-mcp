// The OBS layer: obs-websocket settings, the connection and one request path. It holds no OS-specific code:
// the OBS settings folder comes in from platform.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OBSWebSocket, EventSubscription } from 'obs-websocket-js/json';

const DEFAULT_PORT = 4455;
const CONNECT_MS = 3000;
const CALL_MS = 10000;

/** What the obs-websocket settings file says. The password value is kept apart, so that no report can print it. */
export type ServerSettings = {
  file: string;
  found: boolean;
  enabled?: boolean;
  port?: number;
  authRequired?: boolean;
  error?: string;
};

export const websocketSettingsFile = (obsConfigDir: string) => join(obsConfigDir, 'plugin_config', 'obs-websocket', 'config.json');

function readSettingsFile(obsConfigDir: string): { settings: ServerSettings; password?: string } {
  const file = websocketSettingsFile(obsConfigDir);
  if (!existsSync(file)) return { settings: { file, found: false } };
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return {
      settings: { file, found: true, enabled: j.server_enabled === true, port: Number(j.server_port) || undefined, authRequired: j.auth_required === true },
      password: j.auth_required === true && typeof j.server_password === 'string' ? j.server_password : undefined,
    };
  } catch (e) {
    return { settings: { file, found: true, error: `cannot read: ${(e as Error).name}` } };
  }
}

/** Where the connection settings come from. The password comes from the environment or the settings file, never from an argument. */
export function connectionTarget(obsConfigDir: string, env: NodeJS.ProcessEnv = process.env) {
  const { settings, password: filePassword } = readSettingsFile(obsConfigDir);
  const envPort = Number(env.OBS_WEBSOCKET_PORT) || undefined;
  const port = envPort ?? settings.port ?? DEFAULT_PORT;
  const password = env.OBS_WEBSOCKET_PASSWORD || filePassword;
  const passwordFrom = env.OBS_WEBSOCKET_PASSWORD ? 'environment variable OBS_WEBSOCKET_PASSWORD' : filePassword ? 'obs-websocket settings file' : 'none';
  // Loopback only: the server never connects to another host.
  return { settings, url: `ws://127.0.0.1:${port}`, port, password, passwordFrom };
}

/** The exposure of the OBS WebSocket port, in words, from the addresses that the platform layer read. */
export function listenerWords(port: number, addresses: string[] | null): string {
  if (addresses === null) return `No reading of port ${port}: the OS tool that lists listeners is not available.`;
  if (!addresses.length) return `Nothing listens on port ${port} now.`;
  const all = addresses.some((a) => /^(\*|0\.0\.0\.0|\[::\]|::|\[::0\]):\d+$/.test(a));
  return all
    ? `Port ${port} listens on all network interfaces (${addresses.join(', ')}). Other devices on your network can reach OBS there, unless a firewall blocks them. obs-websocket has no option to listen on localhost only; its password is the only control in OBS.`
    : `Port ${port} listens on ${addresses.join(', ')} only.`;
}

export class ObsError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** Plain words for a failed connection. Never includes the password. */
function explainConnect(e: unknown, port: number): string {
  const err = e as { code?: number; message?: string };
  if (e instanceof ObsError) return e.message;
  if (err.code === 4009) return 'OBS refused the password (authentication failed). Check the password in OBS: Tools, WebSocket Server Settings.';
  if (err.code === 4008) return 'OBS asks for a password, and none was found. Set OBS_WEBSOCKET_PASSWORD, or check the obs-websocket settings file.';
  return `No answer from OBS on 127.0.0.1:${port}. OBS is closed, its WebSocket server is off, or it uses another port.`;
}

/** Plain words for a request that failed after the connection was up. */
function explainCall(e: unknown): string {
  const err = e as { code?: number; message?: string };
  if (err.code === 1006) return 'OBS closed the connection with code 1006 (abnormal close). OBS may have crashed.';
  return String(err.message ?? e);
}

export type Version = {
  obsVersion: string;
  obsWebSocketVersion: string;
  rpcVersion: number;
  availableRequests: string[];
  platform: string;
  platformDescription: string;
};

/** One lazy connection to OBS, shared by every tool call. */
export class Obs {
  private ws?: OBSWebSocket;
  version?: Version;

  constructor(private target: () => ReturnType<typeof connectionTarget>) {}

  async connect(): Promise<Version> {
    if (this.ws && this.version) return this.version;
    const t = this.target();
    const ws = new OBSWebSocket();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ws.connect(t.url, t.password, { rpcVersion: 1, eventSubscriptions: EventSubscription.None }),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new ObsError(`No reply from OBS in ${CONNECT_MS} ms.`)), CONNECT_MS))),
      ]);
      this.version = (await ws.call('GetVersion')) as unknown as Version;
    } catch (e) {
      await ws.disconnect().catch(() => {});
      throw new ObsError(explainConnect(e, t.port), (e as { code?: number }).code);
    } finally {
      clearTimeout(timer);
    }
    ws.on('ConnectionClosed', () => {
      if (this.ws === ws) {
        this.ws = undefined;
        this.version = undefined;
      }
    });
    this.ws = ws;
    return this.version;
  }

  /** Sends one request. obs-websocket-js has no timeout, and a close does not reject a call, so both are raced here. */
  async call(request: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.connect();
    const ws = this.ws!;
    let timer: NodeJS.Timeout | undefined;
    let onClose: ((e: { code?: number }) => void) | undefined;
    try {
      return await Promise.race([
        ws.call(request as never, params as never) as Promise<Record<string, unknown>>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ObsError(`No reply from OBS to ${request} in ${CALL_MS} ms.`)), CALL_MS);
          onClose = (e) => reject(new ObsError(explainCall({ code: e.code, message: 'OBS closed the connection.' }), e.code));
          ws.once('ConnectionClosed', onClose);
        }),
      ]);
    } catch (e) {
      throw e instanceof ObsError ? e : new ObsError(explainCall(e), (e as { code?: number }).code);
    } finally {
      clearTimeout(timer);
      if (onClose) ws.off('ConnectionClosed', onClose);
    }
  }

  async close() {
    const ws = this.ws;
    this.ws = undefined;
    this.version = undefined;
    await ws?.disconnect().catch(() => {});
  }
}
