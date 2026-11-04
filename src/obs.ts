// The OBS layer: obs-websocket settings, the connection and one request path. It holds no OS-specific code:
// the OBS settings folder comes in from platform.ts.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { OBSWebSocket, EventSubscription } from 'obs-websocket-js/json';

// obs-websocket-js logs every raw OBS reply, secrets included, through the "debug" package when DEBUG names it.
// Its logger reads the enabled names of the debug instance at each call, so turning its names off here holds
// in any import order. The require is relative to obs-websocket-js, so that it gets the same debug instance.
const debug = createRequire(import.meta.resolve('obs-websocket-js/json'))('debug') as { enable(n: string): void; disable(): string };
debug.enable(`${debug.disable()},-obs-websocket-js,-obs-websocket-js:*`);

const DEFAULT_PORT = 4455;

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
    const why = e instanceof SyntaxError ? 'is not valid JSON' : `cannot be read (${(e as { code?: string }).code ?? (e as Error).name})`;
    return { settings: { file, found: true, error: `The obs-websocket settings file ${file} ${why}.` } };
  }
}

/** The fix step for a settings file that cannot be read. */
export const SETTINGS_FILE_FIX =
  'Open OBS, then Tools, WebSocket Server Settings, check the settings and press OK: OBS then writes the file again. Doctor never changes the file.';

/** Where the connection settings come from. The password comes from the environment or the settings file, never from an argument. */
export function connectionTarget(obsConfigDir: string, env: NodeJS.ProcessEnv = process.env) {
  const { settings, password: filePassword } = readSettingsFile(obsConfigDir);
  // A set OBS_WEBSOCKET_PORT must be a whole number from 1 to 65535. Any other value, an empty one too, is an error, not a silent default.
  const raw = env.OBS_WEBSOCKET_PORT;
  const valid = raw !== undefined && /^\d{1,5}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 65535;
  const portError = raw !== undefined && !valid
    ? `OBS_WEBSOCKET_PORT is "${raw.length > 20 ? `${raw.slice(0, 20)}...` : raw}". It must be a whole number from 1 to 65535. Fix it, or remove it to use the port in the obs-websocket settings file.`
    : undefined;
  const port = valid ? Number(raw) : (settings.port ?? DEFAULT_PORT);
  const password = env.OBS_WEBSOCKET_PASSWORD || filePassword;
  const passwordFrom = env.OBS_WEBSOCKET_PASSWORD ? 'environment variable OBS_WEBSOCKET_PASSWORD' : filePassword ? 'obs-websocket settings file' : 'none';
  // Loopback only: the server never connects to another host.
  return { settings, url: `ws://127.0.0.1:${port}`, port, portError, password, passwordFrom };
}

/** A listener on the OBS WebSocket port, as the platform layer read it. process is the program name, when the OS tool gives it. */
export type Listener = { address: string; process?: string };

/** OBS runs as "OBS" (macOS), "obs" (Linux) or "obs64.exe" (Windows). */
const isObsProcess = (name: string) => /^obs(64|32)?(\.exe)?$/i.test(name);

/**
 * The listener check, in words: the exposure of the port and the program that listens. listeners is null when the OS
 * tool gave no reading. connected says that OBS answered on the port, so an empty or missing reading is not a problem.
 */
export function listenerCheck(port: number, listeners: Listener[] | null, connected: boolean): { result: 'info' | 'warn'; text: string } {
  if (!listeners?.length) {
    const why = listeners === null ? 'the OS tool that lists listeners gave no reading' : 'the OS tool lists no listener there';
    return { result: 'info', text: connected ? `OBS answers on port ${port}, but ${why}, so its exposure is unknown.` : listeners === null ? `Port ${port}: unknown, because ${why}.` : `Nothing listens on port ${port} now.` };
  }
  const addresses = [...new Set(listeners.map((l) => l.address))];
  const all = addresses.some((a) => /^(\*|0\.0\.0\.0|\[::\]|::|\[::0\]):\d+$/.test(a));
  const names = [...new Set(listeners.map((l) => l.process).filter((p): p is string => !!p))];
  const others = names.filter((n) => !isObsProcess(n));
  const where = all
    ? `Port ${port} listens on all network interfaces (${addresses.join(', ')}). Other devices on your network can reach it, unless a firewall blocks them. obs-websocket has no option to listen on localhost only; its password is the only control in OBS.`
    : `Port ${port} listens on ${addresses.join(', ')} only.`;
  const who = names.length ? ` Program: ${names.join(', ')}.` : ' Program: unknown.';
  if (!others.length) return { result: 'info', text: where + who };
  return { result: 'warn', text: `${where}${who} ${others.join(', ')} is not OBS, and obs-mcp connects to it as OBS. Close that program, or give OBS another port and set OBS_WEBSOCKET_PORT to it.` };
}

const OPEN_OBS = 'Open OBS and turn on its WebSocket server: Tools, WebSocket Server Settings, Enable WebSocket server.';

/** A failure with plain words. next is the step that fixes it; doctor and obs_status both show it. */
export class ObsError extends Error {
  constructor(message: string, readonly code?: number, readonly next = OPEN_OBS) {
    super(message);
  }
}

/** Plain words and the next step for a failed connection. Never includes the password. */
function connectError(e: unknown, t: ReturnType<typeof connectionTarget>): ObsError {
  if (e instanceof ObsError) return e;
  const code = (e as { code?: number }).code;
  const showPassword = 'In OBS: Tools, WebSocket Server Settings, Show Connect Info shows the password.';
  if (code === 4009) return new ObsError('OBS refused the password (authentication failed).', code, `Check the password that obs-mcp reads from the ${t.passwordFrom}. ${showPassword}`);
  if (code === 4008) return new ObsError('OBS asks for a password, and none was found.', code, `Set OBS_WEBSOCKET_PASSWORD to it, or check the obs-websocket settings file. ${showPassword}`);
  return new ObsError(`No answer from OBS on 127.0.0.1:${t.port}. OBS is closed, its WebSocket server is off, or it uses another port.`, code);
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

/** An OBS event, or the close of a connection, with the number of the connection that carried it. */
export type ObsEvent = { type: 'RecordStateChanged' | 'RecordFileChanged' | 'ExitStarted' | 'closed'; data: Record<string, unknown>; conn: number };
const EVENTS = ['RecordStateChanged', 'RecordFileChanged', 'ExitStarted'] as const;

/** Reconnect waits (P8): 0.5, 1, 2, 4 and 8 s, then each 10 s. */
export const RECONNECT_MS = [500, 1000, 2000, 4000, 8000, 10000];

/**
 * One lazy connection to OBS, shared by every tool call. Each connection that opens gets the next number (F11), so
 * a reading can say which connection it came from, and a recording request can go out only on the connection of the
 * reading that allowed it.
 */
export class Obs {
  private ws?: OBSWebSocket;
  // The connection that is open or opening. Parallel first calls share it; a failure clears it, so a later call tries again.
  private opening?: Promise<Version>;
  private listeners = new Set<(e: ObsEvent) => void>();
  private retry?: { timer?: NodeJS.Timeout; step: number };
  version?: Version;
  /** The number of the last connection that opened: 0 before the first. */
  connection = 0;

  /** connectMs limits the connection and its GetVersion; callMs limits each request; reconnectMs are the reconnect waits. */
  constructor(
    private target: () => ReturnType<typeof connectionTarget>,
    private limits: { connectMs: number; callMs: number; reconnectMs?: number[] } = { connectMs: 3000, callMs: 10000 },
  ) {}

  get connected() {
    return !!this.ws;
  }

  /** Gets each record event, ExitStarted, and the close of each connection. Returns the call that stops it. */
  onEvent(fn: (e: ObsEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ObsEvent) {
    for (const fn of this.listeners) fn(e);
  }

  connect(): Promise<Version> {
    this.opening ??= this.open().catch((e) => {
      this.opening = undefined;
      throw e;
    });
    return this.opening;
  }

  /**
   * on: after a close, connect again with the waits of P8, until a connection opens or this is turned off. A reconnect
   * sends only the handshake and GetVersion: never a recording request.
   */
  keepConnected(on: boolean) {
    clearTimeout(this.retry?.timer);
    this.retry = on ? { step: 0 } : undefined;
    if (on && !this.ws) this.scheduleRetry(0);
  }

  private scheduleRetry(wait: number) {
    const r = this.retry;
    if (!r) return;
    r.timer = setTimeout(() => {
      if (this.retry !== r || this.ws) return;
      this.connect().catch(() => {
        const waits = this.limits.reconnectMs ?? RECONNECT_MS;
        this.scheduleRetry(waits[Math.min(r.step++, waits.length - 1)]);
      });
    }, wait);
    r.timer.unref?.();
  }

  private async open(): Promise<Version> {
    const t = this.target();
    if (t.portError) throw new ObsError(t.portError, undefined, 'Fix OBS_WEBSOCKET_PORT, or remove it.');
    const ws = new OBSWebSocket();
    const ms = this.limits.connectMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      // The limit covers GetVersion too: a program that accepts the connection and never answers does not hang the server.
      const opened = async () => {
        await ws.connect(t.url, t.password, { rpcVersion: 1, eventSubscriptions: EventSubscription.Outputs | EventSubscription.General });
        return (await ws.call('GetVersion')) as unknown as Version;
      };
      this.version = await Promise.race([
        opened(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new ObsError(`No reply from OBS on 127.0.0.1:${t.port} in ${ms} ms. The program on that port accepted the connection, then did not answer.`)), ms))),
      ]);
    } catch (e) {
      await ws.disconnect().catch(() => {});
      throw connectError(e, t);
    } finally {
      clearTimeout(timer);
    }
    const conn = ++this.connection;
    for (const type of EVENTS) ws.on(type, (...a: unknown[]) => this.emit({ type, data: (a[0] ?? {}) as Record<string, unknown>, conn }));
    ws.on('ConnectionClosed', (e: { code?: number }) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.version = undefined;
      this.opening = undefined;
      this.emit({ type: 'closed', data: { code: e.code }, conn });
      if (this.retry) {
        this.retry.step = 1;
        this.scheduleRetry((this.limits.reconnectMs ?? RECONNECT_MS)[0]);
      }
    });
    this.ws = ws;
    if (this.retry) this.retry.step = 0;
    return this.version;
  }

  /** Sends one request, on a new connection when none is open. */
  async call(request: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.read(request, params)).data;
  }

  /** Sends one request, and gives its reply with the number of the connection that carried it. */
  async read(request: string, params?: Record<string, unknown>): Promise<{ data: Record<string, unknown>; conn: number }> {
    await this.connect();
    const conn = this.connection;
    return { data: await this.callOn(conn, request, params), conn };
  }

  /**
   * Sends one request only on connection conn. It never opens a connection: when conn closed, it throws and sends
   * nothing. obs-websocket-js has no timeout, and a close does not reject a call, so both are raced here.
   */
  async callOn(conn: number, request: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || conn !== this.connection) throw new ObsError(`The connection to OBS changed before ${request}, so it was not sent.`);
    const ms = this.limits.callMs;
    let timer: NodeJS.Timeout | undefined;
    let onClose: ((e: { code?: number }) => void) | undefined;
    try {
      return await Promise.race([
        ws.call(request as never, params as never) as Promise<Record<string, unknown>>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ObsError(`No reply from OBS to ${request} in ${ms} ms.`)), ms);
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
    this.keepConnected(false);
    const ws = this.ws;
    this.ws = undefined;
    this.version = undefined;
    this.opening = undefined;
    await ws?.disconnect().catch(() => {});
  }
}
