// The controller lock (G32): exactly one obs-mcp process for each OBS endpoint controls recording. The controller
// listens on a TCP port of 127.0.0.1 that a hash of the endpoint gives. Nothing is on disk and nothing comes from the
// environment, and the operating system frees the port when the process exits, also at a crash. A process that does
// not hold the lock is a reader: it reads OBS and the journal, and sends no recording request.
import { createHash } from 'node:crypto';
import { connect, createServer, type Server } from 'node:net';

const HOST = '127.0.0.1';
const WORD = 'obs-mcp-control';
/** How long a listener has to send its banner. A program that sends none in this time is not obs-mcp. */
const BANNER_MS = 500;

const sha = (s: string) => createHash('sha256').update(s).digest();

/** The banner hash of an endpoint, and its 8 lock ports in the range 49152 to 65535, in the order that a copy tries them. */
export function lockPorts(endpoint: string): { id: string; ports: number[] } {
  const ports: number[] = [];
  for (let i = 0; ports.length < 8; i++) {
    const port = 49152 + (sha(`${endpoint}\n${i}`).readUInt32BE(0) % 16384);
    if (!ports.includes(port)) ports.push(port);
  }
  return { id: sha(endpoint).toString('hex').slice(0, 16), ports };
}

/** What listens on a port: an obs-mcp controller of this endpoint ('ours'), nothing ('free'), or another program. */
function who(port: number, id: string): Promise<'ours' | 'free' | 'other'> {
  return new Promise((resolve) => {
    const s = connect({ host: HOST, port });
    let got = '';
    const end = (v: 'ours' | 'free' | 'other') => {
      clearTimeout(timer);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => end('other'), BANNER_MS);
    s.setEncoding('latin1');
    s.on('data', (d: string) => {
      got += d;
      const line = got.split('\n');
      if (line.length > 1 || got.length > 64) end(line[0].split(' ').slice(0, 2).join(' ') === `${WORD} ${id}` ? 'ours' : 'other');
    });
    s.on('end', () => end('other'));
    s.on('error', (e: NodeJS.ErrnoException) => end(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

const loopback = (a?: string) => a === HOST || a === `::ffff:${HOST}`;

/**
 * Listens on a lock port. Each connection gets the banner and is closed: when the other side closes, or after 1 s. The
 * listener uses no data that it gets. The other side closes first, so that no closed connection waits on the lock port.
 */
const listen = (port: number, banner: string) =>
  new Promise<Server | NodeJS.ErrnoException>((resolve) => {
    const server = createServer((s) => {
      s.on('error', () => {});
      if (!loopback(s.remoteAddress)) return s.destroy();
      s.setTimeout(2 * BANNER_MS, () => s.destroy());
      s.write(banner);
      s.resume(); // drops any data, so that the end of the other side comes through
    });
    server.on('error', resolve);
    server.listen(port, HOST, () => (server.unref(), resolve(server)));
  });

export class Control {
  private server?: Server;
  /** The endpoint of the held lock. */
  private at?: string;
  private trying?: Promise<boolean>;
  /** The code of a listen error other than EADDRINUSE: this copy cannot confirm that it alone controls (X16). */
  error?: string;

  constructor(private endpoint: () => string) {}

  get held() {
    return !!this.server;
  }

  /** Whether this process holds the lock of the endpoint now. */
  holds() {
    return !!this.server && this.at === this.endpoint();
  }

  /**
   * Tries to become the controller of the endpoint now. A lock of an older endpoint goes first (F-T7-73). True when
   * this process controls. Parallel calls share one try.
   */
  acquire(): Promise<boolean> {
    if (this.holds()) return Promise.resolve(true);
    this.close();
    this.trying ??= this.tryListen(this.endpoint()).finally(() => (this.trying = undefined));
    return this.trying;
  }

  /**
   * The first free port of the sequence is the lock. A port that answers with the banner of this endpoint is another
   * controller: this copy reads. A port that another program holds is passed (F-T7-74), and so is a port that the OS
   * keeps from programs (EACCES: Windows reserves ranges of these ports, the same for every process). After the listen, a banner
   * on any other port of the sequence means that a controller took a later port while an earlier one was held: this
   * copy lets its port go and reads, so that two copies never both control.
   */
  private async tryListen(endpoint: string): Promise<boolean> {
    const { id, ports } = lockPorts(endpoint);
    this.error = undefined;
    for (const [i, port] of ports.entries()) {
      const got = await listen(port, `${WORD} ${id} ${process.pid}\n`);
      if (got instanceof Error) {
        if (got.code === 'EACCES') continue;
        if (got.code !== 'EADDRINUSE') {
          this.error = got.code ?? 'unknown';
          return false;
        }
        if ((await who(port, id)) === 'ours') return false;
        continue;
      }
      const others = await Promise.all(ports.map((p, j) => (j === i ? 'free' : who(p, id))));
      if (others.includes('ours')) {
        got.close();
        return false;
      }
      this.server = got;
      this.at = endpoint;
      return true;
    }
    this.error = 'no free port';
    return false;
  }

  /** Frees the lock: a reader can take it at its next tool call. */
  close() {
    this.server?.close();
    this.server = undefined;
    this.at = undefined;
  }
}
