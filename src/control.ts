// The controller lock (G32): exactly one obs-mcp process for each OBS endpoint controls recording. It listens on a
// local socket (a Unix domain socket, or a Windows named pipe; the platform layer gives the name). The operating
// system frees the socket when the process exits, also at a crash. A process that cannot listen is a reader: it
// reads OBS and the journal, and sends no recording request.
import { randomBytes } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';

/** Whether a process listens on the socket path now. */
const answers = (path: string) =>
  new Promise<boolean>((resolve) => {
    const s = createConnection(path);
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

const listen = (path: string) =>
  new Promise<Server | NodeJS.ErrnoException>((resolve) => {
    const server = createServer((s) => s.destroy());
    server.once('error', resolve);
    server.listen(path, () => (server.unref(), resolve(server)));
  });

export class Control {
  private server?: Server;
  private trying?: Promise<boolean>;

  constructor(private path: () => string) {}

  get held() {
    return !!this.server;
  }

  /** Tries to become the controller. True when this process controls. Parallel calls share one try. */
  acquire(): Promise<boolean> {
    if (this.server) return Promise.resolve(true);
    this.trying ??= this.tryListen().finally(() => (this.trying = undefined));
    return this.trying;
  }

  /**
   * A socket file that nobody answers is stale: a crashed process left it (Unix only; a named pipe goes with its
   * process). It moves to a new name, and only a file that is dead there too is removed. A live socket that a second
   * process moved in the same moment goes back to its name, so of two processes only one listens.
   */
  private async tryListen(): Promise<boolean> {
    const path = this.path();
    for (let round = 0; round < 3; round++) {
      const got = await listen(path);
      if (!(got instanceof Error)) return !!(this.server = got);
      if (got.code !== 'EADDRINUSE' || process.platform === 'win32' || (await answers(path))) return false;
      const moved = `${path}.${randomBytes(4).toString('hex')}`;
      try {
        renameSync(path, moved);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // another process removed it first
        return false;
      }
      if (await answers(moved)) {
        renameSync(moved, path);
        return false;
      }
      rmSync(moved, { force: true });
    }
    return false;
  }

  /** Frees the lock: a reader can take it at its next tool call. */
  close() {
    this.server?.close();
    this.server = undefined;
  }
}
