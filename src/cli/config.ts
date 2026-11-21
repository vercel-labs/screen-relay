import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspect, TextDecoder } from 'node:util';
import { parseDocument } from 'yaml';
import { Failure } from './output.js';

export const BACKENDS = ['x11', 'wayland', 'macos', 'windows'] as const;
export const COMPOSITORS = ['auto', 'on', 'off'] as const;

export type ConfigSettings = {
  display: { resolution: string; compositor: (typeof COMPOSITORS)[number] };
  stream: { fps: number; bitrate: { min: number; start: number; max: number }; encoder: string };
  server: { port: number; bind: string; public: string | null; allow_origin: string | null; tls_cert: string | null; tls_key: string | null; ice_servers: string[] | null };
  keyboard: { layout: string };
  desktop: string;
  backend?: string;
};

type Mapping = Record<string, unknown>;
type ConfigSection = 'display' | 'stream' | 'server' | 'keyboard';

const SECTIONS: Record<ConfigSection, readonly string[]> = {
  display: ['resolution', 'compositor'],
  stream: ['fps', 'bitrate', 'encoder'],
  server: ['port', 'bind', 'public', 'allow_origin', 'tls_cert', 'tls_key', 'ice_servers'],
  keyboard: ['layout'],
};
const ROOT_KEYS = ['display', 'stream', 'server', 'keyboard', 'desktop', 'backend'];
const BITRATE_KEYS = ['min', 'start', 'max'];
const RESOLUTION = /^([0-9]+)x([0-9]+)$/;
const BITRATE = /^([0-9]+)([kM]?)$/;

function expandUser(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function locate(path?: string): [string | null, boolean] {
  if (path !== undefined) return [expandUser(path), true];
  const environment = process.env.SCREEN_RELAY_CONFIG;
  if (environment) return [expandUser(environment), true];
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const defaultPath = join(configHome, 'screen-relay', 'config.yaml');
  return [isFile(defaultPath) ? defaultPath : null, false];
}

function isMapping(value: unknown): value is Mapping {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function valueRepr(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'object') return inspect(value, { depth: 3, colors: false });
  return String(value);
}

function readConfig(source: string): Mapping {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(source));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Failure('invalid_input', `Cannot read config file ${source}: ${detail}`, 'Check --config or SCREEN_RELAY_CONFIG.');
  }
  let data: unknown;
  try {
    const document = parseDocument(text, { intAsBigInt: true });
    if (document.errors.length) {
      const summaries = document.errors.map((error) => error.message.split('\n')[0] ?? 'YAML syntax error');
      throw new Failure('invalid_input', summaries.join('\n'), 'Fix the YAML syntax.');
    }
    data = document.toJS();
  } catch (error) {
    if (error instanceof Failure) throw error;
    const detail = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'YAML syntax error';
    throw new Failure('invalid_input', `Cannot parse config file ${source}: ${detail}`, 'Fix the YAML syntax.');
  }
  if (data === null) return {};
  if (!isMapping(data)) throw new Failure('invalid_input', `Config file ${source} must be a mapping at the top level`);
  return data;
}

function checkKeys(data: Mapping, allowed: readonly string[], prefix: string, errors: Failure[]): void {
  const base = prefix ? `${prefix}.` : '';
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) {
      errors.push(new Failure('invalid_input', `Unknown config key "${base}${key}"`, `Valid keys at ${prefix || 'the top level'}: ${allowed.join(', ')}.`));
    }
  }
}

function wrong(path: string, value: unknown, expected: string): never {
  throw new Failure('invalid_input', `Invalid config value for ${path}: ${valueRepr(value)}; expected ${expected}`);
}

function wrongSensitive(path: string, expected: string): never {
  throw new Failure('invalid_input', `Invalid config value for ${path}; expected ${expected}`);
}

function outOfRange(path: string, value: unknown, low: number, high: number): never {
  throw new Failure('invalid_input', `Invalid config value for ${path}: ${valueRepr(value)}; allowed ${low}..${high}`, `Set ${path} between ${low} and ${high}.`);
}

function integer(value: unknown, path: string, low: number, high: number): number {
  if (typeof value !== 'bigint') wrong(path, value, 'an integer');
  if (value < BigInt(low) || value > BigInt(high)) outOfRange(path, value, low, high);
  return Number(value);
}

function textValue(value: unknown, path: string): string {
  if (typeof value !== 'string') wrong(path, value, 'a string');
  if (!value.trim()) wrong(path, value, 'a non-empty string');
  return value;
}

const HTTPS_ORIGIN = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/;
const LOOPBACK_HTTP_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(?::([1-9][0-9]{0,4}))?$/;

function portAllowed(port: string | undefined, excluded: number): boolean {
  return port === undefined || (Number(port) <= 65535 && Number(port) !== excluded);
}

/** Reports whether a value is 1 to 16 comma-separated exact HTTPS or loopback HTTP origins, written the way a browser sends them. */
export function allowedOrigins(value: unknown): boolean {
  const origins = String(value).split(',');
  return origins.length <= 16 && origins.every((origin) => {
    const secure = HTTPS_ORIGIN.exec(origin);
    if (secure) return portAllowed(secure[2], 443);
    const local = LOOPBACK_HTTP_ORIGIN.exec(origin);
    return local !== null && portAllowed(local[2], 80);
  });
}

/** Reports whether a value is an encoder name: letters, digits and underscores, and never empty. */
export function encoderName(value: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(value);
}

const ICE_SCHEMES = ['stun:', 'turn:', 'turns:'] as const;
const MAX_ICE_SERVERS = 8;
export const MAX_ICE_SERVERS_BYTES = 16384;

function iceHostname(host: string): boolean {
  if (!host || host.startsWith('.') || host.endsWith('.') || host.startsWith('-') || host.endsWith('-')) return false;
  return host.split('.').every((label) => label !== '' && !label.startsWith('-') && !label.endsWith('-') && /^[A-Za-z0-9-]+$/.test(label));
}

function iceIpv6(host: string): boolean {
  return host !== '' && host.includes(':') && !host.startsWith('.') && !host.endsWith('.') && !host.includes('..') && /^[0-9A-Fa-f:.]+$/.test(host);
}

function icePort(text: string): boolean {
  return /^[1-9][0-9]{0,4}$/.test(text) && Number(text) <= 65535;
}

/** Reports whether a TURN or TURNS server URL carries embedded userinfo credentials. */
export function iceServerHasCredentials(spec: string): boolean {
  const scheme = ICE_SCHEMES.find((candidate) => spec.startsWith(candidate));
  if (!scheme || scheme === 'stun:') return false;
  const authority = spec.slice(scheme.length);
  const query = authority.indexOf('?');
  const hostPart = query >= 0 ? authority.slice(0, query) : authority;
  return hostPart.includes('@');
}

/** Reports whether a value is a STUN or TURN server URL in the form the engine accepts. */
export function iceServerSpec(spec: string): boolean {
  if (!spec) return false;
  for (const character of spec) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return false;
  }
  if (spec.includes('#') || spec.includes('/')) return false;
  const scheme = ICE_SCHEMES.find((candidate) => spec.startsWith(candidate));
  if (!scheme) return false;
  let authority = spec.slice(scheme.length);
  if (!authority) return false;
  const secure = scheme !== 'stun:';
  if (secure) {
    const at = authority.indexOf('@');
    if (at >= 0) {
      const userinfo = authority.slice(0, at);
      const colon = userinfo.indexOf(':');
      if (!userinfo || colon <= 0 || colon === userinfo.length - 1 || userinfo.indexOf(':', colon + 1) >= 0 || /[@?]/.test(userinfo)) return false;
      authority = authority.slice(at + 1);
      if (!authority) return false;
    }
  } else if (authority.includes('@')) return false;
  const query = authority.indexOf('?');
  if (query >= 0) {
    if (!secure) return false;
    const transport = authority.slice(query);
    if (transport !== '?transport=udp' && transport !== '?transport=tcp') return false;
    authority = authority.slice(0, query);
  }
  if (!authority) return false;
  let host = '';
  let port = '';
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0 || close === 1) return false;
    host = authority.slice(1, close);
    if (!iceIpv6(host)) return false;
    if (close + 1 < authority.length) {
      if (authority[close + 1] !== ':') return false;
      port = authority.slice(close + 2);
      if (!port) return false;
    }
  } else {
    const colon = authority.indexOf(':');
    if (colon >= 0) {
      if (authority.indexOf(':', colon + 1) >= 0) return false;
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
      if (!port) return false;
    } else host = authority;
    if (!iceHostname(host)) return false;
  }
  return host !== '' && (!port || icePort(port));
}

/** Reads up to eight ICE server URLs (at most 16 KiB serialized) from a YAML list, collected flags, or a whitespace-separated environment value. */
export function iceServersList(value: unknown, path: string, allowString = true): string[] {
  const entries: unknown[] = allowString && typeof value === 'string'
    ? value.split(/\s+/).filter(Boolean)
    : Array.isArray(value) ? value : wrongSensitive(path, 'a list of STUN or TURN server URLs');
  if (entries.length > MAX_ICE_SERVERS) wrongSensitive(path, `at most ${MAX_ICE_SERVERS} STUN or TURN server URLs`);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (typeof entry !== 'string' || !iceServerSpec(entry)) wrongSensitive(`${path}[${index}]`, 'a STUN or TURN URL such as stun:stun.example.com or turn:user:pass@turn.example.com:3478?transport=udp');
  }
  const list = entries as string[];
  if (list.length && Buffer.byteLength(`${list.join('\n')}\n`, 'utf8') > MAX_ICE_SERVERS_BYTES) {
    wrongSensitive(path, `at most ${MAX_ICE_SERVERS_BYTES} bytes of STUN or TURN server URLs`);
  }
  return list;
}

export function backendValue(value: unknown, path: string): (typeof BACKENDS)[number] {
  const text = textValue(value, path);
  const backend = BACKENDS.find((candidate) => candidate === text);
  if (!backend) wrong(path, value, BACKENDS.join(' or '));
  return backend;
}

function compositorValue(value: unknown, path: string): (typeof COMPOSITORS)[number] {
  const compositor = COMPOSITORS.find((candidate) => candidate === value);
  if (!compositor) wrong(path, value, COMPOSITORS.join(' or '));
  return compositor;
}

function resolution(value: unknown, path: string): string {
  if (typeof value !== 'string') wrong(path, value, 'WIDTHxHEIGHT such as 1280x720');
  const match = RESOLUTION.exec(value.trim());
  if (!match) wrong(path, value, 'WIDTHxHEIGHT such as 1280x720');
  const width = BigInt(match[1]);
  const height = BigInt(match[2]);
  if (width % 2n || height % 2n) {
    throw new Failure('invalid_input', `Invalid config value for ${path}: ${valueRepr(value)}; width and height must be even`);
  }
  if (width < 320n || width > 16384n || height < 240n || height > 16384n) {
    throw new Failure('invalid_input', `Invalid config value for ${path}: ${valueRepr(value)}; allowed width 320..16384, height 240..16384`);
  }
  return `${width}x${height}`;
}

function bitrate(value: unknown, path: string): number {
  let amount: bigint;
  if (typeof value === 'bigint') amount = value;
  else if (typeof value === 'string') {
    const match = BITRATE.exec(value.trim());
    if (!match) wrong(path, value, 'an integer in bits per second, or one with a k or M suffix such as 8M');
    amount = BigInt(match[1]) * BigInt(match[2] === 'k' ? 1000 : match[2] === 'M' ? 1000000 : 1);
  } else wrong(path, value, 'an integer in bits per second, or one with a k or M suffix');
  if (amount < 250000n || amount > 100000000n) outOfRange(path, value, 250000, 100000000);
  return Number(amount);
}

function collect(errors: Failure[], validate: () => void): void {
  try {
    validate();
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    errors.push(error);
  }
}

function report(errors: Failure[], source: string, reason = 'invalid_config'): void {
  if (!errors.length) return;
  throw new Failure(reason, errors.map((error) => `${source}: ${error.message}.`).join(' '),
    [...new Set(errors.map((error) => error.hint).filter(Boolean))].join(' ') || 'Correct the values, then retry.',
    { errors: errors.map((error) => ({ source, ...error.payload() })) });
}

function bitrates(settings: ConfigSettings, block: unknown, errors: Failure[]): void {
  if (!isMapping(block)) wrong('stream.bitrate', block, 'a mapping with min, start and max');
  checkKeys(block, BITRATE_KEYS, 'stream.bitrate', errors);
  const previousErrors = errors.length;
  for (const key of BITRATE_KEYS) {
    if (Object.hasOwn(block, key)) collect(errors, () => {
      settings.stream.bitrate[key as keyof ConfigSettings['stream']['bitrate']] = bitrate(block[key], `stream.bitrate.${key}`);
    });
  }
  if (errors.length === previousErrors) collect(errors, () => checkBitrateOrder(settings));
}

function checkBitrateOrder(settings: ConfigSettings): void {
  const { min, start, max } = settings.stream.bitrate;
  if (min > start || start > max) {
    throw new Failure('invalid_input', `Invalid config value for stream.bitrate: min ${min}, start ${start}, max ${max}; require min <= start <= max`, 'Set stream.bitrate.min, stream.bitrate.start and stream.bitrate.max in that order.');
  }
}

type Validator = (value: unknown, path: string) => unknown;
const validators = {
  'display.resolution': resolution,
  'display.compositor': compositorValue,
  'stream.fps': (value, path) => integer(value, path, 10, 240),
  'stream.encoder': (value, path) => {
    const name = textValue(value, path);
    if (!encoderName(name)) wrong(path, value, 'auto, x264, or a name of letters, digits and underscores');
    return name;
  },
  'server.port': (value, path) => integer(value, path, 1, 65535),
  'server.bind': textValue,
  'server.public': (value: unknown, path: string) => {
    const origin = textValue(value, path);
    if (!/^https:\/\/[^/?#@\\\s]+$/.test(origin)) wrong(path, value, 'an HTTPS origin without a path, query or credentials');
    return origin;
  },
  'server.allow_origin': (value: unknown, path: string) => {
    const origins = textValue(value, path);
    if (!allowedOrigins(origins)) wrong(path, value, '1 to 16 comma-separated exact HTTPS origins, or loopback HTTP origins such as http://localhost:8081, without a path, wildcard or default port');
    return origins;
  },
  'server.tls_cert': textValue,
  'server.tls_key': textValue,
  'server.ice_servers': iceServersList,
  'keyboard.layout': (value: unknown, path: string) => {
    const layout = textValue(value, path);
    if (!/^[A-Za-z0-9_,-]+$/.test(layout)) {
      wrong(path, value, 'a comma-separated layout using letters, digits, "_" or "-"');
    }
    return layout;
  },
  backend: backendValue,
} satisfies Record<string, Validator>;
const validatorFor: Record<string, Validator> = validators;
const assign: Record<string, (settings: ConfigSettings, value: unknown, path: string) => void> = {
  'display.resolution': (settings, value, path) => { settings.display.resolution = validators['display.resolution'](value, path); },
  'display.compositor': (settings, value, path) => { settings.display.compositor = validators['display.compositor'](value, path); },
  'stream.fps': (settings, value, path) => { settings.stream.fps = validators['stream.fps'](value, path); },
  'stream.encoder': (settings, value, path) => { settings.stream.encoder = validators['stream.encoder'](value, path) as string; },
  'server.port': (settings, value, path) => { settings.server.port = validators['server.port'](value, path); },
  'server.bind': (settings, value, path) => { settings.server.bind = validators['server.bind'](value, path); },
  'server.public': (settings, value, path) => { settings.server.public = validators['server.public'](value, path); },
  'server.allow_origin': (settings, value, path) => { settings.server.allow_origin = validators['server.allow_origin'](value, path); },
  'server.tls_cert': (settings, value, path) => { settings.server.tls_cert = validators['server.tls_cert'](value, path); },
  'server.tls_key': (settings, value, path) => { settings.server.tls_key = validators['server.tls_key'](value, path); },
  'server.ice_servers': (settings, value, path) => { settings.server.ice_servers = iceServersList(value, path, false); },
  'keyboard.layout': (settings, value, path) => { settings.keyboard.layout = validators['keyboard.layout'](value, path); },
};

export function loadConfig(path?: string): [ConfigSettings, string | null, Set<string>] {
  const [source, required] = locate(path);
  let loadedSource = source;
  const settings: ConfigSettings = {
    display: { resolution: '1280x720', compositor: 'auto' },
    stream: { fps: 60, bitrate: { min: 1000000, start: 8000000, max: 40000000 }, encoder: 'auto' },
    server: { port: 8080, bind: '127.0.0.1', public: null, allow_origin: null, tls_cert: null, tls_key: null, ice_servers: null },
    keyboard: { layout: 'us' },
    desktop: 'xfce',
  };
  const present = new Set<string>();
  if (source !== null) {
    if (!isFile(source)) {
      if (required) throw new Failure('invalid_config', `${source}: Config file not found.`, 'Check --config or SCREEN_RELAY_CONFIG.');
      loadedSource = null;
    } else {
      const errors: Failure[] = [];
      collect(errors, () => applyConfig(settings, readConfig(source), present, errors));
      report(errors, source);
    }
  }
  return [settings, loadedSource, present];
}

function applyConfig(settings: ConfigSettings, data: Mapping, present: Set<string>, errors: Failure[]): void {
  checkKeys(data, ROOT_KEYS, '', errors);
  for (const [section, allowed] of Object.entries(SECTIONS) as [ConfigSection, readonly string[]][]) {
    if (!Object.hasOwn(data, section)) continue;
    const block = data[section];
    if (!isMapping(block)) {
      collect(errors, () => wrong(section, block, 'a mapping'));
      continue;
    }
    checkKeys(block, allowed, section, errors);
    for (const key of allowed) {
      if (!Object.hasOwn(block, key)) continue;
      const path = `${section}.${key}`;
      collect(errors, () => {
        if (key === 'bitrate') bitrates(settings, block[key], errors);
        else assign[path](settings, block[key], path);
      });
      present.add(path);
    }
  }
  if (Object.hasOwn(data, 'desktop')) {
    collect(errors, () => { settings.desktop = textValue(data.desktop, 'desktop'); });
    present.add('desktop');
  }
  if (Object.hasOwn(data, 'backend')) collect(errors, () => { settings.backend = validators.backend(data.backend, 'backend'); });
}

export function applyTo(args: Record<string, unknown>, settings: ConfigSettings, present: Set<string>): void {
  const fields: [string, string, string, unknown][] = [
    ['port', 'SCREEN_RELAY_PORT', 'server.port', settings.server.port],
    ['bind', 'SCREEN_RELAY_BIND', 'server.bind', present.has('server.bind') ? settings.server.bind : undefined],
    ['public', 'SCREEN_RELAY_PUBLIC', 'server.public', settings.server.public],
    ['allow-origin', 'SCREEN_RELAY_ALLOW_ORIGIN', 'server.allow_origin', settings.server.allow_origin],
    ['tls-cert', 'SCREEN_RELAY_TLS_CERT', 'server.tls_cert', settings.server.tls_cert],
    ['tls-key', 'SCREEN_RELAY_TLS_KEY', 'server.tls_key', settings.server.tls_key],
    ['desktop', 'SCREEN_RELAY_DESKTOP', 'desktop', present.has('desktop') ? settings.desktop : undefined],
    ['backend', 'SCREEN_RELAY_BACKEND', 'backend', settings.backend],
    ['resolution', 'SCREEN_RELAY_RESOLUTION', 'display.resolution', settings.display.resolution],
    ['compositor', 'SCREEN_RELAY_COMPOSITOR', 'display.compositor', settings.display.compositor],
    ['fps', 'SCREEN_RELAY_FPS', 'stream.fps', settings.stream.fps],
    ['encoder', 'SCREEN_RELAY_ENCODER', 'stream.encoder', settings.stream.encoder],
    ['ice-server', 'SCREEN_RELAY_ICE_SERVERS', 'server.ice_servers', present.has('server.ice_servers') ? settings.server.ice_servers : undefined],
    ['bitrateMin', 'SCREEN_RELAY_BITRATE_MIN', 'stream.bitrate.min', settings.stream.bitrate.min],
    ['bitrateStart', 'SCREEN_RELAY_BITRATE_START', 'stream.bitrate.start', settings.stream.bitrate.start],
    ['bitrateMax', 'SCREEN_RELAY_BITRATE_MAX', 'stream.bitrate.max', settings.stream.bitrate.max],
    ['keyboardLayout', 'SCREEN_RELAY_KEYBOARD_LAYOUT', 'keyboard.layout', settings.keyboard.layout],
  ];
  const resolved: Mapping = {};
  const errors: Failure[] = [];
  for (const [key, environment, path, fallback] of fields) {
    const explicit = args[key] !== undefined;
    const rawEnv = process.env[environment];
    const fromEnvironment = !explicit && rawEnv !== undefined && !(key === 'ice-server' && !rawEnv.trim());
    const value = explicit ? args[key] : fromEnvironment ? rawEnv : fallback;
    if (!explicit && !fromEnvironment) {
      resolved[key] = value;
      continue;
    }
    collect(errors, () => {
      const label = fromEnvironment ? environment : `--${key}`;
      let input = value;
      if (path === 'server.port' || path === 'stream.fps') {
        if (typeof input === 'number' && Number.isSafeInteger(input)) input = BigInt(input);
        else if (typeof input === 'string' && /^[0-9]+$/.test(input)) input = BigInt(input);
      } else if (path.startsWith('stream.bitrate.') && typeof input === 'number' && Number.isSafeInteger(input)) input = BigInt(input);
      const validate = path.startsWith('stream.bitrate.') ? bitrate : path === 'desktop' ? textValue : validatorFor[path];
      resolved[key] = validate(input, label);
    });
  }
  if (!errors.some((error) => /bitrate|BITRATE/.test(error.message))) collect(errors, () => {
    checkBitrateOrder({ ...settings, stream: { ...settings.stream, bitrate: {
      min: resolved.bitrateMin as number, start: resolved.bitrateStart as number, max: resolved.bitrateMax as number,
    } } });
  });
  if (Boolean(resolved['tls-cert']) !== Boolean(resolved['tls-key'])) {
    errors.push(new Failure('invalid_input', 'server.tls_cert and server.tls_key must be set together', 'Set both or neither.'));
  }
  report(errors, 'Settings', 'invalid_input');
  Object.assign(args, resolved);
}
