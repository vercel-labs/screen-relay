import { commands, globalOptions, type Command, type Parameter, type RunsOn, type Subcommand } from './commands.js';
import { VERSION } from './host/common.js';
import { agent, type OutputOptions } from './mode.js';
import { theme } from './theme.js';

const docs = 'https://screen-relay.dev/docs/cli';
const summary = 'Start a streamed desktop and control it';
const width = 80;
const labelLimit = 24;

export const version = VERSION;

type Style = ReturnType<typeof theme>;
type Example = { description: string; command: string };

function argumentSyntax(parameter: Parameter): string {
  const value = parameter.valueHint ?? `<${parameter.name.toUpperCase()}>`;
  const repeated = parameter.repeat === 'collect' ? `${value}...` : value;
  return parameter.brackets ?? !parameter.required ? `[${repeated}]` : repeated;
}

function optionSyntax(parameter: Parameter): string {
  const value = `${parameter.valueHint ? ` ${parameter.valueHint}` : ''}${parameter.repeat === 'collect' ? '...' : ''}`;
  return `${parameter.short ? `-${parameter.short}, ` : ''}--${parameter.name}${value}`;
}

function description(parameter: Parameter): string {
  const showDefault = parameter.default !== undefined && parameter.default !== false;
  return `${parameter.summary}${showDefault ? ` (default: ${parameter.default})` : ''}${parameter.acceptedValues ? `. Values: ${parameter.acceptedValues.join(', ')}` : ''}${parameter.environment ? `. Environment: ${parameter.environment}` : ''}`;
}

function details(parameter: Parameter): string {
  return `${parameter.summary}${parameter.acceptedValues ? `. Values: ${parameter.acceptedValues.join(', ')}` : ''}${parameter.environment ? `. Environment: ${parameter.environment}` : ''}`;
}

function defaultNote(parameter: Parameter, style: Style): string {
  const showDefault = parameter.default !== undefined && parameter.default !== false;
  return showDefault ? style.dim(` [default: ${style.italic(String(parameter.default))}]`) : '';
}

function wrapWords(text: string, limit: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > limit) { lines.push(line); line = word; }
    else line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function align(entries: { label: string; text: string }[]): string[] {
  const column = 2 + Math.min(Math.max(0, ...entries.map((entry) => entry.label.length)), labelLimit) + 2;
  const lines: string[] = [];
  for (const { label, text } of entries) {
    if (2 + label.length + 2 <= column) {
      const words = wrapWords(text, width - column);
      lines.push(`  ${label.padEnd(column - 4)}  ${words[0]}`);
      for (const word of words.slice(1)) lines.push(`${' '.repeat(column)}${word}`);
    } else {
      lines.push(`  ${label}`);
      for (const word of wrapWords(text, width - 4)) lines.push(`    ${word}`);
    }
  }
  return lines;
}

function parameterRows(parameters: Parameter[], option: boolean): string[] {
  return align([...parameters]
    .sort((left, right) => option ? left.name.localeCompare(right.name) : 0)
    .map((parameter) => ({ label: option ? optionSyntax(parameter) : argumentSyntax(parameter), text: description(parameter) })));
}

function subcommandRows(subcommands: Subcommand[]): string[] {
  return align(subcommands.map((subcommand) => ({ label: subcommand.name, text: subcommand.summary })));
}

function cellWidths(entries: { label: string; args: string }[]): { labelWidth: number; argsWidth: number } {
  return {
    labelWidth: Math.max(0, ...entries.map((entry) => entry.label.length)) + 2,
    argsWidth: Math.max(0, ...entries.map((entry) => entry.args.length)) + 2,
  };
}

function cellRows(entries: { label: string; args: string; text: string }[], style: Style, widths = cellWidths(entries)): string[] {
  return entries.map((entry) => `    ${entry.label.padEnd(widths.labelWidth)}${style.dim(entry.args.padEnd(widths.argsWidth))}${style.dim(entry.text)}`);
}

function optionRows(parameters: Parameter[], style: Style): string[] {
  const sorted = [...parameters].sort((left, right) => left.name.localeCompare(right.name));
  const column = Math.max(0, ...sorted.map((parameter) => optionSyntax(parameter).length)) + 2;
  return sorted.map((parameter) => `    ${optionSyntax(parameter).padEnd(column)}${style.dim(details(parameter))}${defaultNote(parameter, style)}`);
}

function exampleLines(examples: Example[], style: Style): string[] {
  return examples.flatMap((example, index) => [
    ...(index ? [''] : []),
    `${style.muted('–')} ${example.description}`,
    '',
    style.accent(`  $ ${example.command}`),
  ]);
}

function commandArguments(command: Command): string {
  if (command.subcommands?.length) return '<subcommand>';
  const tail = command.arguments.map(argumentSyntax).join(' ');
  return tail ? `${command.separator ? `${command.separator} ` : ''}${tail}` : '';
}

export function helpDocument(name = ''): Record<string, unknown> {
  const command = commands[name];
  const publicParameter = ({ validate, deferredDefault, missingReason, brackets, ...parameter }: Parameter) => ({ repeat: 'last', ...parameter });
  return {
    path: name ? `screen-relay ${name}` : 'screen-relay',
    summary: command?.summary ?? summary,
    arguments: command?.arguments.map(publicParameter) ?? [],
    options: [...(command?.options ?? []), ...globalOptions].map(publicParameter),
    examples: command?.examples ?? [],
    notes: command?.notes ?? [],
    resultSchema: command?.resultSchema ?? {},
    ...(command ? { runsOn: command.runsOn } : {}),
    ...(command?.subcommands ? { subcommands: command.subcommands.map(({ name, summary, examples, resultSchema }) => ({ name, summary, examples, ...(resultSchema ? { resultSchema } : {}) })) } : {}),
    ...(!name ? { commands: Object.entries(commands).map(([key, entry]) => ({ name: key, summary: entry.summary, group: entry.group, runsOn: entry.runsOn })) } : {}),
  };
}

function agentUsage(name: string, style: Style): string {
  const command = commands[name];
  const head = `▲ ${style.strong('screen-relay')}`;
  if (!command) return `${head} <command> [options]`;
  const tail = command.usageTail ?? command.arguments.map(argumentSyntax).join(' ');
  return `${head} ${name}${command.separator ? ` ${command.separator}` : ''}${tail ? ` ${tail}` : ''} [options]`;
}

function humanUsage(name: string, style: Style): string {
  const command = commands[name];
  const head = `▲ ${style.strong(name ? `screen-relay ${name}` : 'screen-relay')}`;
  if (!command) return `${head} [options] <command>`;
  const tail = command.usageTail ?? command.arguments.map(argumentSyntax).join(' ');
  return `${head}${command.separator ? ` ${command.separator}` : ''}${tail ? ` ${tail}` : ''} [options]`;
}

const sections: { runsOn: RunsOn; label: string }[] = [
  { runsOn: 'vm', label: 'Host commands (run on the Linux, macOS, or Windows machine that shows the desktop):' },
  { runsOn: 'client', label: 'Client commands (run on the host, or anywhere with --url and a token):' },
  { runsOn: 'anywhere', label: 'Other commands:' },
];

const location: Record<RunsOn, string> = {
  vm: 'Run it on the Linux, macOS, or Windows machine that shows the desktop.',
  client: 'Runs on the host, or on another machine with --url and a token file.',
  anywhere: 'Runs on any machine. It does not reach an engine.',
};

const startHere = [
  'Start here (for AI agents):',
  '  screen-relay skills get core',
  '',
  '  Skills ship with the CLI, so their instructions always match the',
  '  installed version. Load one to control the desktop or a sandbox.',
  '',
  '  Host commands must run on the machine with the desktop and client',
  '  commands can run there or on another machine with --url and a',
  '  token file.',
  '',
  '  screen-relay skills list',
  '  screen-relay skills get core',
  '  screen-relay skills get core --full',
  '  screen-relay skills get <name>',
  '  screen-relay skills path [name]',
];

const rootExamples: Example[] = [
  { description: 'Start a session in the background', command: 'screen-relay up --detach' },
  { description: 'Take a screenshot', command: 'screen-relay screenshot screen.png' },
  { description: 'Click the center of the screen', command: 'screen-relay click 0.5 0.5' },
  { description: 'Load the core agent skill', command: 'screen-relay skills get core' },
];

function agentHelp(name: string, args: OutputOptions): string {
  const style = theme({ ...args, color: false }, process.stdout);
  const command = commands[name];
  const lines = [style.muted(`screen-relay ${version}`), '', agentUsage(name, style), ''];
  if (command) lines.push(command.summary, location[command.runsOn]);
  else lines.push(summary, '', ...startHere);
  if (command?.arguments.length) lines.push('', 'Arguments:', ...parameterRows(command.arguments, false));
  if (command?.options.length) lines.push('', 'Options:', ...parameterRows(command.options, true));
  if (!command) for (const section of sections) {
    lines.push('', section.label, ...align(Object.entries(commands)
      .filter(([, entry]) => entry.runsOn === section.runsOn)
      .map(([key, entry]) => ({ label: key, text: entry.summary }))));
  }
  if (command?.subcommands?.length) lines.push('', 'Commands:', ...subcommandRows(command.subcommands));
  lines.push('', 'Global Options:', ...(command ? ['  Run screen-relay help for the full list of global options.'] : parameterRows(globalOptions, true)));
  if (command?.examples.length) lines.push('', 'Examples:', ...command.examples.flatMap((entry) => [...wrapWords(entry.description, width - 2).map((line) => `  ${line}`), `    ${entry.command}`]));
  if (command?.notes.length) lines.push('', 'Notes:', ...command.notes.flatMap((note) => wrapWords(note, width - 2).map((line) => `  ${line}`)));
  lines.push('', 'Learn more:', `  ${docs}`);
  return `${lines.join('\n')}\n`;
}

function humanHelp(name: string, args: OutputOptions): string {
  const style = theme(args, process.stdout);
  const command = commands[name];
  const lines = [style.muted(command ? name : `screen-relay ${version}`), '', humanUsage(name, style), ''];
  if (!command) {
    lines.push(style.dim('For command help, run `screen-relay <command> --help`'));
    const groups = sections.map((section) => ({
      section,
      entries: Object.entries(commands)
        .filter(([, entry]) => entry.runsOn === section.runsOn)
        .map(([key, entry]) => ({ label: key, args: commandArguments(entry), text: entry.summary })),
    }));
    const widths = cellWidths(groups.flatMap((group) => group.entries));
    for (const { section, entries } of groups) {
      lines.push('', style.dim(section.label), '');
      lines.push(...cellRows(entries, style, widths));
    }
    lines.push('', style.dim('Examples:'), '', ...exampleLines(rootExamples, style));
  } else {
    lines.push(style.dim(command.summary), style.dim(location[command.runsOn]));
    if (command.options.length) lines.push('', style.dim('Options:'), '', ...optionRows(command.options, style));
    if (command.notes.length) lines.push('', style.dim('Notes:'), '', ...command.notes.flatMap((note) => wrapWords(note, width - 4).map((line) => style.dim(`    ${line}`))));
    if (command.subcommands?.length) {
      lines.push('', style.dim('Commands:'), '');
      lines.push(...cellRows(command.subcommands.map((subcommand) => ({ label: subcommand.name, args: '', text: subcommand.summary })), style));
    }
    if (command.examples.length) lines.push('', style.dim('Examples:'), '', ...exampleLines(command.examples, style));
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** Formats root or command help in the human layout, or the descriptive agent layout when an agent is detected. */
export function formatHelp(name = '', args: OutputOptions = {}): string {
  return agent ? agentHelp(name, args) : humanHelp(name, args);
}
