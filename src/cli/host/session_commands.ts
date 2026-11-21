import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '../../sdk/index.js';
import { clientFailure, cmdRemoteStatus } from '../client.js';
import { applyTo, loadConfig } from '../config.js';
import { emit, Failure, formatReady, formatStarted, formatStatus, formatStopped, nextStep, printNext, printWarning, sessionCommand } from '../output.js';
import { COMPONENTS, HostArgs, requireHost, spawnCleared, which } from './common.js';
import { alive, cleanupWaylandRuntime, lock, readSession, reap, stateDir, tail, writePrivateFile, writeSession } from './state.js';
import { ensureSetup } from './setup.js';
import { attaches, connectHost, desktopEnv, Session } from './supervisor.js';
import { startWatcher } from './watcher.js';
import { killTree } from './windows.js';

export { COMPONENTS };

type Args = HostArgs & Record<string, any>;

async function reapSession(directory: string, session: Record<string, any> | null, signal?: AbortSignal): Promise<boolean> {
  await reap(directory, session, signal);
  return cleanupWaylandRuntime(session);
}

/** Removes sensitive --ice-server flags from a detached supervisor's argv and returns the environment it starts with. */
export function detachedSupervisorSpawn(argv: string[], env: NodeJS.ProcessEnv, iceServersFile?: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') {
      args.push(...argv.slice(index));
      break;
    }
    if (token === '--ice-server') {
      if (index + 1 < argv.length) index++;
      continue;
    }
    if (token.startsWith('--ice-server=')) continue;
    args.push(token);
  }
  const childEnv: NodeJS.ProcessEnv = { ...env, SCREEN_RELAY_READY_FD: '3' };
  delete childEnv.SCREEN_RELAY_ICE_SERVERS;
  if (iceServersFile) childEnv.SCREEN_RELAY_ICE_SERVERS_FILE = iceServersFile;
  return { args, env: childEnv };
}

export async function cmdUp(args: Args): Promise<number> {
  requireHost();
  const attachedHost = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : undefined;
  if (attachedHost && args.display !== undefined) {
    throw new Failure('invalid_input', `--display is not supported on ${attachedHost}`, `Remove --display; screen-relay attaches to the current display on ${attachedHost}.`);
  }
  const [settings, , present] = loadConfig(typeof args.config === 'string' && args.config ? args.config : undefined);
  const warnings = (args.display || attachedHost) && present.has('display.resolution')
    ? [{ reason: 'display_resolution_ignored', message: attachedHost
      ? `display.resolution is ignored on ${attachedHost}; the existing display size is used`
      : 'display.resolution is ignored with --display; the existing display size is used' }] : [];
  for (const warning of warnings) printWarning(warning.message, args);
  applyTo(args, settings, present);
  delete process.env.SCREEN_RELAY_ICE_SERVERS;
  const port = Number(args.port ?? 8080);
  const timeout = Number(args.timeout ?? 30);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Failure('invalid_input', 'Port must be between 1 and 65535', 'Run `screen-relay up --help`.');
  if (args.public && !/^https:\/\/[^/?#@\\\s]+$/.test(String(args.public))) {
    throw new Failure('invalid_input', '--public must be an HTTPS origin like https://desk.example.com', 'No path, query or credentials.');
  }
  if (Boolean(args['tls-cert']) !== Boolean(args['tls-key'])) throw new Failure('invalid_input', '--tls-cert and --tls-key go together', 'Run `screen-relay up --help`.');
  const directory = stateDir(args.name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const readyFd = Number(process.env.SCREEN_RELAY_READY_FD ?? -1);
  delete process.env.SCREEN_RELAY_READY_FD;
  const preparedIceServersFile = process.env.SCREEN_RELAY_ICE_SERVERS_FILE;
  delete process.env.SCREEN_RELAY_ICE_SERVERS_FILE;
  const chosen = readyFd < 0 ? await ensureSetup(args) : [];
  if (args.detach && readyFd < 0) return detach(args, directory, timeout, warnings, chosen);
  let pipeFd = readyFd;
  const report = (data: unknown): boolean => {
    if (pipeFd < 0) return false;
    try { writeFileSync(pipeFd, `${JSON.stringify(data)}\n`); } finally { closeSync(pipeFd); pipeFd = -1; }
    return true;
  };
  const signal = args.signal as AbortSignal | undefined;
  let held: Awaited<ReturnType<typeof lock>> | undefined;
  let session: Session | undefined;
  let ready: Record<string, unknown> | undefined;
  let final: Record<string, unknown> = { state: 'stopped' };
  try {
    try { held = await lock(args.name, directory); }
    catch (error) {
      if (error instanceof Failure) report({ error: error.payload() });
      throw error;
    }
    await reapSession(directory, readSession(args.name));
    if (preparedIceServersFile) args['ice-servers-file'] = preparedIceServersFile;
    session = new Session({
      ...args,
      port,
      timeout,
      resolution: String(args.resolution),
      fps: Number(args.fps),
      bitrateMin: Number(args.bitrateMin),
      bitrateStart: Number(args.bitrateStart),
      bitrateMax: Number(args.bitrateMax),
      keyboardLayout: String(args.keyboardLayout ?? 'us'),
    }, directory);
    session.save();
    const info = await session.start();
    if (!report(info)) {
      if (args.json) ready = info;
      else emit(args, { session: info, outcome: 'started' }, formatReady(info, args), { identifier: String(info.viewer) });
    }
    await session.supervise(() => Boolean(signal?.aborted));
  } catch (error) {
    if (signal?.aborted) return 130;
    const failure = error instanceof Failure ? error : new Failure('internal', `${error instanceof Error ? error.name : 'Error'}: ${String(error)}`, 'Run `screen-relay doctor`.', { logs: directory });
    final = { state: 'failed', error: failure.payload() };
    report({ error: failure.payload() });
    throw failure;
  } finally {
    if (session) {
      await session.cleanup();
      session.save({ stopped: Date.now() / 1000, ...final });
    }
    await held?.close();
  }
  if (ready && !signal?.aborted) emit(args, { session: ready, outcome: 'started', ...(warnings.length ? { warnings } : {}) }, '');
  return signal?.aborted ? 130 : 0;
}

async function detach(args: Args, directory: string, timeout: number, warnings: Array<{ reason: string; message: string }>, chosen: string[]): Promise<number> {
  const probe = await lock(args.name, directory);
  await probe.close();
  const logPath = join(directory, 'supervisor.log');
  const log = openSync(logPath, 'w', 0o600);
  const iceServers: string[] = Array.isArray(args['ice-server']) ? args['ice-server'] : [];
  const iceServersFile = join(directory, 'ice-servers');
  if (iceServers.length) writePrivateFile(iceServersFile, `${iceServers.join('\n')}\n`);
  else rmSync(iceServersFile, { force: true });
  const detached = detachedSupervisorSpawn(process.argv.slice(2), process.env, iceServers.length ? iceServersFile : undefined);
  const child = spawn(process.execPath, [process.argv[1] ?? '', ...detached.args, ...chosen], {
    cwd: process.cwd(), env: detached.env, detached: true, windowsHide: true,
    stdio: ['ignore', log, log, 'pipe'],
  });
  const signal = args.signal as AbortSignal | undefined;
  const stopChild = () => {
    if (process.platform !== 'win32') child.kill('SIGTERM');
    else if (child.pid !== undefined) killTree(child.pid);
  };
  signal?.addEventListener('abort', stopChild, { once: true });
  if (signal?.aborted) stopChild();
  closeSync(log);
  const stream = child.stdio[3] as Readable;
  let data = '';
  const result = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(data), (timeout + 30) * 1000);
    stream.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    stream.once('end', () => { clearTimeout(timer); resolve(data); });
    child.once('exit', () => { clearTimeout(timer); resolve(data); });
    child.once('error', () => { clearTimeout(timer); resolve(data); });
  });
  signal?.removeEventListener('abort', stopChild);
  if (signal?.aborted) throw new Failure('canceled', 'Session startup canceled.');
  if (!result) {
    if (child.exitCode === null) {
      stopChild();
      throw new Failure('timeout', 'Background supervisor did not report readiness in time', `See ${logPath}.`, { component: 'supervisor', log: tail(logPath), logs: directory });
    }
    throw new Failure('component_failed', 'Background supervisor exited before it was ready', `See ${logPath}.`, { component: 'supervisor', log: tail(logPath), logs: directory });
  }
  const payload = JSON.parse(result.trim().split(/\r?\n/).at(-1) ?? '{}');
  if (payload.error) {
    const { reason, message, hint, ...extra } = payload.error;
    throw new Failure(reason, message, hint ?? '', extra);
  }
  emit(args, { session: payload, outcome: 'started', ...(warnings.length ? { warnings } : {}) }, formatReady(payload, args, true), { identifier: String(payload.viewer) });
  child.unref();
  stream.destroy();
  return 0;
}

export async function cmdDown(args: Args): Promise<number> {
  requireHost();
  args.signal?.throwIfAborted();
  const directory = stateDir(args.name);
  let session = readSession(args.name);
  const supervisor = session?.supervisor;
  const running = alive(supervisor);
  if (running) {
    if (process.platform === 'win32') killTree(supervisor.pid);
    else process.kill(supervisor.pid, 'SIGTERM');
    const deadline = Date.now() + 20000;
    while (alive(supervisor) && Date.now() < deadline) await delay(100, undefined, { signal: args.signal });
    args.signal?.throwIfAborted();
    if (alive(supervisor) && process.platform !== 'win32') {
      process.kill(supervisor.pid, 'SIGKILL');
      while (alive(supervisor)) await delay(50, undefined, { signal: args.signal });
    }
    if (alive(supervisor) && process.platform === 'win32') {
      throw new Failure('timeout', `Session "${args.name}" did not stop`, 'Run `' + sessionCommand('down', args.name) + '` again from a terminal with the same rights as the one that started the session.');
    }
  }
  if (session) {
    let held: Awaited<ReturnType<typeof lock>> | undefined;
    try { held = await lock(args.name, directory); } catch {}
    if (held) {
      try {
        session = readSession(args.name);
        if (JSON.stringify(session?.supervisor) === JSON.stringify(supervisor)) {
          const cleared = await reapSession(directory, session, args.signal);
          if (session) {
            const stopping = ['starting', 'ready'].includes(session.state);
            if (stopping) Object.assign(session, { state: 'stopped', stopped: Date.now() / 1000 });
            if (cleared || stopping) writeSession(directory, session);
          }
        }
      } finally { await held.close(); }
    }
  }
  try { rmSync(join(directory, 'ice-servers'), { force: true }); } catch {}
  args.signal?.throwIfAborted();
  emit(args, { session: { name: args.name, state: 'stopped' }, outcome: running ? 'stopped' : 'unchanged' },
    formatStopped(args.name, running, args) + '\n' + nextStep('Start it', sessionCommand('up -d', args.name), args), {});
  return 0;
}

export async function cmdStatus(args: Args): Promise<number> {
  if (args.url || process.env.SCREEN_RELAY_URL) return cmdRemoteStatus(args);
  const session = readSession(args.name);
  if (!session) throw new Failure('not_running', `No session named "${args.name}"`, 'Start one with `screen-relay up -d`.');
  const running = alive(session.supervisor);
  if (['starting', 'ready'].includes(session.state) && !running) session.state = 'failed';
  delete session.components;
  delete session.runtimeIdentity;
  session.running = running && session.state === 'ready';
  if (!args['show-token']) delete session.token;
  if (args['show-token'] && session.tokenFile && running) session.token = readFileSync(session.tokenFile, 'utf8').trim();
  if (session.running) {
    try {
      let token: string | null = null;
      if (session.tokenFile) token = readFileSync(session.tokenFile, 'utf8').trim();
      const timeout = Number(args.timeout ?? 10);
      session.capabilities = await createClient({
        url: session.localUrl, token: token ?? undefined, certificate: session.tlsCert ?? undefined, connect: connectHost(session.bind) ?? undefined, timeout: timeout * 1000, signal: args.signal,
      }).capabilities();
    } catch (error) {
      session.health = clientFailure(error, { url: String(session.localUrl), timeout: Number(args.timeout ?? 10), explicit: false }).payload();
    }
  }
  args.signal?.throwIfAborted();
  emit(args, { session }, formatStatus(args.name, session, args));
  printNext(args, session.running ? 'Read the engine log' : 'Start it', sessionCommand(session.running ? 'logs engine' : 'up -d', args.name));
  return 0;
}

export async function cmdLogs(args: Args): Promise<number> {
  const directory = stateDir(args.name);
  const components = args.component ? [String(args.component)] : COMPONENTS;
  const files = components.map((component) => join(directory, `${component}.log`)).filter(existsSync);
  if (!files.length) throw new Failure('not_running', `No logs for "${args.name}"`, 'Start a session with `screen-relay up`.');
  if (args.json) {
    if (args.follow) throw new Failure('invalid_input', '--follow cannot be combined with --json', 'Run `screen-relay logs --help`.');
    emit(args, { logs: Object.fromEntries(files.map((file) => [basename(file, '.log'), tail(file, 200)])) }, '');
    return 0;
  }
  if (process.platform === 'win32') return printWindowsLogs(files, args);
  const child = spawn('tail', ['-n', '200', ...(args.follow ? ['-F'] : []), ...files], { stdio: 'inherit', signal: args.signal });
  return await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

/** Prints the last 200 lines of each log, then follows them by polling when --follow is set. Stops when the signal aborts. */
async function printWindowsLogs(files: string[], args: Args): Promise<number> {
  const offsets = new Map<string, number>();
  files.forEach((file, index) => {
    if (files.length > 1) process.stdout.write(`${index ? '\n' : ''}==> ${file} <==\n`);
    const text = tail(file, 201).replace(/\r?\n$/, '');
    if (text) process.stdout.write(`${text.split(/\r?\n/).slice(-200).join('\n')}\n`);
    offsets.set(file, statSync(file).size);
  });
  if (!args.follow) return 0;
  for (;;) {
    await delay(200, undefined, { signal: args.signal });
    for (const file of files) {
      const size = statSync(file).size;
      const previous = offsets.get(file) ?? 0;
      const from = size < previous ? 0 : previous;
      if (size > from) {
        const descriptor = openSync(file, 'r');
        try {
          const buffer = Buffer.alloc(size - from);
          readSync(descriptor, buffer, 0, buffer.length, from);
          process.stdout.write(buffer);
        } finally {
          closeSync(descriptor);
        }
      }
      offsets.set(file, size);
    }
  }
}

export async function cmdRun(args: Args): Promise<number> {
  requireHost();
  if (args.restart && process.platform === 'win32') throw new Failure('invalid_input', '--restart is not supported on Windows', 'Remove --restart and run the app again.');
  const rest = args.args === undefined ? [] : Array.isArray(args.args) ? args.args : [args.args];
  const command = [args.app, ...rest].filter((value) => value !== undefined).map(String);
  if (!command.length) throw new Failure('missing_command', 'Name the app to start', 'Run `screen-relay run --help`.');
  const found = which(command[0]);
  if (!found) throw new Failure('spawn_failed', `${command[0]} was not found`, 'Install it or check the name, then run the command again.');
  const spawned = process.platform === 'win32' ? [found, ...command.slice(1)] : command;
  const session = readSession(args.name);
  if (!session || session.state !== 'ready' || !alive(session.supervisor)) throw new Failure('not_found', `No running session named "${args.name}"`, 'Start one with `screen-relay up -d`.');
  const directory = stateDir(args.name);
  const env = session.ownsDisplay === false
    ? { ...process.env, ...(attaches(session.backend) ? session.environment ?? {} : {}), SCREEN_RELAY_SESSION: directory }
    : { ...desktopEnv(directory), ...(session.environment ?? {}) };
  if (attaches(session.backend)) {
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    delete env.XAUTHORITY;
  } else {
    env.DISPLAY = session.display;
    const runtimeDir = session.runtimeDir ?? (session.waylandDisplay ? session.environment?.XDG_RUNTIME_DIR : undefined);
    if (runtimeDir) env.XDG_RUNTIME_DIR = runtimeDir;
    if (session.waylandDisplay) env.WAYLAND_DISPLAY = session.waylandDisplay;
    if (session.xauthority) env.XAUTHORITY = session.xauthority;
  }
  const path = join(directory, 'apps.log');
  const log = openSync(path, 'a', 0o600);
  let pid: number;
  try {
    args.signal?.throwIfAborted();
    if (args.restart || session.backend === 'macos') {
      const started = await startWatcher(command, env, log, args.signal, Boolean(args.restart));
      if (started.exited) throw new Failure('component_failed', `${command[0]} exited with code ${started.exited}`, 'Read `screen-relay logs apps`.', { component: 'apps', log: tail(path) });
      pid = started.pid;
    } else {
      const child = spawnCleared(spawned, { cwd: homedir(), env, stdio: ['ignore', log, log], detached: true, signal: args.signal });
      await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
      pid = child.pid!;
      const earlyExit = child.exitCode !== null ? child.exitCode : child.signalCode !== null ? 1 : await Promise.race([
        new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code ?? 1))),
        delay(1000).then(() => null),
      ]);
      if (earlyExit) throw new Failure('component_failed', `${command[0]} exited with code ${earlyExit}`, 'Read `screen-relay logs apps`.', { component: 'apps', log: tail(path) });
      child.unref();
    }
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure('spawn_failed', `Cannot start ${command[0]}: ${error instanceof Error ? error.message : String(error)}`, 'Read `screen-relay logs apps`.');
  } finally {
    closeSync(log);
  }
  emit(args, { app: { pid, command }, outcome: 'started' },
    formatStarted(command[0], pid, session.backend === 'macos' ? 'macOS' : session.backend === 'windows' ? 'Windows' : session.display, path, args) + '\n' + nextStep('Read app output', sessionCommand('logs apps', args.name), args), { identifier: String(pid) });
  return 0;
}
