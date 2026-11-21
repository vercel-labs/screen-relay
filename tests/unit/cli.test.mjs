import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { buildSync } from 'esbuild';

const cli = fileURLToPath(new URL('../../dist/cli/relay.mjs', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const directory = mkdtempSync(join(root, '.cli-test-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const bundle = buildSync({
  stdin: {
    contents: "export { commands } from './src/cli/commands.ts'; export { parseCommand } from './src/cli/parser.ts'; export { Session, resolveBackend } from './src/cli/host/supervisor.ts'; export { cmdRun, detachedSupervisorSpawn } from './src/cli/host/session_commands.ts'; export { writePrivateFile } from './src/cli/host/state.ts'; export { formatReady } from './src/cli/output.ts'; export { planSetup } from './src/cli/host/setup.ts';",
    resolveDir: root,
  },
  bundle: true,
  external: ['yaml'],
  platform: 'node',
  format: 'esm',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  write: false,
});
const bundlePath = join(directory, 'parser.mjs');
writeFileSync(bundlePath, bundle.outputFiles[0].contents);
const { commands, parseCommand, Session, resolveBackend, cmdRun, detachedSupervisorSpawn, writePrivateFile, formatReady, planSetup } = await import(pathToFileURL(bundlePath).href);

test('every metadata example parses through the command parser', () => {
  for (const [name, command] of Object.entries(commands)) {
    assert.ok(command.examples.length > 0, name);
    for (const example of command.examples) {
      const argv = [...example.command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
        .map(match => match[1] ?? match[2] ?? match[3]);
      assert.equal(argv.shift(), 'screen-relay', example.command);
      assert.equal(parseCommand(argv, {}).command, name, example.command);
    }
  }
});

test('--allow-origin takes exact HTTPS and loopback HTTP origins from the flag or the environment', () => {
  const origins = 'https://app.example.com,https://host.example.net:8443,http://localhost:8081,http://127.0.0.1:3000';
  assert.equal(parseCommand(['up', '--allow-origin', origins], {})['allow-origin'], origins);
  assert.equal(parseCommand(['up'], { SCREEN_RELAY_ALLOW_ORIGIN: origins })['allow-origin'], origins);
  assert.equal(parseCommand(['up'], {})['allow-origin'], undefined);
  for (const value of ['*', 'null', 'https://*.example.com', 'http://app.example.com', 'http://app.example.com:8081',
    'http://localhost:80', 'http://127.0.0.1:80', 'http://LOCALHOST:8081', 'http://localhost.evil:8081',
    'http://localhost:8081/', 'http://localhost:08081', 'http://[::1]:8081', 'https://App.example.com',
    'https://app.example.com/', 'https://app.example.com:443', 'https://app.example.com:65536', 'https://user@app.example.com',
    'https://a.example.com, https://b.example.com', 'https://a.example.com,', Array.from({ length: 17 }, (_, index) => `https://h${index}.example.com`).join(',')]) {
    assert.throws(() => parseCommand(['up', '--allow-origin', value], {}), /Invalid allow-origin/, value);
    assert.throws(() => parseCommand(['up'], { SCREEN_RELAY_ALLOW_ORIGIN: value }), /Invalid SCREEN_RELAY_ALLOW_ORIGIN/, value);
  }
});

test('--encoder and repeated --ice-server take validated values from flags and the environment', () => {
  assert.equal(parseCommand(['up', '--encoder', 'x264'], {}).encoder, 'x264');
  assert.equal(parseCommand(['up'], { SCREEN_RELAY_ENCODER: 'h264_videotoolbox' }).encoder, 'h264_videotoolbox');
  assert.equal(parseCommand(['up'], {}).encoder, undefined);
  for (const value of ['x-264', 'x 264', 'x264!']) {
    assert.throws(() => parseCommand(['up', '--encoder', value], {}), /Invalid encoder/, value);
    assert.throws(() => parseCommand(['up'], { SCREEN_RELAY_ENCODER: value }), /Invalid SCREEN_RELAY_ENCODER/, value);
  }

  const cliServers = ['stun:stun.example.com', 'turn:turn.example.com:3478?transport=tcp'];
  const servers = ['stun:stun.example.com', 'turn:user:pass@turn.example.com:3478?transport=tcp'];
  assert.deepEqual(parseCommand(['up', '--ice-server', cliServers[0], '--ice-server', cliServers[1]], {})['ice-server'], cliServers);
  assert.deepEqual(parseCommand(['up'], { SCREEN_RELAY_ICE_SERVERS: servers.join(' ') })['ice-server'], servers);
  assert.throws(() => parseCommand(['up', '--ice-server', 'turn:u:s3cr3t-turn-pass@turn.example.com:3478?transport=tcp'], {}), (error) => /ICE server credentials cannot be passed in --ice-server/.test(error.message) && !error.message.includes('s3cr3t-turn-pass'));
  assert.throws(() => parseCommand(['up', '--ice-server', 'turn:u:s3cr3t-turn-pass@stun.example.com/path'], {}), (error) => /Invalid ice-server/.test(error.message) && !error.message.includes('s3cr3t-turn-pass'));
  assert.throws(() => parseCommand(['up'], { SCREEN_RELAY_ICE_SERVERS: 'stun:ok.example.com turn:u:s3cr3t-turn-pass@bad.example.com/path' }), (error) => /Invalid SCREEN_RELAY_ICE_SERVERS/.test(error.message) && !error.message.includes('s3cr3t-turn-pass'));
  const nine = Array.from({ length: 9 }, (_, index) => `stun:h${index}.example.com`);
  assert.throws(() => parseCommand(['up', ...nine.flatMap((server) => ['--ice-server', server])], {}), /At most 8 ICE server entries/);
  assert.equal(parseCommand(['up', ...nine.slice(0, 8).flatMap((server) => ['--ice-server', server])], {})['ice-server'].length, 8);
  assert.equal(parseCommand(['up'], { SCREEN_RELAY_ICE_SERVERS: '' })['ice-server'], undefined);
  assert.equal(parseCommand(['up'], { SCREEN_RELAY_ICE_SERVERS: '   ' })['ice-server'], undefined);
  const oversized = Array.from({ length: 8 }, (_, index) => `turn:u:${'a'.repeat(2100)}@h${index}.example.com`);
  assert.throws(() => parseCommand(['up'], { SCREEN_RELAY_ICE_SERVERS: oversized.join(' ') }), /16 KiB limit/);

  const detached = detachedSupervisorSpawn(
    ['up', '-d', '--ice-server', servers[0], `--ice-server=${servers[1]}`, '--port', '8081'],
    { PATH: '/usr/bin', SCREEN_RELAY_ICE_SERVERS: servers.join(' ') },
    join(directory, 'desk', 'ice-servers'),
  );
  assert.deepEqual(detached.args, ['up', '-d', '--port', '8081']);
  assert.equal(detached.env.SCREEN_RELAY_ICE_SERVERS, undefined);
  assert.equal(detached.env.SCREEN_RELAY_ICE_SERVERS_FILE, join(directory, 'desk', 'ice-servers'));
  assert.equal(detached.env.SCREEN_RELAY_READY_FD, '3');
  assert.ok(!JSON.stringify(detached).includes('user:pass'));
  assert.equal(detachedSupervisorSpawn(['up', '-d'], {}, undefined).env.SCREEN_RELAY_ICE_SERVERS_FILE, undefined);
});

test('an empty SCREEN_RELAY_CONFIG is treated as unset', () => {
  assert.equal(parseCommand(['up'], { SCREEN_RELAY_CONFIG: '' }).config, undefined);
});

test('macOS attaches with its backend and starts apps without display variables', { skip: process.platform !== 'darwin' }, async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const keys = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'SCREEN_RELAY_TEST_BACKENDS'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const engine = join(directory, 'relay-engine');
  const stateHome = join(directory, 'state');
  const sessionDir = join(stateHome, 'screen-relay', 'desk');
  let session;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.assign(process.env, { DISPLAY: ':9', WAYLAND_DISPLAY: 'wayland-9', XAUTHORITY: '/tmp/auth', XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: join(directory, 'session-config'), SCREEN_RELAY_TEST_BACKENDS: 'macos' });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(engine, `#!/usr/bin/env node
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--help')) {
  console.log('Compiled backends: ' + process.env.SCREEN_RELAY_TEST_BACKENDS);
} else if (process.argv.includes('invalid-output')) {
  console.error('Display invalid-output not found; active displays: 77 (1x1 points)');
  process.exitCode = 1;
} else {
  writeFileSync(process.env.SCREEN_RELAY_SESSION + '/engine-invocation.json', JSON.stringify({ args: process.argv.slice(2), env: process.env }));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(image); }).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, pid: process.pid })));
}
`, { mode: 0o755 });

    assert.equal(resolveBackend(undefined), 'macos');
    for (const backend of ['x11', 'wayland']) assert.throws(() => resolveBackend(backend), { reason: 'invalid_input' });
    process.env.SCREEN_RELAY_TEST_BACKENDS = 'x11';
    assert.throws(() => resolveBackend(undefined), { reason: 'missing_dependency' });
    process.env.SCREEN_RELAY_TEST_BACKENDS = 'macos';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    assert.throws(() => resolveBackend('macos'), { reason: 'invalid_input' });
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    session = new Session({ command: 'up', json: true, name: 'desk', port, desktop: 'xfce', output: '77', resolution: '1280x720', fps: 60, bitrateMin: 1000000, bitrateStart: 8000000, bitrateMax: 40000000, timeout: 5 }, sessionDir);
    const info = await session.start();
    assert.equal(info.resolution, '1x1');
    assert.equal(session.data.backend, 'macos');
    assert.equal(session.data.desktop, 'none');
    assert.equal(session.data.ownsDisplay, false);
    assert.deepEqual(Object.keys(session.data.components), ['engine']);
    const invocation = JSON.parse(readFileSync(join(sessionDir, 'engine-invocation.json'), 'utf8'));
    assert.deepEqual(invocation.args.slice(-6), ['--backend', 'macos', '--output', '77', '--token-file', join(sessionDir, 'token')]);
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) assert.equal(invocation.env[key], undefined);

    process.env.XDG_CONFIG_HOME = join(directory, 'different-config');
    const app = "process.stdout.write(JSON.stringify({ DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XAUTHORITY: process.env.XAUTHORITY, SCREEN_RELAY_SESSION: process.env.SCREEN_RELAY_SESSION, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }))";
    assert.equal(await cmdRun({ command: 'run', json: true, name: 'desk', app: process.execPath, args: ['-e', app] }), 0);
    const appEnv = JSON.parse(readFileSync(join(sessionDir, 'apps.log'), 'utf8'));
    assert.deepEqual(appEnv, { SCREEN_RELAY_SESSION: sessionDir, XDG_CONFIG_HOME: join(directory, 'session-config') });
    await session.cleanup();
    session = undefined;

    const badDir = join(stateHome, 'screen-relay', 'bad');
    mkdirSync(badDir, { recursive: true });
    session = new Session({ command: 'up', json: true, name: 'bad', port, output: 'invalid-output', resolution: '1280x720', fps: 60, bitrateMin: 1000000, bitrateStart: 8000000, bitrateMax: 40000000, timeout: 5 }, badDir);
    await assert.rejects(session.start(), { reason: 'component_failed', message: /Display invalid-output not found; active displays: 77/ });
  } finally {
    if (session) await session.cleanup();
    rmSync(engine, { force: true });
    if (platform) Object.defineProperty(process, 'platform', platform);
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('up forwards the encoder and every ICE server to the engine', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const keys = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'SCREEN_RELAY_ENCODER', 'SCREEN_RELAY_ICE_SERVERS'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const engine = join(directory, 'relay-engine');
  const sessionDir = join(directory, 'encode-session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(engine, `#!/usr/bin/env node
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--help')) {
  console.log('Compiled backends: macos');
} else {
  writeFileSync(process.env.SCREEN_RELAY_SESSION + '/engine-invocation.json', JSON.stringify({ args: process.argv.slice(2) }));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(image); }).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, pid: process.pid })));
}
`, { mode: 0o755 });
  let session;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.assign(process.env, { XDG_STATE_HOME: join(directory, 'encode-state'), XDG_CONFIG_HOME: join(directory, 'encode-config') });
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'SCREEN_RELAY_ENCODER', 'SCREEN_RELAY_ICE_SERVERS']) delete process.env[key];
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const servers = ['stun:stun.example.com', 'turns:user:pass@turn.example.com:5349?transport=tcp'];
    session = new Session({ command: 'up', json: true, name: 'encode', port, resolution: '1280x720', fps: 60, bitrateMin: 1000000, bitrateStart: 8000000, bitrateMax: 40000000, timeout: 5, encoder: 'x264', 'ice-server': servers }, sessionDir);
    await session.start();
    const { args } = JSON.parse(readFileSync(join(sessionDir, 'engine-invocation.json'), 'utf8'));
    const encoder = args.indexOf('--encoder');
    assert.deepEqual(args.slice(encoder, encoder + 2), ['--encoder', 'x264']);
    assert.ok(!args.includes('--ice-server'));
    assert.ok(!args.some((value) => value.includes('user:pass')));
    const iceFileFlag = args.indexOf('--ice-servers-file');
    assert.ok(iceFileFlag >= 0);
    const iceFilePath = args[iceFileFlag + 1];
    assert.equal(readFileSync(iceFilePath, 'utf8'), `${servers.join('\n')}\n`);
    if (process.platform !== 'win32') assert.equal(statSync(iceFilePath).mode & 0o777, 0o600);
    await session.cleanup();
    session = undefined;
    assert.equal(existsSync(iceFilePath), false);

    writePrivateFile(iceFilePath, `${servers.join('\n')}\n`);
    session = new Session({ command: 'up', json: true, name: 'encode', port, resolution: '1280x720', fps: 60, bitrateMin: 1000000, bitrateStart: 8000000, bitrateMax: 40000000, timeout: 5, 'ice-servers-file': iceFilePath }, sessionDir);
    await session.start();
    const prepared = JSON.parse(readFileSync(join(sessionDir, 'engine-invocation.json'), 'utf8')).args;
    assert.equal(prepared[prepared.indexOf('--ice-servers-file') + 1], iceFilePath);
    assert.ok(!prepared.some((value) => value.includes('user:pass')));
    assert.equal(readFileSync(iceFilePath, 'utf8'), `${servers.join('\n')}\n`);
    await session.cleanup();
    session = undefined;
    assert.equal(existsSync(iceFilePath), false);
  } finally {
    if (session) await session.cleanup();
    rmSync(engine, { force: true });
    if (platform) Object.defineProperty(process, 'platform', platform);
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('a private session file replaces a symlink at its path instead of writing through it', { skip: process.platform === 'win32' }, () => {
  const target = join(directory, 'symlink-target.txt');
  writeFileSync(target, 'keep');
  const path = join(directory, 'symlink-ice-servers');
  symlinkSync(target, path);
  writePrivateFile(path, 'turn:user:pass@turn.example.com:3478\n');
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.equal(readFileSync(path, 'utf8'), 'turn:user:pass@turn.example.com:3478\n');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  rmSync(path, { force: true });
  rmSync(target, { force: true });
});

test('down removes a private ICE server file left in the session directory', () => {
  const state = join(directory, 'down-state');
  const sessionDir = join(state, 'screen-relay', 'desk');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const file = join(sessionDir, 'ice-servers');
  writeFileSync(file, 'turn:user:pass@turn.example.com:3478\n', { mode: 0o600 });
  const result = spawnSync(process.execPath, [cli, 'down', '--name', 'desk', '--json'], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, XDG_STATE_HOME: state },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(file), false);
});

test('--public keeps the engine on loopback unless a bind address is supplied', { skip: process.platform !== 'linux' }, async () => {
  const engine = join(directory, 'relay-engine');
  writeFileSync(engine, `#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

if (process.argv.includes('--help')) {
  console.log('Compiled backends: x11');
} else {
  const option = (name) => process.argv[process.argv.indexOf(name) + 1];
  const token = readFileSync(option('--token-file'), 'utf8').trim();
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const listener = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(image);
  });
  listener.listen(Number(option('--port')), option('--bind'), () => {
    console.log(JSON.stringify({ ready: true, pid: process.pid, bind: listener.address().address }));
  });
}
`, { mode: 0o755 });
  try {
    for (const [bind, expected] of [[undefined, '127.0.0.1'], ['127.0.0.1', '127.0.0.1'], ['0.0.0.0', '0.0.0.0']]) {
      const probe = createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port;
      await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
      const sessionDir = mkdtempSync(join(directory, 'proxy-'));
      const session = new Session({ command: 'up', json: true, name: 'proxy', port, bind,
        backend: 'x11', display: ':77', desktop: 'none', public: 'https://desk.example.com',
        resolution: '1280x720', fps: 60, bitrateMin: 1000000, bitrateStart: 8000000, bitrateMax: 40000000, timeout: 5 }, sessionDir);
      try {
        const info = await session.start();
        assert.equal(info.bind, expected);
        const started = JSON.parse(readFileSync(join(sessionDir, 'engine.log'), 'utf8').trim());
        assert.equal(started.bind, expected);
        assert.equal(info.url, 'https://desk.example.com');
        assert.equal((await fetch(`http://127.0.0.1:${port}/screenshot.png`)).status, 401);
      } finally {
        await session.cleanup();
      }
    }
  } finally {
    rmSync(engine, { force: true });
  }
});

test('startup output points a public direct TLS session at --bind when it stays on loopback', () => {
  const base = { name: 'desk', viewer: 'https://desk.example.com/#token=abc', logs: '/tmp/desk', url: 'https://desk.example.com', port: 8080, public: true };
  const tls = { 'tls-cert': 'cert.pem' };
  const loopback = formatReady({ ...base, bind: '127.0.0.1' }, tls);
  assert.ok(loopback.includes('127.0.0.1:8080; pass --bind <ADDR> to accept remote clients'));
  assert.ok(!loopback.includes('TLS proxy'));
  assert.ok(!formatReady({ ...base, bind: '0.0.0.0' }, tls).includes('pass --bind'));
  const proxy = formatReady({ ...base, bind: '127.0.0.1' }, {});
  assert.ok(proxy.includes('Forward https://desk.example.com to http://127.0.0.1:8080'));
  assert.ok(!proxy.includes('pass --bind'));
  assert.ok(!formatReady({ ...base, public: false, url: 'http://127.0.0.1:8080', bind: '127.0.0.1' }, {}).includes('Listening'));
  assert.ok(formatReady({ ...base, public: false, url: 'http://0.0.0.0:8080', bind: '0.0.0.0' }, {}).includes('use a loopback port publish or SSH tunnel'));
});

test('--json failures write one JSON line to stderr and nothing to stdout', () => {
  for (const [argv, exit] of [
    [['frob'], 2],
    [['click', '2', '0.5'], 2],
    [['status', '--url', 'http://127.0.0.1:1'], 1],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...argv, '--json'], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, SCREEN_RELAY_URL: '', SCREEN_RELAY_TOKEN_FILE: '' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, exit, `${argv.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^[^\r\n]+\n$/);
    const error = JSON.parse(result.stderr);
    assert.ok(['error', 'action_required'].includes(error.status));
    assert.match(error.reason, /^[a-z][a-z0-9_]*$/);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
  }
});

test('invalid URL diagnostics redact credentials and query strings', () => {
  for (const [url, safe] of [
    ['https://user:abc@def@[?token=secret', 'https:'],
    ['https://user:abc def@[', 'https:'],
    ['https://user:abc@example.com/path?token=secret', 'https://example.com/path'],
  ]) {
    const result = spawnSync(process.execPath, [cli, 'status', '--url', url], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stderr, /user|abc|def|secret/);
    assert.ok(result.stderr.includes(`Invalid server URL: ${safe}`));
  }
});

test('invalid URL recovery is a sentence in human mode and has no next command in --json', () => {
  const env = { ...process.env, SCREEN_RELAY_URL: '', SCREEN_RELAY_TOKEN_FILE: '' };
  const json = spawnSync(process.execPath, [cli, 'status', '--url', 'ftp://example.com', '--json'], { encoding: 'utf8', timeout: 15000, env });
  assert.ifError(json.error);
  assert.equal(json.status, 2);
  assert.equal(JSON.parse(json.stderr).next, undefined);
  const human = spawnSync(process.execPath, [cli, 'status', '--url', 'ftp://example.com'], { encoding: 'utf8', timeout: 15000, env });
  assert.ifError(human.error);
  assert.equal(human.status, 2);
  assert.match(human.stderr, /\n {2}Use an HTTPS origin or a local address:\n {4}Pass --url https:\/\/desktop\.example\.com or --url http:\/\/127\.0\.0\.1:8080\.\n$/);
});

test('up and install refuse to install system packages without a terminal unless --yes is passed', { skip: process.platform !== 'linux' && process.platform !== 'darwin' }, () => {
  const empty = join(directory, 'no-tools');
  mkdirSync(empty, { recursive: true });
  const env = { ...process.env, PATH: empty, XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'setup-state'), XDG_CONFIG_HOME: join(directory, 'setup-config'), SCREEN_RELAY_AGENT: '1' };
  delete env.SCREEN_RELAY_BACKEND;
  const flag = process.platform === 'darwin' ? '' : ' --backend x11';
  for (const argv of [['up', '-d', '--json'], ['install', '--json']]) {
    const result = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', timeout: 15000, env });
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.reason, 'missing_input');
    assert.equal(failure.next[0].command, `screen-relay install${flag} --yes`);
  }
});

test('setup installs the XFCE packages only when the requested X11 session uses XFCE', { skip: process.platform !== 'linux' && process.platform !== 'darwin' }, () => {
  const engine = join(directory, 'relay-engine');
  writeFileSync(engine, "#!/bin/sh\necho 'Compiled backends: x11'\n", { mode: 0o755 });
  cpSync(join(root, 'packages.tsv'), join(directory, 'packages.tsv'));
  try {
    assert.deepEqual(planSetup({ backends: ['wayland'] }).groups, ['core', 'x11', 'wayland']);
    assert.deepEqual(planSetup({ backends: ['x11', 'wayland'], desktop: 'none' }).groups, ['core', 'x11', 'wayland']);
    assert.deepEqual(planSetup({ backends: ['x11', 'wayland'] }).groups, ['core', 'x11', 'wayland', 'xfce']);
  } finally {
    rmSync(engine, { force: true });
  }
});

test('install reports a failed build as one JSON error, takes over a setup lock nobody holds, builds once when two run together, and leaves other files alone', { skip: process.platform !== 'linux' && process.platform !== 'darwin', timeout: 120000 }, async () => {
  const tools = join(directory, 'fake-tools');
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, 'make'), `#!/bin/sh
dir=.; backends=; target=
while [ $# -gt 0 ]; do
  case "$1" in -C) dir=$2; shift ;; BACKENDS=*) backends=\${1#BACKENDS=} ;; -*) ;; *) target=$1 ;; esac
  shift
done
[ "$target" = deps ] && exit 0
[ -z "$FAKE_MAKE_FAIL" ] || { echo 'fake compiler error'; exit 2; }
sleep "\${FAKE_MAKE_SLEEP:-0}"
printf '#!/bin/sh\\necho "Compiled backends: %s"\\n' "$(echo "$backends" | sed 's/ /, /g')" > "$dir/relay-engine"
chmod +x "$dir/relay-engine"
`, { mode: 0o755 });
  for (const program of ['setpriv', 'Xvfb', 'xauth']) writeFileSync(join(tools, program), '#!/bin/sh\n', { mode: 0o755 });
  const data = join(directory, 'install-data');
  const engines = join(data, 'screen-relay', 'engine');
  mkdirSync(join(engines, '9.9.9'), { recursive: true });
  writeFileSync(join(engines, '9.9.9', 'relay-engine'), 'old');
  writeFileSync(join(engines, 'notes.txt'), 'keep');
  const env = { ...process.env, PATH: `${tools}:/bin:/usr/bin`, XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(directory, 'install-config'), SCREEN_RELAY_AGENT: '1' };
  for (const key of ['SCREEN_RELAY_BACKEND', 'SCREEN_RELAY_DESKTOP', 'SCREEN_RELAY_CONFIG']) delete env[key];
  const argv = [cli, 'install', '--json', ...(process.platform === 'darwin' ? [] : ['--backend', 'x11', '--desktop', 'none'])];
  const install = (extra = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { env: { ...env, ...extra } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  for (const abandoned of ['', JSON.stringify({ pid: process.pid, start: 'an earlier process' })]) {
    writeFileSync(join(data, 'screen-relay', 'setup.lock'), abandoned);
    const failed = await install({ FAKE_MAKE_FAIL: '1' });
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(failed.stdout, '');
    const failure = JSON.parse(failed.stderr);
    assert.equal(failure.reason, 'missing_dependency');
    assert.match(failure.data.log, /fake compiler error/);
  }

  const both = await Promise.all([install({ FAKE_MAKE_SLEEP: '1' }), install({ FAKE_MAKE_SLEEP: '1' })]);
  for (const result of both) assert.deepEqual([result.status, result.stderr], [0, '']);
  assert.deepEqual(both.map((result) => JSON.parse(result.stdout).outcome).sort(), ['installed', 'unchanged']);
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(readdirSync(engines).sort(), ['9.9.9', version, 'notes.txt'].sort());
  assert.equal(readFileSync(join(engines, 'notes.txt'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(engines, '9.9.9', 'relay-engine'), 'utf8'), 'old');
  assert.equal(existsSync(join(data, 'screen-relay', 'setup.lock')), false);
});

test('a skill name used as the skills action points at its get command', () => {
  const env = { ...process.env, SCREEN_RELAY_AGENT: '0', SCREEN_RELAY_URL: '', SCREEN_RELAY_TOKEN_FILE: '' };
  const human = spawnSync(process.execPath, [cli, 'skills', 'core'], { encoding: 'utf8', timeout: 15000, env });
  assert.ifError(human.error);
  assert.equal(human.status, 2);
  assert.match(human.stderr, /relay skills get core/);
  const json = spawnSync(process.execPath, [cli, 'skills', 'core', '--json'], { encoding: 'utf8', timeout: 15000, env });
  assert.ifError(json.error);
  assert.equal(json.status, 2);
  assert.deepEqual(JSON.parse(json.stderr).next, [{ command: 'screen-relay skills get core', argv: ['screen-relay', 'skills', 'get', 'core'] }]);
});

const help = (value, argv = ['--help']) => spawnSync(process.execPath, [cli, ...argv], {
  encoding: 'utf8',
  timeout: 15000,
  env: { ...process.env, SCREEN_RELAY_AGENT: value },
});

test('human help is piped plain text with the command hint', () => {
  for (const argv of [['--help'], ['click', '--help'], ['skills', '--help']]) {
    const result = help('0', argv);
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /\u001b\[/);
    assert.doesNotMatch(result.stdout, /Start here \(for AI agents\):/);
  }
  const root = help('0');
  assert.match(root.stdout, /^screen-relay \d+\.\d+\.\d+\n\n▲ screen-relay \[options\] <command>\n\nFor command help, run `screen-relay <command> --help`\n\nHost commands \(run on the Linux, macOS, or Windows machine that shows the desktop\):\n\n {4}up /);
  const click = help('0', ['click', '--help']);
  assert.match(click.stdout, /^click\n\n▲ screen-relay click <x> <y> \[options\]\n\nClick at screen coordinates\nRuns on the host, or on another machine with --url and a token file\.\n\nOptions:\n\n {4}--button <BUTTON> +Select the mouse button\. Values: left, middle, right \[default: left\]\n/);
  assert.match(click.stdout, /– Click the center\n\n {2}\$ screen-relay click 0\.5 0\.5\n\n$/);
});

test('human help lists up under the host section and click under the client section', () => {
  const result = help('0');
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  const vm = result.stdout.slice(result.stdout.indexOf('Host commands'), result.stdout.indexOf('Client commands'));
  assert.match(vm, /^ {4}up /m);
  assert.doesNotMatch(vm, /^ {4}click /m);
  const client = result.stdout.slice(result.stdout.indexOf('Client commands'), result.stdout.indexOf('Other commands'));
  assert.match(client, /^ {4}click /m);
  assert.doesNotMatch(client, /^ {4}up /m);
});

test('human help shows command notes before the examples', () => {
  const result = help('0', ['up', '--help']);
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\n\nNotes:\n\n {4}Without --detach, Ctrl\+C stops the session\.\n/);
  assert.ok(result.stdout.indexOf('Notes:') < result.stdout.indexOf('Examples:'));
});

test('SCREEN_RELAY_AGENT=1 help keeps the agent block as plain text', () => {
  const result = help('1');
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Start here \(for AI agents\):/);
  assert.doesNotMatch(result.stdout, /For command help, run/);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
});

test('agent detection changes help only', () => {
  const run = (value) => spawnSync(process.execPath, [cli, 'status', '--url', 'ftp://example.com'], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, SCREEN_RELAY_AGENT: value, SCREEN_RELAY_URL: '', SCREEN_RELAY_TOKEN_FILE: '' },
  });
  const off = run('0');
  const on = run('1');
  assert.ifError(off.error);
  assert.ifError(on.error);
  assert.equal(on.status, off.status);
  assert.equal(on.stdout, off.stdout);
  assert.equal(on.stderr, off.stderr);
});

test('piped help and errors contain no ANSI escape codes', () => {
  for (const argv of [['--help'], ['click', '--help'], ['status', '--url', 'https://user:x y@[']]) {
    const result = spawnSync(process.execPath, [cli, ...argv], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, SCREEN_RELAY_AGENT: '0' },
    });
    assert.ifError(result.error);
    assert.doesNotMatch(result.stdout + result.stderr, /\u001b\[/);
  }
});

test('--stdin reads a pipe that is still being written', async () => {
  const received = [];
  const { createServer: createHttpServer } = await import('node:http');
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ length: Buffer.concat(chunks).length }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const child = spawn(process.execPath, [cli, 'clipboard', 'set', '--stdin', '--json', '--url', `http://127.0.0.1:${server.address().port}`], { timeout: 15000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.write('first ');
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.end('second');
    const status = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { clipboard: { bytes: 12 }, outcome: 'set' });
    assert.deepEqual(received, ['first second']);
  } finally { server.close(); }
});

test('clipboard help describes the fields each subcommand prints', async () => {
  const help = spawnSync(process.execPath, [cli, 'help', 'clipboard', '--json'], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(help.error);
  assert.equal(help.status, 0, help.stderr);
  const helpDocument = JSON.parse(help.stdout);
  assert.deepEqual(helpDocument.resultSchema, {});
  const schemas = Object.fromEntries(helpDocument.subcommands.map(({ name, resultSchema }) => [name, resultSchema]));
  const { createServer: createHttpServer } = await import('node:http');
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.method === 'GET' ? { text: 'hello' } : { length: Buffer.concat(chunks).length }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const [action, args] of [['get', ['clipboard', 'get']], ['set', ['clipboard', 'set', 'hello']]]) {
      const child = spawn(process.execPath, [cli, ...args, '--json', '--url', url], { timeout: 15000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      assert.equal(await new Promise((resolve) => child.on('close', resolve)), 0, stderr);
      const printed = JSON.parse(stdout);
      assert.deepEqual(Object.keys(schemas[action]).sort(), Object.keys(printed).sort());
      assert.deepEqual(Object.keys(schemas[action].clipboard).sort(), Object.keys(printed.clipboard).sort());
    }
  } finally { server.close(); }
});
