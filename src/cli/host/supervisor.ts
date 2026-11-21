import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { createClient } from '../../sdk/index.js';
import { BACKENDS, backendValue } from '../config.js';
import { Failure, nextFor, sessionCommand } from '../output.js';
import { engineDirectory, HostArgs, isLinux, LAUNCHER_DIR, run, spawnCleared, which } from './common.js';
import { cleanupWaylandRuntime, identity, SessionData, sweep, tail, writeSession } from './state.js';
import { engineEnvironment, engineWorkingDirectory } from './windows.js';

export const BACKEND_PROGRAMS = {
  x11: ['Xvfb', 'xauth', 'xprop', 'xwininfo', 'xdpyinfo', 'setxkbmap'],
  wayland: ['sway', 'Xwayland', 'swaymsg', 'foot'],
  macos: [],
  windows: [],
};

export const HINTS: Record<string, string> = {
  display: 'Check Xvfb and /tmp/.X11-unix with `screen-relay doctor`.',
  dbus: 'Read `screen-relay logs dbus` and check dbus-daemon is installed.',
  desktop: 'Run `screen-relay doctor` (icon decoding, D-Bus) and read `screen-relay logs desktop`.',
  engine: 'If the port is taken, pick another with --port; otherwise run `screen-relay doctor`.',
};

export type SessionArgs = HostArgs & {
  name: string;
  port: number;
  display?: string;
  desktop?: string;
  public?: string;
  'allow-origin'?: string;
  bind?: string;
  resolution: string;
  fps: number;
  bitrateMin: number;
  bitrateStart: number;
  bitrateMax: number;
  timeout?: number;
  'tls-cert'?: string;
  'tls-key'?: string;
  keyboardLayout?: string;
  compositor?: string;
};

type EngineTarget = { url: string; token?: string | null; certificate?: string | null; connect?: string | null };
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
}

function readLine(stream: Readable, timeout: number, check: () => void): Promise<string> {
  stream.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setInterval(() => {
      try {
        check();
        if (Date.now() > deadline) finish(reject, new Error('timeout'));
      } catch (error) {
        finish(reject, error);
      }
    }, 200);
    const deadline = Date.now() + timeout;
    const finish = (done: (value: any) => void, value: any) => {
      clearInterval(timer);
      done(value);
    };
    stream.on('data', (chunk: string) => {
      text += chunk;
      if (text.includes('\n')) finish(resolve, text.split(/\r?\n/)[0]);
      else if (text.length > 4096) finish(reject, new Error('overflow'));
    });
    stream.once('end', () => finish(reject, new Error('closed')));
    stream.once('error', (error) => finish(reject, error));
  });
}

export async function startXvfb(
  start: (command: string[], options: SpawnOptions) => ChildProcess,
  auth: string,
  resolution = '1280x720',
  signal?: AbortSignal,
): Promise<string> {
  const cookie = randomBytes(16).toString('hex');
  const authorize = (display: string) => {
    const result = spawnSync('xauth', ['-f', auth, 'add', display, '.', cookie], { stdio: 'ignore' });
    if (result.status !== 0) throw new Failure('component_failed', 'Cannot authorize X display', HINTS.display, { component: 'display' });
  };
  authorize(':0');
  const child = start(['Xvfb', '-displayfd', '3', '-screen', '0', `${resolution}x24`, '-nolisten', 'tcp', '-noreset', '-s', '0', '-auth', auth], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  const pipe = child.stdio[3] as Readable;
  let text: string;
  try {
    await waitSpawn(child);
    text = await readLine(pipe, 15000, () => {
      signal?.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null) throw new Failure('component_failed', `display exited with code ${child.exitCode ?? child.signalCode}`, HINTS.display, { component: 'display' });
    });
  } catch (error) {
    if (error instanceof Failure) throw error;
    if (error instanceof Error && error.message === 'timeout') throw new Failure('timeout', 'Xvfb did not report a display', HINTS.display, { component: 'display' });
    throw new Failure('component_failed', 'Xvfb did not report a display', HINTS.display, { component: 'display' });
  } finally {
    pipe.destroy();
  }
  if (!/^\d+$/.test(text.trim())) throw new Failure('component_failed', 'Xvfb did not allocate a display', HINTS.display, { component: 'display' });
  const display = `:${text.trim()}`;
  authorize(display);
  return display;
}

export function xQuery(env: NodeJS.ProcessEnv, ...command: string[]): string {
  try {
    return spawnSync(command[0], command.slice(1), { env, encoding: 'utf8', timeout: 5000 }).stdout ?? '';
  } catch {
    return '';
  }
}

export function displaySize(env: NodeJS.ProcessEnv): string | null {
  const match = /dimensions:\s+(\d+)x(\d+)/.exec(xQuery(env, 'xdpyinfo'));
  return match ? `${match[1]}x${match[2]}` : null;
}

export function connectHost(bind?: string | null): string | null {
  if (!bind || ['127.0.0.1', '0.0.0.0', '::'].includes(bind)) return null;
  return bind;
}

export class Session {
  readonly args: SessionArgs;
  readonly dir: string;
  readonly children = new Map<string, ChildProcess>();
  readonly logs: number[] = [];
  readonly errors = new Map<string, Error>();
  runtimeDir?: string;
  env: NodeJS.ProcessEnv = {};
  data: SessionData;

  constructor(args: SessionArgs, directory: string) {
    this.args = args;
    this.dir = directory;
    this.data = { name: args.name, state: 'starting', supervisor: identity(process.pid), logs: directory, port: args.port, components: {} };
  }

  save(changes: Record<string, unknown> = {}): void {
    Object.assign(this.data, changes);
    writeSession(this.dir, this.data);
  }

  spawn(name: string, command: string[], options: SpawnOptions = {}): ChildProcess {
    const log = openSync(join(this.dir, `${name}.log`), name === 'apps' ? 'a' : 'w', 0o600);
    this.logs.push(log);
    let child: ChildProcess;
    try {
      child = spawnCleared(command, {
        env: this.env,
        detached: true,
        windowsHide: true,
        signal: this.args.signal,
        ...options,
        stdio: ['ignore', log, log, ...((options.stdio as any[] | undefined) ?? []).slice(3)],
      });
    } catch (error) {
      closeSync(log);
      throw new Failure('component_failed', `Cannot start ${name}: ${String(error)}`, HINTS[name] ?? '', { component: name });
    }
    child.once('error', (error) => this.errors.set(name, error));
    this.children.set(name, child);
    if (child.pid) {
      this.data.components[name] = identity(child.pid);
      this.save();
    }
    return child;
  }

  failure(name: string, code: string, message: string): Failure {
    const recovery = code === 'component_failed' || code === 'timeout'
      ? { next: nextFor(sessionCommand(`logs ${name}`, this.args.name)), label: 'Read the logs' } : {};
    const hint = name === 'display' && this.data.backend === 'wayland' ? 'Read `screen-relay logs display`, then run `SCREEN_RELAY_BACKEND=wayland screen-relay doctor`.' : HINTS[name] ?? '';
    const log = tail(join(this.dir, `${name}.log`));
    const detail = name === 'engine' && attaches(this.data.backend) && code === 'component_failed' ? log.trim().replace(/\r?\n/g, '; ') : '';
    return new Failure(code, detail ? `${message}: ${detail}` : message, hint, { component: name, log, logs: this.dir }, recovery);
  }

  checkChildren(): void {
    this.args.signal?.throwIfAborted();
    for (const [name, child] of this.children) {
      const error = this.errors.get(name);
      if (error) throw this.failure(name, 'component_failed', `Cannot start ${name}: ${error.message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        const code = child.exitCode ?? -1;
        throw this.failure(name, 'component_failed', `${name} exited with code ${code}`);
      }
    }
  }

  async startBus(): Promise<void> {
    const child = this.spawn('dbus', ['dbus-daemon', '--session', '--nofork', '--print-address=3'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    await waitSpawn(child);
    try {
      const address = await readLine(child.stdio[3] as Readable, 5000, () => this.checkChildren());
      this.env.DBUS_SESSION_BUS_ADDRESS = address;
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw this.failure('dbus', error instanceof Error && error.message === 'timeout' ? 'timeout' : 'component_failed', 'Session bus did not report its address');
    }
  }

  async startWaylandDisplay(layout: string): Promise<string | null> {
    this.env.XKB_DEFAULT_LAYOUT = layout;
    if (this.args.display) {
      this.env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
      this.env.WAYLAND_DISPLAY = this.args.display;
      return null;
    }
    this.env.LANG ??= 'C.UTF-8';
    this.runtimeDir = mkdtempSync('/tmp/relay-');
    const runtimeStat = lstatSync(this.runtimeDir, { bigint: true });
    this.save({ backend: 'wayland', runtimeDir: this.runtimeDir,
      runtimeIdentity: { dev: String(runtimeStat.dev), ino: String(runtimeStat.ino), uid: String(runtimeStat.uid) } });
    this.env.XDG_RUNTIME_DIR = this.runtimeDir;
    delete this.env.DISPLAY;
    delete this.env.WAYLAND_DISPLAY;
    delete this.env.SWAYSOCK;
    delete this.env.XAUTHORITY;
    const config = join(this.dir, 'sway.conf');
    const displayFile = join(this.dir, 'wayland-display');
    writeFileSync(config, `output * mode --custom ${this.args.resolution}@${this.args.fps}Hz\nxwayland force\n`);
    writeFileSync(displayFile, '');
    const child = this.spawn('display', ['sway', '-c', config], {
      env: { ...this.env, WLR_BACKENDS: 'headless', WLR_RENDERER: 'pixman', WLR_HEADLESS_OUTPUTS: '1' },
    });
    try {
      await waitSpawn(child);
    } catch (error) {
      throw this.failure('display', 'component_failed', `Cannot start display: ${String(error)}`);
    }
    const deadline = Date.now() + 15000;
    while (!this.env.WAYLAND_DISPLAY || !this.env.SWAYSOCK) {
      this.checkChildren();
      const sockets = readdirSync(this.runtimeDir, { withFileTypes: true }).filter((entry) => entry.isSocket()).map((entry) => entry.name);
      this.env.WAYLAND_DISPLAY = sockets.find((name) => /^wayland-\d+$/.test(name));
      const swaySocket = sockets.find((name) => /^sway-ipc\.\d+\.\d+\.sock$/.test(name));
      if (swaySocket) this.env.SWAYSOCK = join(this.runtimeDir, swaySocket);
      if (this.env.WAYLAND_DISPLAY && this.env.SWAYSOCK) break;
      if (Date.now() > deadline) throw this.failure('display', 'timeout', 'Sway did not report a Wayland display');
      await sleep(200);
    }
    while (!this.env.DISPLAY) {
      this.checkChildren();
      spawnSync('swaymsg', ['exec', 'echo $DISPLAY > "$SCREEN_RELAY_SESSION/wayland-display"'], { env: this.env, stdio: 'ignore', timeout: 1000 });
      this.env.DISPLAY = readFileSync(displayFile, 'utf8').trim() || undefined;
      if (this.env.DISPLAY) break;
      if (Date.now() > deadline) throw this.failure('display', 'timeout', 'Sway did not report an XWayland display');
      await sleep(200);
    }
    return this.args.resolution;
  }

  async start(): Promise<Record<string, unknown>> {
    this.args.signal?.throwIfAborted();
    const runtime = join(this.dir, 'runtime');
    rmSync(runtime, { recursive: true, force: true });
    mkdirSync(runtime, { mode: 0o700 });
    const backend = resolveBackend(this.args.backend, this.args.display);
    const attached = attaches(backend) || Boolean(this.args.display);
    this.env = attached
      ? engineEnvironment({ ...process.env, SCREEN_RELAY_SESSION: this.dir })
      : desktopEnv(this.dir);
    if (attaches(backend)) {
      delete this.env.DISPLAY;
      delete this.env.WAYLAND_DISPLAY;
      delete this.env.XAUTHORITY;
    }
    if (backend === 'x11' && this.args.output !== undefined) {
      throw new Failure('invalid_input', '--output is only supported with the Wayland backend', 'Use --backend wayland with --output, or remove --output for X11.');
    }
    if (backend === 'wayland' && this.args.display && !process.env.XDG_RUNTIME_DIR) {
      throw new Failure('missing_input', 'XDG_RUNTIME_DIR is required to attach to a Wayland display', 'Run `export XDG_RUNTIME_DIR=/run/user/$(id -u)` if that is the compositor\'s runtime directory.');
    }
    const engine = findEngine();
    if (!engine) throw new Failure('missing_dependency', 'relay-engine not found', `Run \`${installCommand(backend)}\` first.`, { component: 'engine' });
    const needs = sessionNeeds(backend, this.args);
    const { desktop, missing, ownBus, layout } = needs;
    let desktopCommand = needs.desktopCommand;
    if (desktopCommand.length && !this.args.display && !ownBus && which('dbus-run-session')) desktopCommand = ['dbus-run-session', '--', ...desktopCommand];
    if (missing.length) throw new Failure('missing_dependency', `Missing ${missing.join(', ')}`, `Run \`${installCommand(backend)}\`, or check with \`${backend === 'wayland' ? 'SCREEN_RELAY_BACKEND=wayland ' : ''}screen-relay doctor\`.`);
    let resolution: string | null;
    if (attaches(backend)) {
      resolution = null;
    } else if (backend === 'wayland') {
      resolution = await this.startWaylandDisplay(layout);
    } else if (this.args.display) {
      this.env.DISPLAY = this.args.display;
      resolution = displaySize(this.env);
    } else {
      const auth = join(this.dir, 'Xauthority');
      writeFileSync(auth, '');
      const fd = openSync(auth, 'r+');
      fchmodSync(fd, 0o600);
      closeSync(fd);
      this.env.XAUTHORITY = auth;
      try {
        this.env.DISPLAY = await startXvfb((command, options) => this.spawn('display', command, options), auth, this.args.resolution, this.args.signal);
      } catch (error) {
        const failure = error instanceof Failure ? error : this.failure('display', 'component_failed', String(error));
        throw this.failure('display', failure.reason, failure.message);
      }
      if (layout !== 'us') {
        const result = spawnSync('setxkbmap', ['-layout', layout], { env: this.env, stdio: 'ignore' });
        if (result.status !== 0) throw this.failure('display', 'component_failed', `Cannot set keyboard layout ${layout}`);
      }
      resolution = this.args.resolution;
    }
    if (ownBus) await this.startBus();
    if (desktop === 'xfce' && !this.args.display) writeCompositing(this.env.XDG_CONFIG_HOME, compositing(this.args.compositor, this.args.fps));
    const environment: Record<string, string> = {};
    for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ICEAUTHORITY']) {
      const value = this.env[key];
      if (value) environment[key] = value;
    }
    this.save({ backend, ...(backend === 'wayland' ? { waylandDisplay: this.env.WAYLAND_DISPLAY } : {}), display: this.env.DISPLAY, xauthority: this.env.XAUTHORITY ?? null, ownsDisplay: !attached, desktop, environment, resolution, fps: this.args.fps });
    if (desktopCommand.length) await waitSpawn(this.spawn('desktop', desktopCommand));
    const bind = this.args.bind || '127.0.0.1';
    let token: string | null = null;
    const engineCommand = [engine, '--bind', bind, '--port', String(this.args.port), '--fps', String(this.args.fps), '--bitrate-min', String(this.args.bitrateMin), '--bitrate-start', String(this.args.bitrateStart), '--bitrate-max', String(this.args.bitrateMax)];
    engineCommand.push('--backend', backend);
    const viewer = join(LAUNCHER_DIR, '..', 'viewer');
    if (!existsSync(join(dirname(engine), 'viewer')) && existsSync(join(viewer, 'viewer.js'))) engineCommand.push('--viewer-dir', viewer);
    if (this.args.output) engineCommand.push('--output', this.args.output);
    if (bind !== '127.0.0.1' || this.args.public || this.args['allow-origin'] || attaches(backend)) {
      token = randomBytes(32).toString('hex');
      const tokenFile = join(this.dir, 'token');
      const descriptor = openSync(tokenFile, 'w', 0o600);
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${token}\n`);
      closeSync(descriptor);
      engineCommand.push('--token-file', tokenFile);
      this.data.tokenFile = tokenFile;
    }
    if (this.args.public) engineCommand.push('--public-origin', this.args.public);
    if (this.args['allow-origin']) engineCommand.push('--allow-origin', this.args['allow-origin']);
    if (this.args['tls-cert']) {
      const absolute = (file: string) => (process.platform === 'win32' && file ? resolve(file) : file);
      engineCommand.push('--tls-cert', absolute(this.args['tls-cert']), '--tls-key', absolute(this.args['tls-key'] ?? ''));
    }
    else if (this.args.public) engineCommand.push('--behind-tls-proxy');
    const scheme = this.args['tls-cert'] ? 'https' : 'http';
    const localUrl = `${scheme}://127.0.0.1:${this.args.port}`;
    this.save({ bind, localUrl, url: this.args.public || localUrl, tlsCert: this.args['tls-cert'] ? resolve(String(this.args['tls-cert'])) : null });
    const engineChild = this.spawn('engine', engineCommand, { cwd: engineWorkingDirectory(engine) });
    await waitSpawn(engineChild);
    await this.waitReady(engineChild.pid!, { url: localUrl, token, certificate: this.data.tlsCert, connect: connectHost(bind) }, desktop);
    this.save({ state: 'ready', ready: Date.now() / 1000 });
    const url = this.data.url as string;
    return {
      ready: true, name: this.args.name, url, viewer: token ? `${url}/#token=${token}` : url,
      token, display: this.env.DISPLAY, ...(backend === 'wayland' ? { waylandDisplay: this.env.WAYLAND_DISPLAY } : {}), xauthority: this.env.XAUTHORITY ?? null, logs: this.dir,
      pid: process.pid, enginePid: engineChild.pid, bind, port: this.args.port, public: Boolean(this.args.public),
      resolution: this.data.resolution, fps: this.args.fps,
    };
  }

  async engineReady(pid: number, where: EngineTarget): Promise<boolean> {
    for (const line of tail(join(this.dir, 'engine.log'), 50).split(/\r?\n/)) {
      if (!line.startsWith('{')) continue;
      try {
        const message = JSON.parse(line);
        if (message.ready === true && message.pid === pid) {
          const client = createClient({
            url: where.url, token: where.token ?? undefined, certificate: where.certificate ?? undefined, connect: where.connect ?? undefined, timeout: 3000, signal: this.args.signal,
          });
          const image = Buffer.from(await client.screenshot());
          if (!image.subarray(0, 8).equals(PNG)) return false;
          if (this.args.display || attaches(this.data.backend)) {
            if (image.length < 24) return false;
            let resolution = `${image.readUInt32BE(16)}x${image.readUInt32BE(20)}`;
            try {
              const caps = await client.capabilities();
              if (Number.isInteger(caps.width) && caps.width > 0 && Number.isInteger(caps.height) && caps.height > 0) {
                resolution = `${caps.width}x${caps.height}`;
              }
            } catch {}
            this.save({ resolution });
          }
          return true;
        }
      } catch {}
    }
    return false;
  }

  desktopReady(desktop: string): boolean {
    if (this.data.backend === 'wayland') {
      if (this.args.display) return true;
      try {
        const tree = JSON.parse(xQuery(this.env, 'swaymsg', '-t', 'get_tree', '-r'));
        const hasWindow = (node: any): boolean => Boolean(node.shell || node.app_id || node.window || [...(node.nodes ?? []), ...(node.floating_nodes ?? [])].some(hasWindow));
        return hasWindow(tree);
      } catch {
        return false;
      }
    }
    if (desktop === 'xfce') return (xQuery(this.env, 'xprop', '-root', '_NET_SUPPORTING_WM_CHECK', '_NET_CLIENT_LIST').match(/window id # 0x/g) ?? []).length >= 2;
    const match = /(\d+) child/.exec(xQuery(this.env, 'xwininfo', '-root', '-children'));
    return Boolean(match && Number(match[1]) > 0);
  }

  async waitReady(pid: number, where: EngineTarget, desktop: string): Promise<void> {
    const deadline = Date.now() + (this.args.timeout ?? 30) * 1000;
    const pending = ['engine', ...(desktop !== 'none' ? ['desktop'] : [])];
    while (pending.length) {
      this.args.signal?.throwIfAborted();
      this.checkChildren();
      const ready = pending[0] === 'engine' ? await this.engineReady(pid, where) : this.desktopReady(desktop);
      if (ready) pending.shift();
      else if (Date.now() > deadline) throw this.failure(pending[0], 'timeout', `${pending[0]} not ready after ${this.args.timeout ?? 30}s`);
      else await sleep(200);
    }
  }

  async supervise(shouldStop: () => boolean): Promise<void> {
    while (!shouldStop()) {
      this.checkChildren();
      await sleep(200);
    }
  }

  async cleanup(): Promise<void> {
    const engine = this.children.get('engine');
    if (engine && engine.exitCode === null) {
      engine.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => engine.once('exit', resolve)), sleep(3000)]);
    }
    const processes = [...this.children.values()].reverse();
    for (const child of processes) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    for (const child of processes) {
      if (!child.pid) continue;
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = await Promise.race([new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))), sleep(3000).then(() => false)]);
      if (!exited && child.exitCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
    await sweep(this.dir);
    if (this.runtimeDir) {
      cleanupWaylandRuntime(this.data);
      delete this.env.XDG_RUNTIME_DIR;
      delete this.env.WAYLAND_DISPLAY;
      delete this.env.SWAYSOCK;
      if (!this.data.runtimeDir) this.runtimeDir = undefined;
    }
    for (const fd of this.logs) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function desktopEnv(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: join(directory, 'runtime'),
    XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_CACHE_HOME: join(directory, 'cache'),
    ICEAUTHORITY: join(directory, 'ICEauthority'),
    SCREEN_RELAY_SESSION: directory,
  };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  return env;
}

/** Whether screen-relay's own XFCE desktop runs its compositor: `on` or `off` as set, otherwise on only up to 60 fps, because the compositor repaints at most 60 times a second. */
export function compositing(setting: string | undefined, fps: number): boolean {
  return setting === 'on' || (setting !== 'off' && fps <= 60);
}

/** Sets the xfwm4 compositor on or off in a session's own config dir. Other saved xfwm4 settings are kept. */
export function writeCompositing(configHome: string | undefined, enabled: boolean): void {
  if (!configHome) return;
  const dir = join(configHome, 'xfce4', 'xfconf', 'xfce-perchannel-xml');
  const file = join(dir, 'xfwm4.xml');
  const wanted = `<property name="use_compositing" type="bool" value="${enabled}"/>`;
  const general = `  <property name="general" type="empty">\n    ${wanted}\n  </property>\n`;
  let saved = '';
  try { saved = readFileSync(file, 'utf8'); } catch {}
  const setting = /<property name="use_compositing"[^>]*\/>/;
  const group = /<property name="general" type="empty">/;
  const next = setting.test(saved) ? saved.replace(setting, wanted)
    : group.test(saved) ? saved.replace(group, (open) => `${open}\n    ${wanted}`)
    : saved.includes('</channel>') ? saved.replace('</channel>', `${general}</channel>`)
    : `<?xml version="1.0" encoding="UTF-8"?>\n<channel name="xfwm4" version="1.0">\n${general}</channel>\n`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, next);
}

/** Finds the engine beside the CLI, then the one built for this CLI version, then one on PATH. */
export function findEngine(): string | null {
  const name = process.platform === 'win32' ? 'relay-engine.exe' : 'relay-engine';
  for (const candidate of [join(LAUNCHER_DIR, name), join(LAUNCHER_DIR, '..', name), join(engineDirectory(), name)]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return which(name) ?? null;
}

/** Whether a backend attaches to a real desktop instead of starting one. */
export function attaches(backend: string | undefined): boolean {
  return backend === 'macos' || backend === 'windows';
}

/** Backends the engine reports it was built with; empty when there is no engine. */
export function compiledBackends(engine: string | null = findEngine()): string[] {
  const compiled = engine ? /^Compiled backends: (.+)$/m.exec(run([engine, '--help'], { env: engineEnvironment(), cwd: engineWorkingDirectory(engine) }).stdout ?? '')?.[1] : undefined;
  return compiled ? compiled.split(', ') : [];
}

/** The command that sets this machine up for a backend. */
export function installCommand(backend: string): string {
  return `screen-relay install${backend === 'wayland' ? ' --backend wayland' : ''}`;
}

/** Resolves the desktop for a session and lists the programs it needs that are not installed. */
export function sessionNeeds(backend: (typeof BACKENDS)[number], args: { display?: string; desktop?: string; keyboardLayout?: string }) {
  const desktop = attaches(backend) ? 'none' : args.desktop || (args.display ? 'none' : backend === 'wayland' ? 'foot' : 'xfce');
  const desktopCommand = desktop === 'xfce' ? ['xfce4-session'] : desktop === 'none' ? [] : splitCommand(desktop);
  const layout = args.keyboardLayout ?? 'us';
  const needed = attaches(backend) ? [] : backend === 'wayland'
    ? ['setpriv', ...(args.display ? [] : BACKEND_PROGRAMS.wayland.filter((program) => program !== 'foot')), ...(desktopCommand.length ? [desktopCommand[0]] : [])]
    : ['setpriv', ...(args.display ? [] : ['Xvfb', 'xauth']), ...(desktopCommand.length ? ['xprop', 'xwininfo', desktopCommand[0]] : []), ...(!args.display && layout !== 'us' ? ['setxkbmap'] : [])];
  const missing = needed.filter((program) => !which(program));
  const ownBus = Boolean(desktopCommand.length && !args.display && which('dbus-daemon'));
  if (desktop === 'xfce' && !args.display && !ownBus && !which('dbus-run-session')) missing.push('dbus-run-session');
  return { desktop, desktopCommand, layout, missing, ownBus };
}

/** The backend the caller asked for, by flag or by the shape of --display; undefined when neither says. */
export function requestedBackend(explicit: string | undefined, display?: string): (typeof BACKENDS)[number] | undefined {
  const requested = explicit !== undefined ? backendValue(explicit, 'SCREEN_RELAY_BACKEND')
    : process.platform === 'darwin' ? 'macos'
    : process.platform === 'win32' ? 'windows'
    : display !== undefined && !display.includes(':') ? 'wayland' : undefined;
  const owner = requested === 'macos' ? 'darwin' : requested === 'windows' ? 'win32' : 'linux';
  if (requested && !process.platform.startsWith(owner)) {
    throw new Failure('invalid_input', `The ${requested} backend is only supported on ${requested === 'macos' ? 'macOS' : requested === 'windows' ? 'Windows' : 'Linux'}`,
      process.platform === 'darwin' ? 'Use --backend macos on macOS.' : process.platform === 'win32' ? 'Use --backend windows on Windows.' : 'Use --backend x11 or --backend wayland on Linux.');
  }
  if (requested === 'x11' && display !== undefined && !display.includes(':')) {
    throw new Failure('invalid_input', `${display} is a Wayland socket, not an X display`, `Run \`screen-relay up -d --backend wayland --display ${display}\``);
  }
  if (requested === 'wayland' && display !== undefined && display.includes(':')) {
    throw new Failure('invalid_input', `${display} is an X display, not a Wayland socket`, `Run \`screen-relay up -d --backend x11 --display ${display}\``);
  }
  return requested;
}

/** Selects a backend for the platform and checks the engine's compiled backends. */
export function resolveBackend(explicit: string | undefined, display?: string): (typeof BACKENDS)[number] {
  const requested = requestedBackend(explicit, display);
  const available = compiledBackends();
  const backend = requested ?? (!available.length || available.includes('x11') ? 'x11' : 'wayland');
  if (available.length && !available.includes(backend)) {
    const hint = backend === 'macos' ? 'Rebuild relay-engine with the macos backend.'
      : backend === 'windows' ? 'Run `screen-relay install`.' : `Run \`screen-relay install --backend ${backend}\``;
    throw new Failure('missing_dependency', `relay-engine was built without the ${backend} backend (compiled: ${available.join(', ')})`, hint);
  }
  return backend;
}

export function splitCommand(value: string): string[] {
  const result: string[] = [];
  let token = '';
  let started = false;
  let quote = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) { token += char; started = true; escaped = false; }
    else if (char === '\\' && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = ''; else token += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) result.push(token); token = ''; started = false; }
    else { token += char; started = true; }
  }
  if (escaped) token += '\\';
  if (quote) throw new Failure('invalid_input', 'Invalid desktop command quoting', 'Check --desktop.');
  if (started) result.push(token);
  return result;
}
