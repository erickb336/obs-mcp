// The platform layer: every OS-specific path and probe lives here, and nowhere else.
// Paths come from the OS conventions that OBS itself uses, or from discovery, never from one machine.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync, statSync, readFileSync } from 'node:fs';
import type { Listener } from './obs.js';
import { homedir } from 'node:os';
import { basename, dirname, join, delimiter, isAbsolute, win32 } from 'node:path';

const OS = process.platform;
/**
 * Runs an OS tool. Returns its output, or null when the tool is missing, hangs or fails. emptyExit is the exit code
 * by which the tool says "nothing found" (lsof exits 1 with no output and no error text); it gives empty output.
 */
export function probe(cmd: string, args: string[], emptyExit?: number): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string };
    return emptyExit !== undefined && err.status === emptyExit && !err.stderr?.trim() && !err.stdout?.trim() ? '' : null;
  }
}
const run = (cmd: string, args: string[]) => probe(cmd, args) ?? '';

/** The OBS settings folder. OBS_STUDIO_CONFIG_DIR overrides it, for a portable or custom install. */
export function obsConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OBS_STUDIO_CONFIG_DIR) return env.OBS_STUDIO_CONFIG_DIR;
  const home = homedir();
  if (OS === 'darwin') return join(home, 'Library', 'Application Support', 'obs-studio');
  if (OS === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'obs-studio');
  const native = join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'obs-studio');
  const flatpak = join(home, '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio');
  return !existsSync(native) && existsSync(flatpak) ? flatpak : native;
}

/** The take journal folder (T7 section 6). OBS_MCP_STATE_DIR overrides it. */
export function stateDir(env: NodeJS.ProcessEnv = process.env, os: string = OS): string {
  if (env.OBS_MCP_STATE_DIR) return env.OBS_MCP_STATE_DIR;
  const home = homedir();
  if (os === 'darwin') return join(home, 'Library', 'Application Support', 'obs-mcp', 'takes');
  if (os === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'obs-mcp', 'takes');
  return join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'obs-mcp', 'takes');
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** A file named name in a folder of PATH. An empty PATH segment (the current folder) never counts, and a folder is not a program. */
export function onPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return (env.PATH ?? '').split(delimiter).filter((d) => isAbsolute(d)).map((d) => join(d, name)).find(isFile);
}

/** The audio tools of the file check. OBS_MCP_FFMPEG names ffmpeg, with ffprobe beside it; otherwise both come from PATH. afinfo is a macOS fallback. */
export function audioTools(env: NodeJS.ProcessEnv = process.env, os: string = OS): { ffmpeg?: string; ffprobe?: string; afinfo?: string; install: string } {
  const exe = (n: string) => (os === 'win32' ? `${n}.exe` : n);
  const set = env.OBS_MCP_FFMPEG;
  const ffmpeg = set ? (isAbsolute(set) && isFile(set) ? set : undefined) : onPath(env, exe('ffmpeg'));
  const ffprobe = set ? [join(dirname(set), exe('ffprobe'))].find((p) => ffmpeg && isFile(p)) : onPath(env, exe('ffprobe'));
  const install = os === 'darwin' ? 'brew install ffmpeg' : os === 'win32' ? 'winget install --id Gyan.FFmpeg' : 'Install the ffmpeg package of your distribution, for example: sudo apt install ffmpeg';
  return { ffmpeg, ffprobe, afinfo: os === 'darwin' ? onPath(env, 'afinfo') : undefined, install };
}

/** Where OBS is installed, by discovery. Returns null when no install is found. os is a parameter for tests. */
export function findObs(env: NodeJS.ProcessEnv = process.env, os: string = OS): { path: string; version?: string } | null {
  if (os === 'darwin') {
    const found = run('mdfind', ["kMDItemCFBundleIdentifier == 'com.obsproject.obs-studio'"]).split('\n').filter(Boolean);
    const app = [...found, '/Applications/OBS.app', join(homedir(), 'Applications', 'OBS.app')].find((p) => existsSync(p));
    if (!app) return null;
    const version = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')]).trim();
    return { path: app, version: version || undefined };
  }
  if (os === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean) as string[];
    // The installer puts OBS in obs-studio; Steam puts it in its library folder.
    const exe = roots
      .flatMap((r) => [join(r, 'obs-studio'), join(r, 'Steam', 'steamapps', 'common', 'OBS Studio')])
      .map((d) => join(d, 'bin', '64bit', 'obs64.exe'))
      .find(isFile);
    return exe ? { path: exe } : null;
  }
  const flatpakApp = (root: string) => join(root, 'com.obsproject.Studio', 'current', 'active', 'files', 'bin', 'obs');
  const path =
    onPath(env, 'obs') ??
    ['/snap/bin/obs-studio', flatpakApp('/var/lib/flatpak/app'), flatpakApp(join(homedir(), '.local', 'share', 'flatpak', 'app'))].find(isFile);
  return path ? { path } : null;
}

/** The OBS version in the newest OBS log. Reads only the version line, because a log can hold secrets. */
export function versionFromLog(obsConfigDir: string): string | undefined {
  const dir = join(obsConfigDir, 'logs');
  if (!existsSync(dir)) return undefined;
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  if (!newest) return undefined;
  const head = readFileSync(join(dir, newest.f), 'utf8').slice(0, 20000);
  return /\bOBS (\d+\.\d+\.\d+)\b/.exec(head)?.[1];
}

/** The listeners on a TCP port, with their program names, read by the OS tool. null when the tool gave no reading. */
export function listeners(port: number): Listener[] | null {
  if (OS === 'win32') {
    const out = probe(windowsTool('netstat.exe'), ['-ano', '-p', 'TCP']);
    if (out === null) return null;
    const name = (pid: string) => (/^\d+$/.test(pid) ? tasklistName(probe(windowsTool('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']) ?? '') : undefined);
    return netstatListeners(out, port).map(({ address, pid }) => ({ address, process: name(pid) }));
  }
  if (OS === 'darwin') {
    // lsof exits 1 with no output when nothing listens. "+c 0" gives the full program name.
    const out = probe('lsof', ['+c', '0', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], 1);
    if (out === null) return null;
    return out.split('\n').flatMap((l) => {
      const address = /\s(\S+:\d+) \(LISTEN\)/.exec(l)?.[1];
      return address ? [{ address, process: l.split(/\s+/)[0].replaceAll('\\x20', ' ') }] : [];
    });
  }
  const out = probe('ss', ['-Hltnp', `sport = :${port}`]);
  if (out === null) return null;
  // ss shows users:(("name",pid=1234,fd=30)) only for the processes of this user. The name there is the thread name,
  // which a program can change (Node calls its thread "MainThread"), so the program file of the pid comes first.
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ address: l.trim().split(/\s+/)[3], process: programOf(/pid=(\d+)/.exec(l)?.[1]) ?? /users:\(\("([^"]+)"/.exec(l)?.[1] }))
    .filter((x) => x.address);
}

/** The file name of the program that runs as a Linux pid, for example "obs", or undefined when /proc does not give it. */
function programOf(pid: string | undefined): string | undefined {
  try {
    return pid ? basename(readlinkSync(`/proc/${pid}/exe`)) : undefined;
  } catch {
    return undefined;
  }
}

/** The full path of a tool in the Windows folder, so that a copy in the current folder or on PATH never runs instead. */
export const windowsTool = (name: string, env: NodeJS.ProcessEnv = process.env) => win32.join(env.SystemRoot || 'C:\\Windows', 'System32', name);

/**
 * The listeners in Windows "netstat -ano" output on a TCP port, with the process id. The state word changes with the
 * display language, so a listener is found by its foreign address, which is 0.0.0.0:0 or [::]:0 only on a listener.
 */
export function netstatListeners(out: string, port: number): { address: string; pid: string }[] {
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([proto, local, foreign]) => proto === 'TCP' && local?.endsWith(`:${port}`) && /^(0\.0\.0\.0|\[::\]):0$/.test(foreign ?? ''))
    .map((cols) => ({ address: cols[1], pid: cols[cols.length - 1] }));
}

/** The program name in Windows "tasklist /FO CSV /NH" output, for example "obs64.exe". */
export const tasklistName = (out: string) => /^"([^"]+)"/.exec(out.trim())?.[1];

/** Leftover run files in the OBS .sentinel folder. OBS leaves one when a session did not close normally. */
export function crashSentinels(obsConfigDir: string): string[] {
  const dir = join(obsConfigDir, '.sentinel');
  return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
}
