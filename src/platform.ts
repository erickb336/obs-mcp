// The platform layer: every OS-specific path and probe lives here, and nowhere else.
// Paths come from the OS conventions that OBS itself uses, or from discovery, never from one machine.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

const OS = process.platform;
/** Runs an OS tool. Returns its output, also on a non-zero exit, or null when the tool is missing or hangs. */
function probe(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    const err = e as { code?: string; stdout?: string };
    return err.code === 'ENOENT' || err.code === 'ETIMEDOUT' ? null : (err.stdout ?? '');
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

/** Where OBS is installed, by discovery. Returns null when no install is found. */
export function findObs(env: NodeJS.ProcessEnv = process.env): { path: string; version?: string } | null {
  if (OS === 'darwin') {
    const found = run('mdfind', ["kMDItemCFBundleIdentifier == 'com.obsproject.obs-studio'"]).split('\n').filter(Boolean);
    const app = [...found, '/Applications/OBS.app', join(homedir(), 'Applications', 'OBS.app')].find((p) => existsSync(p));
    if (!app) return null;
    const version = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')]).trim();
    return { path: app, version: version || undefined };
  }
  if (OS === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean) as string[];
    const exe = roots.map((r) => join(r, 'obs-studio', 'bin', '64bit', 'obs64.exe')).find((p) => existsSync(p));
    return exe ? { path: exe } : null;
  }
  const onPath = (env.PATH ?? '').split(delimiter).map((d) => join(d, 'obs')).find((p) => existsSync(p));
  const flatpak = ['/var/lib/flatpak/app/com.obsproject.Studio', join(homedir(), '.local', 'share', 'flatpak', 'app', 'com.obsproject.Studio')].find((p) => existsSync(p));
  const path = onPath ?? flatpak;
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

/** Local addresses on which a TCP port listens, read by the OS tool. null when the tool gave no reading. */
export function listenAddresses(port: number): string[] | null {
  if (OS === 'win32') {
    const out = probe('netstat', ['-an', '-p', 'TCP']);
    return out === null ? null : netstatListeners(out, port);
  }
  if (OS === 'darwin') {
    // lsof exits 1 with no output when nothing listens.
    const out = probe('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
    if (out === null) return null;
    return out.split('\n').map((l) => /\s(\S+:\d+) \(LISTEN\)/.exec(l)?.[1]).filter((a): a is string => !!a);
  }
  const out = probe('ss', ['-Hltn', `sport = :${port}`]);
  if (out === null) return null;
  return out.split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/)[3]).filter(Boolean);
}

/**
 * The local addresses in Windows "netstat -an" output that listen on a TCP port. The state word changes with the
 * display language, so a listener is found by its foreign address, which is 0.0.0.0:0 or [::]:0 only on a listener.
 */
export function netstatListeners(out: string, port: number): string[] {
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([proto, local, foreign]) => proto === 'TCP' && local?.endsWith(`:${port}`) && /^(0\.0\.0\.0|\[::\]):0$/.test(foreign ?? ''))
    .map(([, local]) => local);
}

/** Leftover run files in the OBS .sentinel folder. OBS leaves one when a session did not close normally. */
export function crashSentinels(obsConfigDir: string): string[] {
  const dir = join(obsConfigDir, '.sentinel');
  return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
}
