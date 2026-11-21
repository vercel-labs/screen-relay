import { closeSync, fchmodSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Failure } from '../output.js';
import { killTree, windowsStartTime } from './windows.js';

export type ProcessIdentity = { pid: number; start: string | null };
export type SessionData = Record<string, any>;

export function stateDir(name: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new Failure('invalid_input', `Invalid session name "${name}"`, 'Use letters, digits, ".", "_" or "-".');
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'screen-relay', name);
}

export function readSession(name: string): SessionData | null {
  try {
    return JSON.parse(readFileSync(join(stateDir(name), 'session.json'), 'utf8')) as SessionData;
  } catch {
    return null;
  }
}

export function writeSession(directory: string, data: SessionData): void {
  const temporary = join(directory, 'session.json.tmp');
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temporary, join(directory, 'session.json'));
}

/** Writes a file only this user can read, removing any file or symlink already at that path instead of following it. */
export function writePrivateFile(path: string, contents: string): void {
  rmSync(path, { force: true });
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents);
  } finally {
    closeSync(descriptor);
  }
}

export function cleanupWaylandRuntime(session: SessionData | null): boolean {
  if (session?.backend !== 'wayland' || typeof session.runtimeDir !== 'string') return false;
  const runtimeDir = session.runtimeDir;
  const identity = session.runtimeIdentity;
  if (/^\/tmp\/relay-[a-zA-Z0-9]{6}$/.test(runtimeDir) && identity && typeof process.getuid === 'function') {
    try {
      const stat = lstatSync(runtimeDir, { bigint: true });
      if (stat.isDirectory() && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino &&
          String(stat.uid) === identity.uid && stat.uid === BigInt(process.getuid())) {
        rmSync(runtimeDir, { recursive: true, force: true });
      }
    } catch {}
  }
  if (session.environment?.XDG_RUNTIME_DIR === runtimeDir) delete session.environment.XDG_RUNTIME_DIR;
  if (typeof session.environment?.SWAYSOCK === 'string' && session.environment.SWAYSOCK.startsWith(`${runtimeDir}/`)) delete session.environment.SWAYSOCK;
  delete session.runtimeDir;
  delete session.runtimeIdentity;
  delete session.waylandDisplay;
  return true;
}

export function tail(path: string, lines = 20): string {
  try {
    const descriptor = openSync(path, 'r');
    try {
      const size = fstatSync(descriptor).size;
      const buffer = Buffer.alloc(Math.min(size, 65536));
      readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return buffer.toString().split(/\r?\n/).slice(-lines).join('\n');
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return '';
  }
}

/** Reads a process start time from ps, the only source macOS has without /proc. */
function darwinStartTime(pid: number): string | null {
  try {
    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    const started = Date.parse(output);
    return Number.isNaN(started) ? output : String(started);
  } catch {
    return null;
  }
}

export function startTime(pid: number): string | null {
  if (process.platform === 'win32') return windowsStartTime(pid);
  if (process.platform === 'darwin') return darwinStartTime(pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
    return fields[0] === 'Z' ? null : fields[19] ?? null;
  } catch {
    return null;
  }
}

export function alive(record: unknown): boolean {
  if (!record || typeof record !== 'object') return false;
  const value = record as Partial<ProcessIdentity>;
  if (process.platform === 'win32' && value.start === null) return false;
  return typeof value.pid === 'number' && value.start !== undefined && startTime(value.pid) === value.start;
}

export function identity(pid: number): ProcessIdentity {
  return { pid, start: startTime(pid) };
}

/** Creates a lock file that names this process as its owner, whole or not at all. Returns false when the file already exists. */
export function claimLock(file: string): boolean {
  const claim = `${file}.${process.pid}`;
  writeFileSync(claim, JSON.stringify(identity(process.pid)));
  try {
    linkSync(claim, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    rmSync(claim, { force: true });
  }
}

/** Whether the process that claimed a lock file is still running. A missing, empty, or unreadable file has no owner. */
export function lockOwnerAlive(file: string): boolean {
  try {
    return alive(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return false;
  }
}

/** Signals every Linux process carrying this session's SCREEN_RELAY_SESSION marker; on macOS the app watcher stops each app it holds. */
export async function sweep(directory: string, signal?: AbortSignal): Promise<void> {
  if (process.platform === 'darwin' || process.platform === 'win32') return;
  const marker = Buffer.from(`SCREEN_RELAY_SESSION=${directory}`);
  for (const killSignal of ['SIGTERM', 'SIGKILL'] as const) {
    signal?.throwIfAborted();
    const found: number[] = [];
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      return;
    }
    for (const entry of entries) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      try {
        const environment = readFileSync(`/proc/${entry}/environ`);
        if (environment.toString().split('\0').some((entry) => entry === marker.toString())) {
          process.kill(pid, killSignal);
          found.push(pid);
        }
      } catch {}
    }
    if (!found.length) return;
    await delay(500, undefined, { signal });
  }
}

export async function reap(directory: string, session: SessionData | null, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  for (const record of Object.values(session?.components ?? {}) as unknown[]) {
    if (alive(record)) {
      try {
        if (process.platform === 'win32') killTree((record as ProcessIdentity).pid);
        else process.kill(-Number((record as ProcessIdentity).pid), 'SIGKILL');
      } catch {}
    }
  }
  await sweep(directory, signal);
}

/** Holds the session lock until close: flock on Linux, lockf on macOS, and a lock file on Windows. */
export async function lock(name: string, directory: string): Promise<{ close(): Promise<void> }> {
  const file = join(directory, 'lock');
  const busy = () => new Failure('already_running', `Session "${name}" is already running`,
    'Stop it with `screen-relay down --name ' + name + '` or pick another --name.');
  if (process.platform === 'win32') {
    while (!claimLock(file)) {
      if (lockOwnerAlive(file)) throw busy();
      rmSync(file, { force: true });
    }
    return { close: () => { rmSync(file, { force: true }); return Promise.resolve(); } };
  }
  const [command, args] = process.platform === 'darwin'
    ? ['lockf', ['-k', '-s', '-t', '0', file, 'sh', '-c', 'printf .; cat']]
    : ['flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', file, 'sh', '-c', 'printf .; cat']];
  const child = spawn(command, args, { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const acquired = new Promise<void>((resolve, reject) => {
    let ready = false;
    child.stdout.on('data', () => {
      if (!ready) { ready = true; resolve(); }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(code === 75 ? busy() : new Failure('internal', `Cannot lock ${file}`, 'Check the state directory permissions with `screen-relay doctor`.')));
  });
  try {
    await acquired;
  } catch (error) {
    child.stdin.destroy();
    if (error instanceof Failure) throw error;
    throw new Failure('internal', `Cannot lock ${file}: ${String(error)}`, 'Check the state directory permissions with `screen-relay doctor`.');
  }
  return {
    close() {
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => child.once('exit', () => resolve()));
    },
  };
}
