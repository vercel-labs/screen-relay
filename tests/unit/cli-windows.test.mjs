import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('../..', import.meta.url));
const directory = mkdtempSync(join(root, '.cli-windows-test-'));
const home = join(directory, 'home');
mkdirSync(home, { recursive: true });
Object.assign(process.env, { XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_CONFIG_HOME: join(home, 'config') });
after(() => rmSync(directory, { recursive: true, force: true }));

const bundle = buildSync({
  stdin: {
    contents: "export { cmdDoctor } from './src/cli/host/doctor.ts'; export { cmdInstall } from './src/cli/host/setup.ts'; export { cmdDown, cmdLogs, cmdRun, cmdUp } from './src/cli/host/session_commands.ts'; export { engineDirectory, requireHost, which } from './src/cli/host/common.ts'; export { compiledBackends, findEngine, requestedBackend, Session } from './src/cli/host/supervisor.ts'; export { alive, identity, lock, stateDir, writeSession } from './src/cli/host/state.ts'; export { createPrivateMsys2Root, engineEnvironment, killTree, MSYS2_PATH, msys2Fix, msys2Shell, probeMsys2Tree, trustedAcl, windowsSessionId } from './src/cli/host/windows.ts';",
    resolveDir: root,
  },
  bundle: true,
  external: ['yaml'],
  platform: 'node',
  format: 'esm',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  write: false,
});
const bundlePath = join(directory, 'windows.mjs');
writeFileSync(bundlePath, bundle.outputFiles[0].contents);
const { alive, cmdDown, cmdInstall, cmdLogs, cmdRun, cmdUp, compiledBackends, createPrivateMsys2Root, engineDirectory, engineEnvironment, findEngine, identity, killTree, lock, MSYS2_PATH, msys2Fix, msys2Shell, probeMsys2Tree, requestedBackend, requireHost, Session, stateDir, trustedAcl, which, windowsSessionId, writeSession } = await import(pathToFileURL(bundlePath).href);

function onWindowsProcess(script) {
  const probe = `Object.defineProperty(process, 'platform', { value: 'win32' });
const { cmdDoctor, cmdInstall, cmdUp } = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});
${script}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 60000 });
}

async function onPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

async function withEnv(name, value, run) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function writeEngine(script) {
  mkdirSync(engineDirectory(), { recursive: true });
  const engine = join(engineDirectory(), 'relay-engine.exe');
  writeFileSync(engine, script, { mode: 0o755 });
  return engine;
}

test('Windows defaults to the windows backend', async () => {
  assert.equal(await onPlatform('win32', () => requestedBackend(undefined)), 'windows');
});

test('the x11 backend is refused on Windows and the hint names windows', async () => {
  await onPlatform('win32', () => assert.throws(() => requestedBackend('x11'), { reason: 'invalid_input', hint: /windows/ }));
});

test('the windows backend is refused on Linux', async () => {
  await onPlatform('linux', () => assert.throws(() => requestedBackend('windows'), { reason: 'invalid_input' }));
});

test('up refuses --display on Windows', async () => {
  await onPlatform('win32', () => assert.rejects(cmdUp({ command: 'up', json: false, name: 'desk', display: ':1' }), { reason: 'invalid_input' }));
});

test('Windows ignores display.resolution with a warning', () => {
  const config = join(home, 'resolution.yaml');
  writeFileSync(config, 'display:\n  resolution: 1920x1080\n');
  const result = onWindowsProcess(`await cmdUp({ command: 'up', json: false, name: 'desk', config: ${JSON.stringify(config)}, port: 0 }).catch(() => {});`);
  assert.match(result.stderr, /display\.resolution is ignored on Windows/);
});

test('findEngine finds relay-engine.exe in the engine directory on Windows', async () => {
  const engine = writeEngine('#!/bin/sh\nexit 0\n');
  assert.equal(await onPlatform('win32', () => findEngine()), engine);
});

test('compiledBackends starts a Windows engine in its own folder', { skip: process.platform === 'win32' }, async () => {
  writeEngine('#!/bin/sh\necho "Compiled backends: $(pwd)"\n');
  const backends = await onPlatform('win32', () => compiledBackends());
  assert.equal(backends.length, 1);
  assert.equal(realpathSync(backends[0]), realpathSync(engineDirectory()));
});

test('a Windows engine that exits names its log in the failure', { skip: process.platform === 'win32' }, async () => {
  writeEngine(`#!/bin/sh
if [ "$1" = --help ]; then echo 'Compiled backends: windows'; exit 0; fi
echo 'No display is attached to this session; start relay in the signed-in desktop session' >&2
exit 1
`);
  const sessionDir = join(home, 'state', 'screen-relay', 'win');
  mkdirSync(sessionDir, { recursive: true });
  const session = new Session({ command: 'up', json: true, name: 'win', port: 8080, resolution: '1280x720', fps: 60, bitrateMin: 1000000, bitrateStart: 8000000, bitrateMax: 40000000, timeout: 5 }, sessionDir);
  await onPlatform('win32', async () => {
    try {
      await assert.rejects(session.start(), { reason: 'component_failed', message: /No display is attached to this session/ });
    } finally {
      await session.cleanup();
    }
  });
});

test('doctor on Windows reports the platform, Windows version, MSYS2, engine and desktop session', () => {
  const result = onWindowsProcess(`await cmdDoctor({ command: 'doctor', json: true, name: 'default' });`);
  const names = JSON.parse(result.stdout).checks.map((check) => check.name);
  for (const name of ['platform', 'windows version', 'msys2', 'engine', 'desktop session']) {
    assert.ok(names.includes(name), `${name} missing from ${names.join(', ')}`);
  }
});

const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const USERS = 'S-1-5-32-545';
const ACCOUNT = 'S-1-5-21-1-1001';
const OTHER = 'S-1-5-21-1-1002';
const FULL = 2032127;
const READ = 131241;
const CREATE_DIRECTORY = 4;
const MODIFY = 197055;

test('an MSYS2 tree owned by another account is refused, and the owner is named', () => {
  const verdict = trustedAcl({ current: ACCOUNT, objects: [{ path: 'C:\\msys64', kind: 'directory', owner: OTHER, ownerName: 'DESKTOP\\other', rules: [] }] });
  assert.deepEqual(verdict, { trusted: false, reason: 'C:\\msys64 is owned by DESKTOP\\other.' });
});

test('an MSYS2 tree that another account can write to is refused, and the path and account are named', () => {
  const rules = [{ sid: USERS, name: 'BUILTIN\\Users', rights: MODIFY }];
  const verdict = trustedAcl({ current: ACCOUNT, objects: [
    { path: 'C:\\msys64', kind: 'directory', owner: SYSTEM, ownerName: 'NT AUTHORITY\\SYSTEM', rules },
    { path: 'C:\\msys64\\usr\\bin', kind: 'directory', owner: SYSTEM, ownerName: 'NT AUTHORITY\\SYSTEM', rules },
  ] });
  assert.deepEqual(verdict, { trusted: false, reason: 'C:\\msys64 lets BUILTIN\\Users write to it.' });
});

test('a tree that the signed-in account, SYSTEM or Administrators owns and no other account can write to is trusted', () => {
  const rules = [
    { sid: SYSTEM, name: 'NT AUTHORITY\\SYSTEM', rights: FULL },
    { sid: ADMINISTRATORS, name: 'BUILTIN\\Administrators', rights: FULL },
    { sid: USERS, name: 'BUILTIN\\Users', rights: READ },
    { sid: 'S-1-3-0', name: 'CREATOR OWNER', rights: FULL },
  ];
  const directories = ['C:\\msys64', 'C:\\msys64\\usr', 'C:\\msys64\\usr\\bin'];
  for (const owner of [ACCOUNT, SYSTEM, ADMINISTRATORS]) {
    const objects = [
      ...directories.map((path) => ({ path, kind: 'directory', owner, ownerName: 'owner', rules })),
      { path: 'C:\\msys64\\usr\\bin\\bash.exe', kind: 'file', owner, ownerName: 'owner', rules },
    ];
    assert.deepEqual(trustedAcl({ current: ACCOUNT, objects }), { trusted: true });
  }
});

test('a file that another account can append to is refused, since the login profile runs it', () => {
  const rules = [{ sid: USERS, name: 'BUILTIN\\Users', rights: CREATE_DIRECTORY }];
  const verdict = trustedAcl({ current: ACCOUNT, objects: [{ path: 'C:\\msys64\\etc\\profile', kind: 'file', owner: SYSTEM, ownerName: 'NT AUTHORITY\\SYSTEM', rules }] });
  assert.deepEqual(verdict, { trusted: false, reason: 'C:\\msys64\\etc\\profile lets BUILTIN\\Users write to it.' });
});

test('a directory that another account can create subdirectories in is refused, since the tree covers what they add', () => {
  const rules = [{ sid: USERS, name: 'BUILTIN\\Users', rights: CREATE_DIRECTORY }];
  const verdict = trustedAcl({ current: ACCOUNT, objects: [{ path: 'C:\\msys64', kind: 'directory', owner: SYSTEM, ownerName: 'NT AUTHORITY\\SYSTEM', rules }] });
  assert.deepEqual(verdict, { trusted: false, reason: 'C:\\msys64 lets BUILTIN\\Users write to it.' });
});

test('a rule that grants another account a generic write right is refused', () => {
  for (const rights of [0x40000000, 0x10000000]) {
    const verdict = trustedAcl({ current: ACCOUNT, objects: [{ path: 'C:\\msys64', kind: 'directory', owner: SYSTEM, ownerName: 'NT AUTHORITY\\SYSTEM', rules: [{ sid: USERS, name: 'BUILTIN\\Users', rights }] }] });
    assert.equal(verdict.trusted, false);
  }
});

test('an MSYS2 path that is a reparse point is refused', () => {
  const verdict = trustedAcl({ current: ACCOUNT, objects: [{ path: 'C:\\msys64\\usr', kind: 'directory', reparse: true, owner: SYSTEM, ownerName: 'NT AUTHORITY\\SYSTEM', rules: [] }] });
  assert.deepEqual(verdict, { trusted: false, reason: 'C:\\msys64\\usr is a reparse point.' });
});

test('an MSYS2 tree with a loose rule gets a delete-and-reinstall fix without icacls', () => {
  const fix = msys2Fix({ state: 'untrusted', root: 'C:\\msys64', reason: 'C:\\msys64 lets BUILTIN\\Users write to it.' });
  assert.match(fix, /lets BUILTIN\\Users write to it\./);
  assert.match(fix, /Do not run any program from C:\\msys64\. Back up any files you need, delete C:\\msys64, and run screen-relay install again/);
  assert.ok(!fix.includes('icacls'));
  assert.ok(!fix.includes('uninstall'));
  assert.ok(!fix.includes('`'));
});

test('an MSYS2 tree owned by another account gets the same delete-and-reinstall fix', () => {
  const fix = msys2Fix({ state: 'untrusted', root: 'C:\\msys64', reason: 'C:\\msys64 is owned by DESKTOP\\other.' });
  assert.match(fix, /is owned by DESKTOP\\other\./);
  assert.match(fix, /Do not run any program from C:\\msys64\. Back up any files you need, delete C:\\msys64, and run screen-relay install again/);
  assert.ok(!fix.includes('icacls'));
});

test('setup searches the MSYS2 command directories in its own order', () => {
  assert.deepEqual(MSYS2_PATH.split(':'), ['/usr/local/bin', '/usr/bin', '/ucrt64/bin']);
});

test('a private MSYS2 root and its real children read as trusted, and each child ACL is read on its own', { skip: process.platform !== 'win32' }, () => {
  const parent = mkdtempSync(join(directory, 'msys2-private-'));
  const root = join(parent, 'root');
  try {
    const discard = createPrivateMsys2Root(root);
    assert.equal(typeof discard, 'function');
    const rootProbe = probeMsys2Tree(root);
    assert.ok(rootProbe);
    assert.deepEqual(trustedAcl(rootProbe), { trusted: true });
    const shell = join(root, 'usr', 'bin', 'bash.exe');
    assert.equal(probeMsys2Tree(root, shell), null);

    const bin = join(root, 'usr', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(shell, '');
    const treeProbe = probeMsys2Tree(root, shell);
    assert.ok(treeProbe);
    assert.deepEqual(trustedAcl(treeProbe), { trusted: true });
    const objectAt = (probe, path) => probe.objects.find((object) => object.path.replace(/[\\/]+$/, '').toLowerCase() === path.replace(/[\\/]+$/, '').toLowerCase());
    assert.equal(objectAt(treeProbe, shell)?.kind, 'file');

    const nested = join(root, 'opt');
    mkdirSync(nested);
    const icacls = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    const applied = spawnSync(icacls, [nested, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `*${rootProbe.current}:(OI)(CI)F`], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    const nestedFile = join(nested, 'note.txt');
    writeFileSync(nestedFile, '');
    const nestedProbe = probeMsys2Tree(root);
    assert.ok(nestedProbe);
    assert.deepEqual(trustedAcl(nestedProbe), { trusted: true });
    const nestedObject = objectAt(nestedProbe, nested);
    const nestedFileObject = objectAt(nestedProbe, nestedFile);
    const rootObject = objectAt(nestedProbe, root);
    assert.ok(nestedObject);
    assert.ok(nestedFileObject);
    assert.ok(rootObject);
    assert.notDeepEqual(nestedObject.rules, rootObject.rules);

    rmSync(join(root, 'usr'), { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
    assert.equal(discard(), true);
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('setup refuses an MSYS2 shell it cannot vouch for', { skip: process.platform === 'win32' }, async () => {
  await onPlatform('win32', () => assert.throws(() => msys2Shell(), { reason: 'missing_dependency' }));
});

test('the Windows engine environment keeps PATH unchanged while MSYS2 is untrusted', { skip: process.platform === 'win32' }, async () => {
  const env = await onPlatform('win32', () => engineEnvironment({ PATH: 'C:\\Windows\\System32' }));
  assert.equal(env.PATH, 'C:\\Windows\\System32');
});

test('run refuses --restart on Windows', async () => {
  await onPlatform('win32', () => assert.rejects(cmdRun({ command: 'run', json: false, name: 'desk', app: 'notepad', args: [], restart: true }), { reason: 'invalid_input' }));
});

test('run starts an app found by name on Windows', { skip: process.platform !== 'win32' }, async () => {
  const name = 'run-windows';
  const directory = stateDir(name);
  mkdirSync(directory, { recursive: true });
  const supervisor = spawn(process.execPath, ['-e', sleeper]);
  await once(supervisor, 'spawn');
  const appDirectory = join(home, 'run-windows-app');
  mkdirSync(appDirectory, { recursive: true });
  copyFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), join(appDirectory, 'relay-probe.exe'));
  const path = process.env.PATH;
  process.env.PATH = `${appDirectory}${delimiter}${path}`;
  try {
    writeSession(directory, { name, state: 'ready', backend: 'windows', ownsDisplay: false, supervisor: identity(supervisor.pid), components: {} });
    assert.equal(await cmdRun({ command: 'run', json: true, name, app: 'relay-probe', args: [] }), 0);
    const log = join(directory, 'apps.log');
    for (let attempt = 0; attempt < 50 && !readFileSync(log, 'utf8').includes('\\'); attempt++) await delay(100);
    assert.match(readFileSync(log, 'utf8'), /\\/);
  } finally {
    process.env.PATH = path;
    supervisor.kill();
    await once(supervisor, 'exit');
  }
});

test('requireHost still refuses other platforms', async () => {
  await onPlatform('freebsd', () => assert.throws(() => requireHost(), { reason: 'unsupported_platform' }));
});

const sleeper = 'setTimeout(() => {}, 60000)';

test('a Windows process identity is alive until the process exits', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', sleeper]);
  await once(child, 'spawn');
  const record = identity(child.pid);
  assert.notEqual(record.start, null);
  assert.equal(alive(record), true);
  child.kill();
  await once(child, 'exit');
  assert.equal(alive(record), false);
});

test('a Windows record with another start time is not alive', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', sleeper]);
  await once(child, 'spawn');
  try {
    assert.equal(alive({ pid: child.pid, start: '0' }), false);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
});

test('a Windows record with no start time is not alive', async () => {
  await onPlatform('win32', () => assert.equal(alive({ pid: process.pid, start: null }), false));
});

test('which on Windows finds the .exe of a bare name, not an extensionless script', async () => {
  const dir = join(home, 'which-windows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(dir, 'tool.exe'), '', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  try {
    assert.equal(await onPlatform('win32', () => which('tool')), join(dir, 'tool.exe'));
  } finally {
    process.env.PATH = path;
  }
});

test('windowsSessionId runs PowerShell by its system path, not a same-named file on PATH', { skip: process.platform === 'win32' }, async () => {
  const dir = join(home, 'planted-powershell');
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, 'ran');
  writeFileSync(join(dir, 'powershell'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  try {
    await onPlatform('win32', () => windowsSessionId());
    assert.equal(existsSync(marker), false);
  } finally {
    process.env.PATH = path;
  }
});

test('windowsSessionId ignores a powershell.exe in the working directory', { skip: process.platform !== 'win32' }, () => {
  const dir = join(home, 'planted-exe');
  mkdirSync(dir, { recursive: true });
  const whoami = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  copyFileSync(whoami, join(dir, 'powershell.exe'));
  copyFileSync(whoami, join(dir, 'taskkill.exe'));
  const script = `const { windowsSessionId } = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});
console.log(windowsSessionId());`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  assert.match(result.stdout.trim(), /^\d+$/);
});

test('a Windows session lock rejects a second holder until the first closes',{ skip: process.platform !== 'win32' }, async () => {
  const directory = join(home, 'lock-held');
  mkdirSync(directory, { recursive: true });
  const first = await lock('desk', directory);
  await assert.rejects(lock('desk', directory), { reason: 'already_running' });
  await first.close();
  await (await lock('desk', directory)).close();
});

test('a Windows session lock left by a dead process is reclaimed', { skip: process.platform !== 'win32' }, async () => {
  const directory = join(home, 'lock-stale');
  mkdirSync(directory, { recursive: true });
  const exited = spawn(process.execPath, ['-e', '']);
  await once(exited, 'exit');
  writeFileSync(join(directory, 'lock'), JSON.stringify({ pid: exited.pid, start: '1' }));
  await (await lock('desk', directory)).close();
});

test('killTree ends a Windows process and the child it started', { skip: process.platform !== 'win32' }, async () => {
  const script = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}]);
console.log(child.pid);
${sleeper};`;
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const grandchild = { pid: 0 };
  try {
    const [line] = await once(parent.stdout, 'data');
    const record = identity(Number(String(line).trim()));
    grandchild.pid = record.pid;
    assert.equal(alive(record), true);
    killTree(parent.pid);
    for (let attempt = 0; attempt < 50 && alive(record); attempt++) await delay(100);
    assert.equal(alive(record), false);
  } finally {
    parent.kill();
    if (grandchild.pid) try { process.kill(grandchild.pid); } catch {}
  }
});

test('down leaves a Windows process alone when the session records another start time', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', sleeper]);
  await once(child, 'spawn');
  try {
    const name = 'pid-reuse';
    const directory = stateDir(name);
    mkdirSync(directory, { recursive: true });
    writeSession(directory, { name, state: 'ready', supervisor: { pid: child.pid, start: '0' }, components: {} });
    const live = identity(child.pid);
    await cmdDown({ command: 'down', json: true, name });
    assert.equal(alive(live), true);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
});

test('logs prints the last 200 lines of a Windows log without a PATH', { skip: process.platform !== 'win32' }, () => {
  const name = 'logs-windows';
  const directory = stateDir(name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'engine.log'), `${Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join('\n')}\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  env.PATH = '';
  const script = `const { cmdLogs } = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});
await cmdLogs({ command: 'logs', json: false, name: ${JSON.stringify(name)}, component: 'engine', follow: false });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env, timeout: 60000 });
  assert.equal(result.stdout, `${Array.from({ length: 200 }, (_, index) => `line ${index + 51}`).join('\n')}\n`);
});

function withoutEngine() {
  rmSync(engineDirectory(), { recursive: true, force: true });
}

test('install on Windows without a terminal needs --yes before it installs anything', async () => {
  withoutEngine();
  await onPlatform('win32', () => assert.rejects(cmdInstall({ command: 'install', json: true, name: 'default', backend: 'windows' }), { reason: 'missing_input', hint: /--yes/ }));
});

test('install on Windows without MSYS2 or winget names MSYS2 and its download page', { skip: process.platform === 'win32' }, async () => {
  withoutEngine();
  await withEnv('LOCALAPPDATA', undefined, () => onPlatform('win32', () => assert.rejects(cmdInstall({ command: 'install', json: true, name: 'default', backend: 'windows', yes: true }), { reason: 'missing_dependency', message: /MSYS2/, hint: /https:\/\/www\.msys2\.org/ })));
});

test('Windows bootstrap retries only when its installer left the new root empty', { skip: process.platform === 'win32' }, () => {
  for (const mode of ['failed', 'missing-shell', 'partial', 'preexisting']) {
    const cwd = join(directory, `bootstrap-${mode}`);
    const system = join(cwd, 'system');
    const appData = join(cwd, 'appdata');
    const powershell = join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const icacls = join(system, 'System32', 'icacls.exe');
    const winget = join(appData, 'Microsoft', 'WindowsApps', 'winget.exe');
    const marker = join(cwd, 'calls');
    const msysRoot = join(cwd, 'C:\\msys64');
    mkdirSync(cwd, { recursive: true });
    for (const path of [powershell, icacls, winget]) mkdirSync(join(path, '..'), { recursive: true });
    const probe = { current: 'S-1-5-21-123', objects: [{ path: 'C:\\msys64', directory: true, reparse: false, owner: 'S-1-5-21-123', rules: [] }] };
    writeFileSync(powershell, `#!/bin/sh\nprintf '%s' '${JSON.stringify(probe)}'\n`, { mode: 0o755 });
    writeFileSync(icacls, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(winget, `#!/bin/sh\n[ "$1" = --version ] && exit 0\necho install >> ${JSON.stringify(marker)}\n${mode === 'partial' ? `touch ${JSON.stringify(join(msysRoot, 'partial'))}\n` : ''}exit ${mode === 'missing-shell' ? 0 : 1}\n`, { mode: 0o755 });
    if (mode === 'preexisting') mkdirSync(msysRoot);
    const script = `Object.defineProperty(process, 'platform', { value: 'win32' });
const { cmdInstall } = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});
for (let i = 0; i < 2; i++) {
  try { await cmdInstall({ command: 'install', json: true, name: 'default', backend: 'windows', yes: true }); }
  catch (error) { console.log(JSON.stringify({ message: error.message, hint: error.hint })); }
}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, SystemRoot: system, LOCALAPPDATA: appData, XDG_DATA_HOME: join(cwd, 'data'), XDG_STATE_HOME: join(cwd, 'state'), XDG_CONFIG_HOME: join(cwd, 'config') },
    });
    assert.equal(result.status, 0, result.stderr);
    const errors = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(errors.length, 2);
    const calls = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0;
    assert.equal(calls, mode === 'preexisting' ? 0 : mode === 'partial' ? 1 : 2, mode);
    assert.equal(existsSync(msysRoot), mode === 'partial' || mode === 'preexisting', mode);
    if (mode === 'partial') assert.match(errors[0].hint, /incomplete installation/);
    if (mode === 'missing-shell') assert.match(errors[0].hint, /install-msys2-manually/);
  }
});

test('install on Windows reports unchanged when the engine already has the windows backend', { skip: process.platform === 'win32' }, () => {
  writeEngine('#!/bin/sh\nif [ "$1" = --help ]; then echo \'Compiled backends: windows\'; exit 0; fi\nexit 1\n');
  const result = onWindowsProcess(`await cmdInstall({ command: 'install', json: true, name: 'default', backend: 'windows' });`);
  assert.equal(JSON.parse(result.stdout).outcome, 'unchanged');
});
