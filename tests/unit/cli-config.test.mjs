import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'dist/cli/relay.mjs');
const entryPoint = join(root, 'src/cli/config.ts');
const directory = mkdtempSync(join(root, '.cli-config-test-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const nodeBanner = { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" };
const bundle = buildSync({ entryPoints: [entryPoint], bundle: true, external: ['yaml'], platform: 'node', format: 'esm', banner: nodeBanner, write: false });
const bundlePath = join(directory, 'config.mjs');
writeFileSync(bundlePath, bundle.outputFiles[0].contents);
const config = await import(pathToFileURL(bundlePath).href);

function write(text) {
  const path = join(directory, 'config.yaml');
  writeFileSync(path, text);
  return path;
}

test('empty SCREEN_RELAY_CONFIG selects the optional default config', () => {
  const previous = { relayConfig: process.env.SCREEN_RELAY_CONFIG, configHome: process.env.XDG_CONFIG_HOME };
  process.env.SCREEN_RELAY_CONFIG = '';
  process.env.XDG_CONFIG_HOME = directory;
  try {
    assert.deepEqual(config.locate(), [null, false]);
  } finally {
    if (previous.relayConfig === undefined) delete process.env.SCREEN_RELAY_CONFIG;
    else process.env.SCREEN_RELAY_CONFIG = previous.relayConfig;
    if (previous.configHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.configHome;
  }
});

test('loads validated values and keyboard layout', () => {
  const path = write(`
display:
  resolution: 1600x900
stream:
  fps: 30
  bitrate:
    min: 500k
    start: 4M
    max: 20M
server:
  port: 9090
  bind: 0.0.0.0
  public: https://desk.example.com
  allow_origin: https://app.example.com,http://localhost:8081
  tls_cert: /tmp/fullchain.pem
  tls_key: /tmp/key.pem
keyboard:
  layout: fr,us
desktop: none
`);
  const [settings, source, present] = config.loadConfig(path);
  assert.equal(source, path);
  assert.equal(settings.display.resolution, '1600x900');
  assert.equal(settings.stream.fps, 30);
  assert.deepEqual(settings.stream.bitrate, { min: 500000, start: 4000000, max: 20000000 });
  assert.equal(settings.server.port, 9090);
  assert.equal(settings.server.bind, '0.0.0.0');
  assert.equal(settings.server.public, 'https://desk.example.com');
  assert.equal(settings.server.allow_origin, 'https://app.example.com,http://localhost:8081');
  assert.equal(settings.server.tls_cert, '/tmp/fullchain.pem');
  assert.equal(settings.server.tls_key, '/tmp/key.pem');
  assert.equal(settings.keyboard.layout, 'fr,us');
  assert.equal(settings.desktop, 'none');
  assert.ok(present.has('display.resolution'));
});

test('validates server.allow_origin as exact HTTPS or loopback HTTP origins', () => {
  const [settings, , present] = config.loadConfig(write('server:\n  allow_origin: https://app.example.com,http://localhost:8081\n'));
  assert.equal(settings.server.allow_origin, 'https://app.example.com,http://localhost:8081');
  assert.ok(present.has('server.allow_origin'));
  for (const value of ['http://app.example.com', 'http://localhost:80', 'http://LOCALHOST:8081', 'https://App.example.com', 'https://app.example.com/']) {
    assert.throws(() => config.loadConfig(write(`server:\n  allow_origin: ${value}\n`)), /server\.allow_origin/, value);
  }
  assert.throws(() => config.loadConfig(write('server:\n  allow_origin: 8081\n')), /server\.allow_origin.*a string/);

  const previous = process.env.SCREEN_RELAY_ALLOW_ORIGIN;
  try {
    process.env.SCREEN_RELAY_ALLOW_ORIGIN = 'http://localhost:8081';
    const args = {};
    config.applyTo(args, settings, new Set());
    assert.equal(args['allow-origin'], 'http://localhost:8081');
    process.env.SCREEN_RELAY_ALLOW_ORIGIN = 'http://app.example.com';
    assert.throws(() => config.applyTo({}, settings, new Set()), /SCREEN_RELAY_ALLOW_ORIGIN/);
    const explicit = { 'allow-origin': 'https://app.example.com' };
    config.applyTo(explicit, settings, new Set());
    assert.equal(explicit['allow-origin'], 'https://app.example.com');
  } finally {
    if (previous === undefined) delete process.env.SCREEN_RELAY_ALLOW_ORIGIN;
    else process.env.SCREEN_RELAY_ALLOW_ORIGIN = previous;
  }
});

test('validates the FPS range in YAML and keeps the default at 60', () => {
  assert.equal(config.loadConfig(write('{}\n'))[0].stream.fps, 60);
  for (const fps of [10, 60, 61, 240]) {
    assert.equal(config.loadConfig(write(`stream:\n  fps: ${fps}\n`))[0].stream.fps, fps);
  }
  for (const fps of [9, 241]) {
    assert.throws(() => config.loadConfig(write(`stream:\n  fps: ${fps}\n`)), /stream\.fps.*allowed 10\.\.240/);
  }
});

test('validates FPS overrides from arguments and SCREEN_RELAY_FPS', () => {
  const [settings, , present] = config.loadConfig(write('{}\n'));
  const previous = process.env.SCREEN_RELAY_FPS;
  try {
    process.env.SCREEN_RELAY_FPS = '240';
    const args = {};
    config.applyTo(args, settings, present);
    assert.equal(args.fps, 240);
    process.env.SCREEN_RELAY_FPS = '241';
    assert.throws(() => config.applyTo({}, settings, present), /SCREEN_RELAY_FPS.*allowed 10\.\.240/);
    const explicit = { fps: 240 };
    config.applyTo(explicit, settings, present);
    assert.equal(explicit.fps, 240);
    assert.throws(() => config.applyTo({ fps: 241 }, settings, present), /--fps.*allowed 10\.\.240/);
    assert.throws(() => config.applyTo({ fps: 9 }, settings, present), /--fps.*allowed 10\.\.240/);
  } finally {
    if (previous === undefined) delete process.env.SCREEN_RELAY_FPS;
    else process.env.SCREEN_RELAY_FPS = previous;
  }
});

test('rejects unknown keys with their path and valid keys', () => {
  assert.throws(() => config.loadConfig(write('stream:\n  fsp: 30\n')), (error) => {
    assert.equal(error.reason, 'invalid_config');
    assert.match(error.message, /stream\.fsp/);
    assert.match(error.hint, /fps/);
    assert.match(error.hint, /bitrate/);
    return true;
  });
});

test('requires even resolutions within bounds', () => {
  assert.throws(() => config.loadConfig(write('display:\n  resolution: 1281x720\n')), /display\.resolution.*even/);
  assert.equal(config.loadConfig(write('display:\n  resolution: 3840x2160\n'))[0].display.resolution, '3840x2160');
  assert.throws(() => config.loadConfig(write('display:\n  resolution: 16386x1080\n')), /display\.resolution.*320\.\.16384/);
});

test('validates bitrate suffixes and ordering', () => {
  let [settings] = config.loadConfig(write('stream:\n  bitrate:\n    min: 250k\n    start: 8M\n    max: 40M\n'));
  assert.deepEqual(settings.stream.bitrate, { min: 250000, start: 8000000, max: 40000000 });
  assert.throws(() => config.loadConfig(write('stream:\n  bitrate:\n    min: 10M\n    start: 1M\n    max: 40M\n')), /min <= start <= max/);
  assert.throws(() => config.loadConfig(write('stream:\n  fps: 30.0\n')), /stream\.fps.*an integer/);
});

test('rejects invalid UTF-8 as invalid input', () => {
  const path = join(directory, 'invalid.yaml');
  writeFileSync(path, Buffer.from([0x64, 0x65, 0x73, 0x6b, 0x74, 0x6f, 0x70, 0x3a, 0x20, 0xff, 0xfe, 0x0a]));
  assert.throws(() => config.loadConfig(path), (error) => {
    assert.equal(error.reason, 'invalid_config');
    assert.match(error.message, /Cannot read config file/);
    return true;
  });
});

test('flags override file values and bind comes only from the file when set', () => {
  let [settings, , present] = config.loadConfig(write('server:\n  port: 9090\n  bind: 0.0.0.0\ndesktop: none\n'));
  let args = { port: 9000, bind: undefined, public: undefined, 'tls-cert': undefined, 'tls-key': undefined, desktop: undefined };
  config.applyTo(args, settings, present);
  assert.equal(args.port, 9000);
  assert.equal(args.bind, '0.0.0.0');
  assert.equal(args.desktop, 'none');

  [settings, , present] = config.loadConfig(write('server:\n  port: 9090\n'));
  args = { port: undefined, bind: undefined, public: 'https://desk.example.com', 'tls-cert': undefined, 'tls-key': undefined, desktop: undefined };
  config.applyTo(args, settings, present);
  assert.equal(args.bind, undefined);

  [settings, , present] = config.loadConfig(write('server:\n  bind: 192.168.1.5\n'));
  args = { port: undefined, bind: '10.0.0.1', public: undefined, 'tls-cert': undefined, 'tls-key': undefined, desktop: undefined };
  config.applyTo(args, settings, present);
  assert.equal(args.bind, '10.0.0.1');
});

test('defaults keyboard layout to us and validates its allowed characters', () => {
  assert.equal(config.loadConfig()[0].keyboard.layout, 'us');
  assert.throws(() => config.loadConfig(write('keyboard:\n  layout: fr!\n')), /keyboard\.layout/);
  assert.throws(() => config.loadConfig(write('keyboard:\n  layout: 7\n')), /keyboard\.layout.*a string/);
});

test('the compositor setting defaults to auto and accepts only auto, on or off', () => {
  assert.equal(config.loadConfig()[0].display.compositor, 'auto');
  assert.equal(config.loadConfig(write('display:\n  compositor: off\n'))[0].display.compositor, 'off');
  assert.throws(() => config.loadConfig(write('display:\n  compositor: true\n')), /display\.compositor.*auto or on or off/);
});

test('backend from the config file accepts supported names and reports invalid ones', () => {
  for (const backend of ['x11', 'wayland', 'macos']) {
    assert.equal(config.loadConfig(write(`backend: ${backend}\n`))[0].backend, backend);
  }
  assert.throws(() => config.loadConfig(write('backend: mir\n')), /backend.*x11 or wayland or macos/);
});

test('doctor reports an invalid SCREEN_RELAY_BACKEND as a failed check', { skip: process.platform !== 'linux' }, () => {
  const path = write('backend: x11\n');
  const result = spawnSync(process.execPath, [cli, 'doctor', '--config', path, '--json'], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, SCREEN_RELAY_BACKEND: 'wayl' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  const { checks } = JSON.parse(result.stdout);
  const backend = checks.find((item) => item.name === 'backend');
  assert.equal(backend.status, 'fail');
  assert.match(backend.detail, /SCREEN_RELAY_BACKEND.*wayl.*x11 or wayland/);
});

test('loads the encoder and the ICE servers from YAML, defaulting to auto and none', () => {
  const [empty] = config.loadConfig(write('{}\n'));
  assert.equal(empty.stream.encoder, 'auto');
  assert.equal(empty.server.ice_servers, null);
  const servers = ['stun:stun.example.com', 'turns:user:pass@turn.example.com:5349?transport=tcp'];
  const [settings, , present] = config.loadConfig(write(`stream:\n  encoder: x264\nserver:\n  ice_servers:\n    - ${servers[0]}\n    - ${servers[1]}\n`));
  assert.equal(settings.stream.encoder, 'x264');
  assert.deepEqual(settings.server.ice_servers, servers);
  assert.ok(present.has('stream.encoder'));
  assert.ok(present.has('server.ice_servers'));
  const args = {};
  config.applyTo(args, settings, present);
  assert.equal(args.encoder, 'x264');
  assert.deepEqual(args['ice-server'], servers);
});

test('accepts only encoder names of letters, digits and underscores', () => {
  for (const value of ['auto', 'x264', 'h264_videotoolbox', 'H264']) assert.ok(config.encoderName(value), value);
  for (const value of ['', 'x 264', 'x264!', 'x-264', 'x.264']) assert.equal(config.encoderName(value), false, value);
  assert.throws(() => config.loadConfig(write('stream:\n  encoder: x-264\n')), /stream\.encoder/);
  assert.throws(() => config.loadConfig(write('stream:\n  encoder: ""\n')), /stream\.encoder.*a non-empty string/);
});

test('accepts the STUN and TURN server URLs that the engine accepts', () => {
  for (const value of ['stun:stun.example.com', 'stun:127.0.0.1:3478', 'stun:[::1]', 'stun:[2001:db8::1]:3478',
    'turn:turn.example.com:3478', 'turn:user:pass@turn.example.com:3478?transport=udp', 'turns:user:pass@turn.example.com:5349?transport=tcp']) {
    assert.equal(config.iceServerSpec(value), true, value);
  }
  for (const value of ['', 'stun:', 'STUN:stun.example.com', 'http:stun.example.com', 'stun:user@stun.example.com', 'stun:stun.example.com?transport=udp',
    'stun:stun.example.com:0', 'stun:stun.example.com:08080', 'stun:stun.example.com:65536', 'stun:-stun.example.com',
    'stun:stun.example.com.', 'stun:host/path', 'stun:host#fragment', 'stun:[]', 'stun:[::1]x', 'turn:user@turn.example.com',
    'turn:user:pass@', 'turn:user:pass@turn.example.com:0', 'turn:user:pa:ss@turn.example.com', 'turn:@turn.example.com',
    'turn:user:@turn.example.com', 'turn:turn.example.com?transport=sctp', 'turn:turn.example.com:3478?transport=tcp?x',
    'turn:turn.example.com:3478?transport=TCP']) {
    assert.equal(config.iceServerSpec(value), false, value);
  }
  assert.throws(() => config.loadConfig(write('server:\n  ice_servers:\n    - stun:user@stun.example.com\n')), /server\.ice_servers/);
  assert.throws(() => config.loadConfig(write('server:\n  ice_servers:\n    url: stun:stun.example.com\n')), /server\.ice_servers.*a list/);
  assert.throws(() => config.loadConfig(write('server:\n  ice_servers: stun:stun.example.com\n')), /server\.ice_servers.*a list/);
  assert.throws(() => config.loadConfig(write('server:\n  ice_servers: [turn:u:s3cr3t-yaml-pass@turn.example.com\n')), (error) => !error.message.includes('s3cr3t-yaml-pass'));
});

test('the encoder and the ICE servers come from the environment, and flags win', () => {
  const [settings, , present] = config.loadConfig(write('{}\n'));
  const previous = { encoder: process.env.SCREEN_RELAY_ENCODER, servers: process.env.SCREEN_RELAY_ICE_SERVERS };
  const servers = ['stun:stun.example.com', 'turn:user:pass@turn.example.com:3478?transport=tcp'];
  try {
    process.env.SCREEN_RELAY_ENCODER = 'x264';
    process.env.SCREEN_RELAY_ICE_SERVERS = servers.join(' ');
    const args = {};
    config.applyTo(args, settings, present);
    assert.equal(args.encoder, 'x264');
    assert.deepEqual(args['ice-server'], servers);

    const explicit = { encoder: 'h264_videotoolbox', 'ice-server': ['stun:flags.example.com'] };
    config.applyTo(explicit, settings, present);
    assert.equal(explicit.encoder, 'h264_videotoolbox');
    assert.deepEqual(explicit['ice-server'], ['stun:flags.example.com']);

    process.env.SCREEN_RELAY_ENCODER = 'x 264';
    assert.throws(() => config.applyTo({}, settings, present), /SCREEN_RELAY_ENCODER/);
    process.env.SCREEN_RELAY_ENCODER = 'x264';

    process.env.SCREEN_RELAY_ICE_SERVERS = Array.from({ length: 8 }, (_, index) => `stun:h${index}.example.com`).join(' ');
    const capped = {};
    config.applyTo(capped, settings, present);
    assert.equal(capped['ice-server'].length, 8);

    process.env.SCREEN_RELAY_ICE_SERVERS = Array.from({ length: 9 }, (_, index) => `turn:u:s3cr3t-turn-pass@h${index}.example.com`).join(' ');
    assert.throws(() => config.applyTo({}, settings, present), (error) => /SCREEN_RELAY_ICE_SERVERS.*at most 8/.test(error.message) && !error.message.includes('s3cr3t-turn-pass'));
    process.env.SCREEN_RELAY_ICE_SERVERS = 'stun:ok.example.com turn:u:s3cr3t-turn-pass@bad.example.com/path';
    assert.throws(() => config.applyTo({}, settings, present), (error) => /SCREEN_RELAY_ICE_SERVERS\[1\]/.test(error.message) && !error.message.includes('s3cr3t-turn-pass'));
    assert.throws(() => config.loadConfig(write('server:\n  ice_servers:\n    - turn:u:s3cr3t-turn-pass@bad.example.com/path\n')), (error) => /server\.ice_servers\[0\]/.test(error.message) && !error.message.includes('s3cr3t-turn-pass'));
    assert.throws(() => config.loadConfig(write(`server:\n  ice_servers:\n${Array.from({ length: 9 }, (_, index) => `    - turn:u:s3cr3t-turn-pass@h${index}.example.com\n`).join('')}`)), (error) => /server\.ice_servers.*at most 8/.test(error.message) && !error.message.includes('s3cr3t-turn-pass'));
    assert.throws(() => config.applyTo({ 'ice-server': Array.from({ length: 9 }, (_, index) => `stun:h${index}.example.com`) }, settings, present), /at most 8 STUN or TURN server URLs/);
    const [fromYaml, , yamlPresent] = config.loadConfig(write('server:\n  ice_servers:\n    - stun:config.example.com\n'));
    process.env.SCREEN_RELAY_ICE_SERVERS = '';
    const preserved = {};
    config.applyTo(preserved, fromYaml, yamlPresent);
    assert.deepEqual(preserved['ice-server'], ['stun:config.example.com']);
    const oversized = Array.from({ length: 8 }, (_, index) => `turn:u:${'a'.repeat(2100)}@h${index}.example.com`);
    assert.throws(() => config.applyTo({ 'ice-server': oversized }, settings, present), /at most 16384 bytes/);
  } finally {
    for (const [key, value] of Object.entries({ SCREEN_RELAY_ENCODER: previous.encoder, SCREEN_RELAY_ICE_SERVERS: previous.servers })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
