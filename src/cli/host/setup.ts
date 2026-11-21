import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { confirm, isCancel, select } from '@clack/prompts';
import { BACKENDS, loadConfig } from '../config.js';
import { interactive } from '../mode.js';
import { count, duration, emit, Failure, nextStep, printWarning, quote, receipt, row } from '../output.js';
import { theme } from '../theme.js';
import { engineDirectory, isLinux, LAUNCHER_DIR, requireHost, run, which, type HostArgs } from './common.js';
import { detectFamily, groupPackages, installCommand, packagesFor, provides } from './packages.js';
import { claimLock, lockOwnerAlive } from './state.js';
import { compiledBackends, findEngine, requestedBackend, sessionNeeds } from './supervisor.js';
import { createPrivateMsys2Root, MSYS2_PATH, MSYS2_ROOT, msys2Failure, msys2Installation, msys2Libraries, msys2Shell, wingetPath } from './windows.js';

type Backend = (typeof BACKENDS)[number];
type Args = HostArgs & Record<string, any>;
type Request = { backends: Backend[]; display?: string; desktop?: string; keyboardLayout?: string };
type Plan = { state: 'ready' | 'needs-build' | 'needs-packages'; backends: Backend[]; build: boolean; groups: string[] };

const SOURCE = resolve(LAUNCHER_DIR, '..', '..');
const BREW_PACKAGES = ['pkgconf', 'x264', 'libwebsockets'];
const MSYS2_PACKAGES = ['make', 'diffutils', 'mingw-w64-ucrt-x86_64-gcc', 'mingw-w64-ucrt-x86_64-pkgconf', 'mingw-w64-ucrt-x86_64-libwebsockets', 'mingw-w64-ucrt-x86_64-x264'];
const WINGET_MSYS2 = ['install', '--id', 'MSYS2.MSYS2', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'];
const OPTIONAL_APT = ['glycin-loaders', 'gdk-pixbuf-bin'];

/** The environment for MSYS2's shell, which selects the UCRT64 toolchain. */
function msysEnv(): NodeJS.ProcessEnv {
  return { ...process.env, MSYSTEM: 'UCRT64', CHERE_INVOKING: '1' };
}

/** The command to hand MSYS2's shell, with PATH set to the directories setup checks so a login profile cannot add one it does not. */
function msysCommand(command: string): string {
  return `export PATH=${MSYS2_PATH}; ${command}`;
}

/** A path as MSYS2's shell reads it: forward slashes on Windows, since its shell treats backslashes as escapes. */
function shellPath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
}

/** Whether make and every library the engine links are present for these backends. */
function buildable(backends: Backend[]): boolean {
  if (!existsSync(join(SOURCE, 'Makefile'))) return false;
  if (process.platform !== 'win32') return run(['make', '-s', '-C', SOURCE, `BACKENDS=${backends.join(' ')}`, 'deps']).status === 0;
  const installation = msys2Installation();
  if (installation.state !== 'trusted') return false;
  return run([installation.shell, '-lc', msysCommand(`make -s -C ${quote(shellPath(SOURCE))} BACKENDS=${quote(backends.join(' '))} deps`)], { env: msysEnv() }).status === 0;
}

/** Decides what this machine still needs before it can run the requested backends. The engine is built with every compiled backend, but the desktop packages follow only the requested ones. */
export function planSetup(request: Request): Plan {
  const compiled = compiledBackends();
  const build = request.backends.some((backend) => !compiled.includes(backend));
  const backends = BACKENDS.filter((backend) => compiled.includes(backend) || request.backends.includes(backend));
  const programs = request.backends.flatMap((backend) => sessionNeeds(backend, request).missing)
    .filter((program) => provides(program === 'swaymsg' ? 'sway' : program));
  const untrusted = process.platform === 'win32' && msys2Libraries().state === 'untrusted';
  const packages = programs.length > 0 || untrusted || (build && !buildable(backends));
  const xfce = request.backends.includes('x11') && sessionNeeds('x11', request).desktop === 'xfce';
  const groups = ['core', ...backends, ...(xfce ? ['xfce'] : [])];
  return { state: packages ? 'needs-packages' : build ? 'needs-build' : 'ready', backends, build, groups };
}

/** Runs a shell command, or argv directly, and reports how long it took; on Windows the shell is MSYS2's. With --json it prints nothing, and a step that is not required only warns when it fails. */
async function step(title: string, done: string, command: string, args: Args, required = true, argv?: string[]): Promise<void> {
  const style = theme(args);
  const started = Date.now();
  const quiet = Boolean(args.json);
  if (!quiet) process.stderr.write(`${style.strong(title)}\n${style.muted(`  ${command}`)}\n`);
  let output = '';
  const msys = process.platform === 'win32' && !argv;
  const [program, ...programArgs] = argv ?? (msys ? [msys2Shell(), '-lc', msysCommand(command)] : ['sh', '-c', command]);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(program, programArgs, { stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['inherit', 2, 2], env: msys ? msysEnv() : process.env, signal: args.signal });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16000); });
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  if (code !== 0) {
    if (required) {
      throw new Failure('missing_dependency', `${title} failed`, 'Fix the cause, then run `screen-relay install` again.',
        quiet ? { command, log: output.trim().split('\n').slice(-40).join('\n') } : {});
    }
    printWarning(`${title} reported errors; continuing`, args);
    return;
  }
  if (!quiet) process.stderr.write(`${style.success ? `${style.success} ` : ''}${done} (${duration((Date.now() - started) / 1000)})\n`);
}

/** The sudo prefix for package commands: none as root, a prompting sudo at a terminal, otherwise passwordless sudo. */
function elevation(prompt: boolean): string {
  if (process.getuid?.() === 0) return '';
  if (!which('sudo')) throw new Failure('forbidden', 'Installing system packages needs root or sudo', 'Run this as root.');
  if (prompt) return 'sudo ';
  if (run(['sudo', '-n', 'true']).status !== 0) {
    throw new Failure('forbidden', 'Installing system packages needs root or passwordless sudo', 'Run this as root, or at a terminal where sudo can ask for your password.');
  }
  return 'sudo -n ';
}

/** Names the package manager and the packages in the plan's groups for this machine, and returns the work that installs them. */
function packageWork(groups: string[], args: Args): { manager: string; packages: string[]; run: () => Promise<void> } {
  if (process.platform === 'darwin') {
    if (!which('brew')) {
      throw new Failure('missing_dependency', 'Homebrew is not installed', `Install it from https://brew.sh, or install ${BREW_PACKAGES.join(', ')} yourself. Then run screen-relay install again.`);
    }
    return { manager: 'brew', packages: BREW_PACKAGES, run: () => step('Installing Homebrew packages', 'Installed Homebrew packages', `brew install ${BREW_PACKAGES.join(' ')}`, args) };
  }
  if (process.platform === 'win32') {
    const installation = msys2Installation();
    return {
      manager: 'MSYS2 pacman',
      packages: installation.state === 'trusted' ? MSYS2_PACKAGES : ['MSYS2', ...MSYS2_PACKAGES],
      run: async () => {
        if (installation.state === 'untrusted') throw msys2Failure(installation);
        if (installation.state === 'missing') {
          if (existsSync(MSYS2_ROOT)) {
            throw new Failure('missing_dependency', `${MSYS2_ROOT} appeared before setup could install MSYS2`, `Delete ${MSYS2_ROOT} and run screen-relay install again.`);
          }
          const winget = wingetPath();
          if (!winget || run([winget, '--version']).status !== 0) {
            throw new Failure('missing_dependency', 'MSYS2 is not installed, and winget is not available to install it', 'Install App Installer, or install MSYS2 from https://www.msys2.org with the access rules in the Windows guide, then run screen-relay install again.');
          }
          const discardRoot = createPrivateMsys2Root();
          if (!discardRoot) {
            throw new Failure('missing_dependency', `Setup could not create a private ${MSYS2_ROOT}`, `Run screen-relay install from an elevated terminal. If ${MSYS2_ROOT} exists, delete it first.`);
          }
          try {
            await step('Installing MSYS2', 'Installed MSYS2', `winget ${WINGET_MSYS2.join(' ')}`, args, true, [winget, ...WINGET_MSYS2]);
          } catch (error) {
            if (!discardRoot() && error instanceof Failure) {
              throw new Failure(error.reason, error.message, `Check ${MSYS2_ROOT} before retrying. Back up any files you need, then remove the incomplete installation and run screen-relay install again.`, error.data);
            }
            throw error;
          }
          const installed = msys2Installation();
          if (installed.state !== 'trusted') {
            if (discardRoot()) throw new Failure('missing_dependency', 'winget reported success but did not install MSYS2', 'Install MSYS2 with the manual steps at https://screen-relay.dev/docs/windows#install-msys2-manually, then run screen-relay install again.');
            throw msys2Failure(installed);
          }
        }
        const keyring = '{ [ -d /etc/pacman.d/gnupg ] || { pacman-key --init && pacman-key --populate msys2 && gpgconf --kill all; }; }';
        await step('Installing MSYS2 packages', 'Installed MSYS2 packages', `${keyring} && pacman -Sy --noconfirm --needed ${MSYS2_PACKAGES.join(' ')}`, args);
      },
    };
  }
  let osRelease = '';
  try { osRelease = readFileSync('/etc/os-release', 'utf8'); } catch {}
  const family = detectFamily(osRelease);
  if (!family) {
    throw new Failure('unsupported_platform', 'Automatic setup supports Debian, Ubuntu, Fedora, Arch Linux, and Alpine',
      'Install the build tools and libraries yourself, then run screen-relay install again to build the engine. screen-relay doctor lists what is missing.');
  }
  const packages = groupPackages(family, groups, family === 'apt' ? OPTIONAL_APT : []);
  const x264 = packagesFor(family, ['x264-dev'])[0];
  const install = async () => {
    const elevate = elevation(interactive(args));
    const available = (name: string) => /Candidate: [^ (]/.test(run(['apt-cache', 'policy', name], { env: { ...process.env, LC_ALL: 'C' } }).stdout ?? '');
    if (family === 'apt') {
      await step('Updating package lists', 'Updated package lists', `${elevate}apt-get update`, args, false);
      if (/^ID(_LIKE)?=.*ubuntu/m.test(osRelease) && !available(x264)) {
        const sources = '/etc/apt/sources.list.d/ubuntu.sources';
        if (!existsSync(sources)) throw new Failure('missing_dependency', `${x264} is not available`, 'Enable the Ubuntu universe component, then run `screen-relay install` again.');
        await step('Enabling the Ubuntu universe component', 'Enabled the Ubuntu universe component',
          `${elevate}sed -i '/^Components:/{/universe/!s/$/ universe/}' ${sources} && ${elevate}apt-get update`, args);
        if (!available(x264)) throw new Failure('missing_dependency', `Cannot install ${x264} after enabling Ubuntu universe`, 'Check the apt sources on this machine.');
      }
      if (groups.includes('xfce')) packages.push(...packagesFor('apt', OPTIONAL_APT).filter((name) => run(['apt-cache', 'show', name]).status === 0));
    }
    if (family === 'dnf') {
      const query = run(['sh', '-c', `${elevate}dnf -q repoquery --available ${x264}`]);
      if (query.status !== 0) throw new Failure('missing_dependency', 'dnf could not query its repositories', 'Fix the repository configuration or network, then run `screen-relay install` again.');
      if (!query.stdout.trim()) {
        throw new Failure('missing_dependency', 'x264 needs RPM Fusion Free on Fedora',
          `Enable it with ${elevate}dnf -y install https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm and run screen-relay install again.`);
      }
    }
    await step('Installing system packages', 'Installed system packages', installCommand(family, packages, family === 'apt' ? `${elevate}env DEBIAN_FRONTEND=noninteractive ` : elevate), args);
  };
  return { manager: { apt: 'apt-get', dnf: 'dnf', pacman: 'pacman', apk: 'apk' }[family], packages, run: install };
}

/** Builds the engine from the source in this install in its own scratch directory, then replaces this version's earlier build. */
async function buildEngine(backends: Backend[], args: Args): Promise<void> {
  if (!existsSync(join(SOURCE, 'src', 'engine'))) {
    throw new Failure('missing_dependency', 'The engine source is missing from this install', 'Reinstall it with `npm install -g screen-relay`.');
  }
  const target = engineDirectory();
  mkdirSync(dirname(target), { recursive: true });
  const scratch = mkdtempSync(join(dirname(target), 'build-'));
  try {
    mkdirSync(join(scratch, 'src'));
    cpSync(join(SOURCE, 'Makefile'), join(scratch, 'Makefile'));
    cpSync(join(SOURCE, 'src', 'engine'), join(scratch, 'src', 'engine'), { recursive: true });
    await step(`Building the engine (${backends.join(', ')})`, 'Built the engine', `make -C ${quote(shellPath(scratch))} BACKENDS=${quote(backends.join(' '))} relay-engine`, args);
    for (const name of ['src', 'build', 'Makefile']) rmSync(join(scratch, name), { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(scratch, target);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Runs work while this process holds the machine's setup lock, waiting first for another setup to finish and taking over a lock whose owner is gone. */
async function withSetupLock<T>(args: Args, work: () => Promise<T>): Promise<T> {
  const directory = dirname(dirname(engineDirectory()));
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'setup.lock');
  let announced = false;
  while (!claimLock(file)) {
    if (!lockOwnerAlive(file)) {
      rmSync(file, { force: true });
      continue;
    }
    if (!announced && !args.json) process.stderr.write('Waiting for another screen-relay setup to finish\n');
    announced = true;
    await delay(500, undefined, { signal: args.signal });
  }
  try {
    return await work();
  } finally {
    rmSync(file, { force: true });
  }
}

/** Sets the machine up for the request under the setup lock and says whether this process had to change anything. */
async function setUp(request: Request, args: Args): Promise<boolean> {
  if (planSetup(request).state === 'ready') return false;
  return withSetupLock(args, async () => {
    const plan = planSetup(request);
    if (plan.state === 'ready') return false;
    await applySetup(request, plan, args);
    return true;
  });
}

async function answer<T>(prompt: Promise<T | symbol>): Promise<T> {
  const value = await prompt;
  if (isCancel(value)) throw new Failure('canceled', 'Setup canceled.');
  return value as T;
}

/** Installs what the plan says is missing, asking first when packages need installing. */
async function applySetup(request: Request, plan: Plan, args: Args): Promise<void> {
  const names = request.backends.join(' and ');
  if (plan.state === 'needs-packages') {
    if (!args.yes && !interactive(args)) {
      const flag = process.platform === 'darwin' || process.platform === 'win32' ? '' : ` --backend ${request.backends.length > 1 ? 'all' : request.backends[0]}`;
      throw new Failure('missing_input', `Setting up the ${names} backend installs system packages`, `Run \`screen-relay install${flag} --yes\` to allow it.`);
    }
    const work = packageWork(plan.groups, args);
    if (!args.yes) {
      process.stderr.write(`Setting up the ${names} backend installs ${count(work.packages.length, 'package')} with ${work.manager}, then builds the engine:\n  ${work.packages.join(' ')}\n`);
      if (!await answer(confirm({ message: 'Install them now?', output: process.stderr, signal: args.signal }))) throw new Failure('canceled', 'Setup canceled.');
    }
    await work.run();
  }
  if (plan.build) await buildEngine(plan.backends, args);
  if (planSetup(request).state !== 'ready') {
    throw new Failure('missing_dependency', `This machine is still missing what the ${names} backend needs`, 'Run `screen-relay doctor` to see what is missing.');
  }
}

/** Sets the machine up before a session starts and returns the arguments a prompt chose, for a detached child to repeat. */
export async function ensureSetup(args: Args): Promise<string[]> {
  const extra: string[] = [];
  const requested = requestedBackend(args.backend, args.display);
  let backends: Backend[] = requested ? [requested] : [];
  if (!requested) {
    const compiled = compiledBackends();
    if (compiled.length) backends = [compiled.includes('x11') ? 'x11' : 'wayland'];
    else if (args.display || !interactive(args)) backends = ['x11'];
    else {
      const running = process.env.WAYLAND_DISPLAY || process.env.DISPLAY;
      const attach = running ? await answer(select({
        message: `A desktop is already running here (${running}). What should screen-relay stream?`,
        options: [{ value: false, label: 'A new virtual desktop' }, { value: true, label: `The running desktop (${running})` }],
        output: process.stderr, signal: args.signal,
      })) : false;
      if (attach && running) {
        args.display = running;
        extra.push('--display', running);
        backends = [requestedBackend(undefined, running) ?? 'x11'];
      } else {
        backends = await answer<Backend[]>(select<Backend[]>({
          message: 'Which backend should this machine use?',
          options: [
            { value: ['x11'], label: 'X11 with the XFCE desktop', hint: 'default' },
            { value: ['wayland'], label: 'Wayland with sway' },
            { value: ['x11', 'wayland'], label: 'Both' },
          ],
          output: process.stderr, signal: args.signal,
        }));
      }
    }
  }
  await setUp({ backends, display: args.display, desktop: args.desktop, keyboardLayout: args.keyboardLayout }, args);
  return extra;
}

export async function cmdInstall(args: Args): Promise<number> {
  requireHost();
  const [settings, , present] = loadConfig(typeof args.config === 'string' && args.config ? args.config : undefined);
  const chosen = args.backend ?? settings.backend;
  if (chosen === 'all' && !isLinux()) throw new Failure('invalid_input', '--backend all is only supported on Linux', process.platform === 'win32' ? 'Use --backend windows on Windows.' : 'Use --backend macos on macOS.');
  const backends: Backend[] = chosen === 'all' ? ['x11', 'wayland'] : [requestedBackend(chosen) ?? 'x11'];
  const request: Request = { backends, desktop: args.desktop ?? (present.has('desktop') ? settings.desktop : undefined) };
  const label = await setUp(request, args) ? 'Installed' : 'Unchanged';
  const install = { backends: compiledBackends(), engine: findEngine() };
  const start = ['screen-relay up -d', ...(chosen === 'wayland' ? ['--backend wayland'] : []), ...(request.desktop ? [`--desktop ${quote(request.desktop)}`] : [])].join(' ');
  emit(args, { install, outcome: label.toLowerCase() }, [
    receipt(label, install.backends.join(', '), args),
    row('Engine', install.engine, args),
    nextStep('Start a session', start, args),
  ].join('\n'), {});
  return 0;
}
