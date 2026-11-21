import { cmdClick, cmdClipboard, cmdInput, cmdKey, cmdMove, cmdScreenshot, cmdScroll, cmdType } from './client.js';
import { BACKENDS, allowedOrigins, encoderName, iceServerHasCredentials, iceServerSpec } from './config.js';
import { cmdDoctor } from './host/doctor.js';
import { cmdDown, cmdLogs, cmdRun, cmdStatus, cmdUp, COMPONENTS } from './host/session_commands.js';
import { cmdInstall } from './host/setup.js';
import { Failure } from './output.js';
import { cmdSkills, unknownAction } from './skills.js';

export type Args = Record<string, unknown> & { command: string; json: boolean; name: string; signal?: AbortSignal };
export type Parameter = {
  name: string;
  summary: string;
  type: 'string' | 'boolean' | 'number';
  short?: string;
  valueHint?: string;
  default?: string | number | boolean;
  acceptedValues?: readonly string[];
  repeat?: 'last' | 'collect';
  required?: boolean;
  brackets?: boolean;
  missingReason?: string;
  environment?: string;
  deferredDefault?: boolean;
  sensitive?: boolean;
  validate?: (value: unknown, fromEnvironment?: boolean) => boolean | Failure;
};
export type Subcommand = { name: string; summary: string; examples: { description: string; command: string }[]; resultSchema?: Record<string, unknown> };
export type RunsOn = 'vm' | 'client' | 'anywhere';
export type Command = {
  summary: string;
  group: 'Session' | 'Control' | 'Machine';
  runsOn: RunsOn;
  arguments: Parameter[];
  options: Parameter[];
  examples: { description: string; command: string }[];
  notes: string[];
  resultSchema?: Record<string, unknown>;
  separator?: string;
  usageTail?: string;
  subcommands?: Subcommand[];
  validate?: (args: Args) => string | Failure | undefined;
  run?: (args: Args) => number | Promise<number>;
};

export const globalOptions: Parameter[] = [
  { name: 'help', short: 'h', type: 'boolean', summary: 'Show help' },
  { name: 'version', short: 'v', type: 'boolean', summary: 'Print the version' },
  { name: 'json', type: 'boolean', summary: 'Print JSON' },
  { name: 'no-color', type: 'boolean', summary: 'Disable color', default: false },
  { name: 'name', type: 'string', valueHint: '<NAME>', summary: 'Select the session', default: 'default', validate: (value) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/.test(String(value)) },
];
const timeout: Parameter = { name: 'timeout', type: 'number', valueHint: '<DURATION>', summary: 'Wait this many seconds', default: 10, validate: (value) => Number(value) > 0 };
const yes: Parameter = { name: 'yes', short: 'y', type: 'boolean', summary: 'Install system packages without asking' };
const configOption: Parameter = { name: 'config', type: 'string', valueHint: '<FILE>', summary: 'Load the YAML config', environment: 'SCREEN_RELAY_CONFIG' };
const client: Parameter[] = [
  { name: 'url', type: 'string', valueHint: '<URL>', summary: 'Use this engine origin', environment: 'SCREEN_RELAY_URL' },
  { name: 'token-file', type: 'string', valueHint: '<FILE>', summary: 'Read the token from this file', environment: 'SCREEN_RELAY_TOKEN_FILE' },
  timeout,
];
const coordinates: Parameter[] = ['x', 'y'].map((name) => ({ name, summary: 'Fraction of the screen from 0 to 1', type: 'number', valueHint: `<${name}>`, required: true, validate: (value) => Number(value) >= 0 && Number(value) <= 1 }));
const inputResult = { input: { events: 'number' }, outcome: 'sent' };
const stdin: Parameter = { name: 'stdin', type: 'boolean', summary: 'Read the argument from stdin' };
const textSource = (key: string) => (args: Args): string | undefined => Boolean(args.stdin) === (args[key] !== undefined) ? 'Give the argument or --stdin, not both or neither' : undefined;
const example = (description: string, command: string) => [{ description, command }];
const coordinateNotes = ['Coordinates are fractions of the screen from 0 to 1.'];

export const commands: Record<string, Command> = {
  up: {
    summary: 'Start or attach to a display and start the engine', group: 'Session', runsOn: 'vm', arguments: [],
    options: [
      { name: 'detach', short: 'd', type: 'boolean', summary: 'Run in the background', default: false },
      configOption,
      { name: 'port', type: 'number', valueHint: '<PORT>', summary: 'Listen on this port', environment: 'SCREEN_RELAY_PORT', default: 8080, deferredDefault: true, validate: (value) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535 },
      { name: 'desktop', type: 'string', valueHint: '<COMMAND>', summary: 'Start xfce, none, or a desktop command; defaults to xfce on x11, foot on wayland, or none when attaching. On macOS and Windows, the desktop is always none', environment: 'SCREEN_RELAY_DESKTOP' },
      { name: 'display', type: 'string', valueHint: '<DISPLAY>', summary: 'Attach to an existing X display (:0) or Wayland socket (wayland-1) on Linux' },
      { name: 'backend', type: 'string', valueHint: '<BACKEND>', summary: 'On Linux, defaults to x11 when the engine has it, else wayland; a --display without a colon selects wayland. On macOS, defaults to macos; on Windows, defaults to windows', environment: 'SCREEN_RELAY_BACKEND', acceptedValues: BACKENDS },
      { name: 'output', type: 'string', valueHint: '<NAME>', summary: 'Capture a Wayland output by name, a macOS display by CGDirectDisplayID, or a Windows display by device name' },
      { name: 'encoder', type: 'string', valueHint: '<ENCODER>', summary: 'Encode with auto, x264, or a hardware encoder name', environment: 'SCREEN_RELAY_ENCODER', default: 'auto', deferredDefault: true, validate: (value) => encoderName(String(value)) },
      { name: 'public', type: 'string', valueHint: '<URL>', summary: 'Advertise this HTTPS origin without changing the listen address', environment: 'SCREEN_RELAY_PUBLIC', validate: (value) => /^https:\/\/[^/?#@\\\s]+$/.test(String(value)) },
      { name: 'allow-origin', type: 'string', valueHint: '<ORIGINS>', summary: 'Also accept browser requests from these comma-separated exact origins: HTTPS for any host, or HTTP for localhost and 127.0.0.1', environment: 'SCREEN_RELAY_ALLOW_ORIGIN', validate: allowedOrigins },
      { name: 'ice-server', type: 'string', valueHint: '<URL>', repeat: 'collect', sensitive: true, summary: 'Add a credential-free STUN or TURN server URL for WebRTC viewers; repeat up to 8 times (set credential-bearing TURN URLs in config.yaml or SCREEN_RELAY_ICE_SERVERS)', environment: 'SCREEN_RELAY_ICE_SERVERS', validate: (value, fromEnvironment) => {
        const spec = String(value);
        if (!iceServerSpec(spec)) return false;
        if (!fromEnvironment && iceServerHasCredentials(spec)) {
          return new Failure('invalid_input', 'ICE server credentials cannot be passed in --ice-server', 'Set credential-bearing TURN URLs in server.ice_servers in config.yaml or SCREEN_RELAY_ICE_SERVERS instead.');
        }
        return true;
      } },
      { name: 'tls-cert', type: 'string', valueHint: '<FILE>', summary: 'Serve TLS with this certificate', environment: 'SCREEN_RELAY_TLS_CERT' },
      { name: 'tls-key', type: 'string', valueHint: '<FILE>', summary: 'Read the TLS private key', environment: 'SCREEN_RELAY_TLS_KEY' },
      { name: 'bind', type: 'string', valueHint: '<ADDRESS>', summary: 'Listen on this address', environment: 'SCREEN_RELAY_BIND', default: '127.0.0.1', deferredDefault: true },
      { ...timeout, default: 30 },
      yes,
    ],
    examples: [
      { description: 'Start a session in the background', command: 'screen-relay up -d' },
      { description: 'Start a Wayland session on Linux', command: 'screen-relay up -d --backend wayland' },
      { description: 'Attach to the running Wayland compositor', command: 'screen-relay up -d --display "$WAYLAND_DISPLAY"' },
      { description: 'Attach to the current display on macOS', command: 'screen-relay up -d --backend macos' },
      { description: 'Encode with x264 instead of choosing automatically', command: 'screen-relay up -d --encoder x264' },
    ],
    notes: ['Without --detach, Ctrl+C stops the session.', 'On Linux, --display uses the existing display size and defaults to no desktop. On macOS and Windows, screen-relay always attaches to the existing display.', 'Flags override config values. SCREEN_RELAY_CONFIG selects the config file.', 'Config-only settings and their variables: display.resolution (SCREEN_RELAY_RESOLUTION), stream.fps (SCREEN_RELAY_FPS), stream.bitrate.* (SCREEN_RELAY_BITRATE_MIN, SCREEN_RELAY_BITRATE_START, SCREEN_RELAY_BITRATE_MAX), keyboard.layout (SCREEN_RELAY_KEYBOARD_LAYOUT).', 'On a machine that is not set up yet, up installs the system packages and builds the engine first. At a terminal it asks before installing; anywhere else it needs --yes.'],
    resultSchema: { session: 'object', outcome: 'started' },
    validate: (args) => {
      if (args.display === '') return new Failure('invalid_input', '--display is empty', 'Set WAYLAND_DISPLAY or DISPLAY, or drop --display to start a new desktop.');
      const servers = Array.isArray(args['ice-server']) ? args['ice-server'] : [];
      if (servers.length > 8) return new Failure('invalid_input', `At most 8 ICE server entries; got ${servers.length}`, 'Pass up to 8 STUN or TURN server URLs.');
      if (servers.length && Buffer.byteLength(`${servers.join('\n')}\n`, 'utf8') > 16384) {
        return new Failure('invalid_input', 'ICE server entries exceed the 16 KiB limit', 'Shorten the STUN or TURN server list to fit within 16 KiB.');
      }
      return undefined;
    },
    run: cmdUp,
  },
  down: { summary: 'Stop a session', group: 'Session', runsOn: 'vm', arguments: [], options: [], examples: example('Stop the default session', 'screen-relay down'), notes: ['Safe to repeat.'], resultSchema: { session: 'object', outcome: ['stopped', 'unchanged'] }, run: cmdDown },
  status: { summary: 'Show the session or remote engine state', group: 'Session', runsOn: 'client', arguments: [], options: [...client, { name: 'show-token', type: 'boolean', summary: 'Include the session token' }], examples: example('Inspect the default session', 'screen-relay status'), notes: [], resultSchema: { session: 'object' }, run: cmdStatus },
  logs: { summary: 'Print component logs', group: 'Session', runsOn: 'vm', arguments: [{ name: 'component', type: 'string', valueHint: 'component', summary: 'Select a component log', acceptedValues: COMPONENTS }], options: [{ name: 'follow', short: 'f', type: 'boolean', summary: 'Keep printing new lines' }], examples: example('Follow engine logs', 'screen-relay logs engine --follow'), notes: ['Prints the last 200 lines. --follow cannot be combined with --json.', 'Keys inside logs are the names of the available component logs.'], resultSchema: { logs: { '[component]': 'string' } }, validate: (args) => args.follow && args.json ? '--follow cannot be combined with --json' : undefined, run: cmdLogs },
  run: {
    summary: 'Start an app on the session desktop', group: 'Session', runsOn: 'vm', separator: '--',
    arguments: [
      { name: 'app', type: 'string', valueHint: '<app>', summary: 'App to start', required: true, missingReason: 'missing_command' },
      { name: 'args', type: 'string', valueHint: '[args]', brackets: false, repeat: 'collect', summary: 'Arguments passed to the app' },
    ],
    options: [{ name: 'restart', type: 'boolean', summary: 'Restart the app after it exits' }],
    examples: example('Start an editor', 'screen-relay run -- mousepad notes.txt'),
    notes: ['Returns the app pid. Read app output with screen-relay logs apps.', 'Use -- before the app to pass its flags unchanged.'],
    resultSchema: { app: { pid: 'number', command: 'string[]' }, outcome: 'started' },
    run: cmdRun,
  },
  install: {
    summary: 'Install system packages and build the engine', group: 'Machine', runsOn: 'vm', arguments: [],
    options: [
      { name: 'backend', type: 'string', valueHint: '<BACKEND>', summary: 'Set up x11, wayland, or all on Linux; defaults to x11. On macOS, the backend is always macos; on Windows, it is always windows', environment: 'SCREEN_RELAY_BACKEND', acceptedValues: [...BACKENDS, 'all'] },
      { name: 'desktop', type: 'string', valueHint: '<COMMAND>', summary: 'Install the XFCE packages only for xfce, the x11 default; none or another command skips them', environment: 'SCREEN_RELAY_DESKTOP' },
      configOption,
      yes,
    ],
    examples: [
      { description: 'Set up this machine without prompts', command: 'screen-relay install --yes' },
      { description: 'Set up the Wayland backend on Linux', command: 'screen-relay install --backend wayland --yes' },
    ],
    notes: ['Installs packages with the system package manager, using sudo unless you are root, then builds the engine under ~/.local/share/screen-relay.', 'Safe to repeat. Adding a backend keeps the ones the engine already has.', 'At a terminal it asks before installing packages; anywhere else it needs --yes.'],
    resultSchema: { install: { backends: 'array', engine: 'string' }, outcome: ['installed', 'unchanged'] },
    run: cmdInstall,
  },
  doctor: { summary: 'Check this machine and show fixes', group: 'Machine', runsOn: 'vm', arguments: [], options: [configOption], examples: example('Check host dependencies', 'screen-relay doctor'), notes: ['On Linux, checks the x11 backend unless SCREEN_RELAY_BACKEND or the config backend key says otherwise; run SCREEN_RELAY_BACKEND=wayland screen-relay doctor for Wayland. On macOS, checks the macos backend. On Windows, checks the windows backend, MSYS2 and the desktop session.'], resultSchema: { checks: 'array', summary: 'object' }, run: cmdDoctor },
  screenshot: { summary: 'Save a PNG of the screen', group: 'Control', runsOn: 'client', arguments: [{ name: 'file', type: 'string', valueHint: 'file', summary: 'Destination path, or - for PNG stdout', default: 'screen.png' }], options: client, examples: example('Save the current screen', 'screen-relay screenshot screen.png'), notes: ['Use - to write PNG bytes to stdout. This cannot be combined with --json.'], resultSchema: { screenshot: { path: 'string', width: 'number', height: 'number', bytes: 'number' }, outcome: 'saved' }, validate: (args) => args.file === '-' && args.json ? 'PNG stdout cannot be combined with --json' : undefined, run: cmdScreenshot },
  click: { summary: 'Click at screen coordinates', group: 'Control', runsOn: 'client', arguments: coordinates, options: [...client, { name: 'button', type: 'string', valueHint: '<BUTTON>', summary: 'Select the mouse button', default: 'left', acceptedValues: ['left', 'middle', 'right'] }], examples: example('Click the center', 'screen-relay click 0.5 0.5'), notes: coordinateNotes, resultSchema: inputResult, run: cmdClick },
  move: { summary: 'Move the pointer to screen coordinates', group: 'Control', runsOn: 'client', arguments: coordinates, options: client, examples: example('Move to the center', 'screen-relay move 0.5 0.5'), notes: coordinateNotes, resultSchema: inputResult, run: cmdMove },
  scroll: { summary: 'Scroll at screen coordinates', group: 'Control', runsOn: 'client', arguments: coordinates, options: [...client, ...['dx', 'dy'].map((name): Parameter => ({ name, type: 'number', valueHint: '<NUMBER>', summary: `${name === 'dx' ? 'Horizontal' : 'Vertical'} wheel notches`, default: 0, validate: (value) => Number.isInteger(value) }))], examples: example('Scroll down at the center', 'screen-relay scroll 0.5 0.5 --dy 3'), notes: [...coordinateNotes, 'Positive dy scrolls down; positive dx scrolls right.'], resultSchema: inputResult, validate: (args) => !args.dx && !args.dy ? 'Give a nonzero --dx or --dy' : undefined, run: cmdScroll },
  key: { summary: 'Press key combinations', group: 'Control', runsOn: 'client', arguments: [{ name: 'combos', type: 'string', valueHint: '<combo>', summary: 'Key combinations to press in order', required: true, repeat: 'collect' }], options: client, examples: example('Focus the address bar', 'screen-relay key ctrl+l'), notes: ['Keys are physical. cmd and meta are aliases of super.'], resultSchema: inputResult, run: cmdKey },
  type: { summary: 'Type text using the remote keyboard layout', group: 'Control', runsOn: 'client', arguments: [{ name: 'text', type: 'string', valueHint: '<text>', brackets: false, summary: 'Text to type' }], options: [...client, stdin], examples: example('Type a greeting', 'screen-relay type "Hello"'), notes: [], resultSchema: inputResult, validate: textSource('text'), run: cmdType },
  input: { summary: 'Send a JSON array of input events', group: 'Control', runsOn: 'client', arguments: [{ name: 'events', type: 'string', valueHint: '<json>', brackets: false, summary: 'SDK input events' }], options: [...client, stdin], examples: example('Send raw key events', 'screen-relay input \'[{"type":"keyDown","key":4},{"type":"keyUp","key":4}]\''), notes: ['Accepts 1 to 256 events.'], resultSchema: inputResult, validate: textSource('events'), run: cmdInput },
  clipboard: {
    summary: 'Read or set the remote clipboard text', group: 'Control', runsOn: 'client', usageTail: '<command> [text]',
    arguments: [
      { name: 'action', type: 'string', valueHint: '<command>', summary: 'Get or set', required: true, acceptedValues: ['get', 'set'] },
      { name: 'text', type: 'string', valueHint: '<text>', brackets: false, summary: 'Text to put on the clipboard' },
    ],
    options: [...client, stdin],
    subcommands: [
      { name: 'get', summary: 'Print the clipboard text', examples: example('Read what the desktop copied', 'screen-relay clipboard get'), resultSchema: { clipboard: { text: 'string', bytes: 'number' } } },
      { name: 'set', summary: 'Replace the clipboard text', examples: example('Put a URL on the clipboard', 'screen-relay clipboard set "https://example.com"'), resultSchema: { clipboard: { bytes: 'number' }, outcome: 'set' } },
    ],
    examples: [
      { description: 'Read what the desktop copied', command: 'screen-relay clipboard get' },
      { description: 'Put a URL on the clipboard', command: 'screen-relay clipboard set "https://example.com"' },
      { description: 'Put piped text on the clipboard', command: 'screen-relay clipboard set --stdin' },
    ],
    notes: ['get prints the text exactly, with no newline added. Use --json for the text and byte count.', 'Text is UTF-8, up to 256 KiB. set "" clears the clipboard.', 'To paste the text, press the paste keys afterwards, such as screen-relay key ctrl+v.'],
    validate: (args) => args.action === 'get' && (args.text !== undefined || args.stdin) ? 'screen-relay clipboard get takes no text'
      : args.action === 'set' ? textSource('text')(args) : undefined,
    run: cmdClipboard,
  },
  skills: {
    summary: 'Read the agent skills shipped with this CLI', group: 'Machine', runsOn: 'anywhere', usageTail: '<command> [name]',
    arguments: [
      { name: 'action', type: 'string', valueHint: '<command>', summary: 'List, get or path', default: 'list', acceptedValues: ['list', 'get', 'path'] },
      { name: 'skill', type: 'string', valueHint: '<name>', summary: 'Skill name' },
    ],
    options: [{ name: 'full', type: 'boolean', summary: 'Append the skill references' }],
    subcommands: [
      { name: 'list', summary: 'List the skills shipped with this CLI', examples: example('List the skills', 'screen-relay skills list') },
      { name: 'get', summary: 'Print one skill workflow', examples: example('Read the core workflow', 'screen-relay skills get core') },
      { name: 'path', summary: 'Print the skills directory', examples: example('Print the skill directory', 'screen-relay skills path') },
    ],
    examples: [
      { description: 'List the skills', command: 'screen-relay skills list' },
      { description: 'Read the core workflow', command: 'screen-relay skills get core' },
      { description: 'Print the skill directory', command: 'screen-relay skills path' },
    ],
    notes: ['Skills ship with the CLI, so their instructions match the installed version.', 'get --full appends the references and templates.'],
    resultSchema: { skills: 'array', skill: { name: 'string', content: 'string' }, path: 'string' },
    validate: (args) => args.action !== undefined && !['list', 'get', 'path'].includes(String(args.action)) ? unknownAction(String(args.action))
      : args.action === 'get' && args.skill === undefined ? 'Name the skill to get'
      : args.action === 'list' && args.skill !== undefined ? 'screen-relay skills list takes no skill name'
      : args.full && args.action !== 'get' ? '--full only applies to screen-relay skills get' : undefined,
    run: cmdSkills,
  },
  help: { summary: 'Show command help', group: 'Machine', runsOn: 'anywhere', arguments: [{ name: 'topic', type: 'string', valueHint: 'command', summary: 'Command to describe' }], options: [{ name: 'all', type: 'boolean', summary: 'Describe every command' }], examples: example('Read click help', 'screen-relay help click'), notes: [], resultSchema: { path: 'string', summary: 'string', arguments: 'array', options: 'array', examples: 'array', resultSchema: 'object' } },
};
