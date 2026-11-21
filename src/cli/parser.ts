import { commands, globalOptions, type Args, type Parameter } from './commands.js';
import { Failure } from './output.js';

export function usageFailure(message: string, command = '', reason = 'invalid_input'): Failure {
  return new Failure(reason, message, `Run \`screen-relay help${command ? ` ${command}` : ''}\`.`);
}

function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [index, character] of [...left].entries()) {
    const current = [index + 1];
    for (let offset = 0; offset < right.length; offset++) current.push(Math.min(current[offset] + 1, previous[offset + 1] + 1, previous[offset] + Number(character !== right[offset])));
    previous = current;
  }
  return previous[right.length];
}

export function unknownToken(kind: string, token: string, choices: string[], command = ''): Failure {
  const closest = choices.map((choice) => ({ choice, distance: distance(token, choice) })).sort((left, right) => left.distance - right.distance)[0];
  return usageFailure(`Unknown ${kind} '${token}'.${closest && closest.distance <= 2 ? ` Did you mean '${closest.choice}'?` : ''}`, command, kind === 'command' ? 'unknown_command' : 'invalid_option');
}

function valueFor(parameter: Parameter, raw: unknown, command: string, fromEnvironment = false): unknown {
  const value = parameter.type === 'number' ? Number(raw) : raw;
  const check = parameter.validate ? parameter.validate(value, fromEnvironment) : true;
  if (check instanceof Failure) throw check;
  if ((parameter.type === 'number' && (String(raw).trim() === '' || !Number.isFinite(value))) || (parameter.acceptedValues && !parameter.acceptedValues.includes(String(value))) || !check) {
    const target = fromEnvironment ? parameter.environment : parameter.name;
    const detail = parameter.sensitive ? `Invalid ${target}.` : `Invalid ${target}: '${String(raw)}'.`;
    throw usageFailure(`${detail}${parameter.acceptedValues ? ` Expected ${parameter.acceptedValues.join(', ')}.` : ''}`, command);
  }
  return value;
}

/** Parses argv against the command metadata, returning validated values or a usage failure. */
export function parseCommand(argv: string[], environment: NodeJS.ProcessEnv = process.env): Args {
  const values: Record<string, unknown> = {};
  const positionals: string[] = [];
  let name = '';
  let ended = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!ended && token === '--') { ended = true; continue; }
    if (!ended && token.startsWith('-') && token !== '-' && !/^-\d/.test(token)) {
      const options = [...globalOptions, ...(name ? commands[name].options : [])];
      const separator = token.indexOf('=');
      const flag = separator < 0 ? token : token.slice(0, separator);
      const negated = flag.startsWith('--no-');
      const option = options.find((entry) => flag === `--${entry.name}` || (entry.short && flag === `-${entry.short}`) || (negated && entry.type === 'boolean' && flag === `--no-${entry.name}`));
      if (!option) throw unknownToken('option', flag, options.map((entry) => `--${entry.name}`), name);
      let raw: unknown;
      if (option.type === 'boolean') {
        if (separator >= 0) throw usageFailure(`Option '${flag}' does not take a value.`, name);
        raw = flag !== `--no-${option.name}`;
      } else {
        raw = separator < 0 ? argv[++index] : token.slice(separator + 1);
        if (raw === undefined || (typeof raw === 'string' && raw.startsWith('-') && raw !== '-' && !/^-\d/.test(raw))) throw usageFailure(`Option '${flag}' requires ${option.valueHint ?? 'a value'}.`, name);
      }
      if (option.repeat === 'collect') {
        const collected = values[option.name];
        if (Array.isArray(collected)) collected.push(raw);
        else values[option.name] = [raw];
      } else values[option.name] = raw;
    } else if (!name) {
      if (!Object.hasOwn(commands, token)) throw unknownToken('command', token, Object.keys(commands));
      name = token;
    } else positionals.push(token);
  }
  const command = commands[name];
  const args = { ...values, command: name, json: Boolean(values.json), name: String(values.name ?? 'default'), nameExplicit: values.name !== undefined } as Args;
  if (!command) {
    for (const parameter of globalOptions) if (args[parameter.name] !== undefined) args[parameter.name] = valueFor(parameter, args[parameter.name], name);
    return args;
  }
  let offset = 0;
  for (const argument of command.arguments) {
    const raw = argument.repeat === 'collect' ? positionals.slice(offset) : positionals[offset];
    if (argument.repeat === 'collect') offset = positionals.length;
    else if (raw !== undefined) offset++;
    if (raw !== undefined && (!Array.isArray(raw) || raw.length)) args[argument.name] = raw;
  }
  if (offset < positionals.length) throw usageFailure(`Unexpected argument '${positionals[offset]}'.`, name);
  if (args.help || args.version) return args;
  const early = command.validate?.(args);
  if (early instanceof Failure) throw early;
  for (const parameter of [...globalOptions, ...command.options, ...command.arguments]) {
    const rawEnvironment = parameter.environment ? environment[parameter.environment] : undefined;
    const environmentValue = parameter.environment === 'SCREEN_RELAY_CONFIG'
      ? rawEnvironment || undefined
      : parameter.repeat === 'collect' && rawEnvironment !== undefined && !rawEnvironment.trim()
        ? undefined
        : rawEnvironment;
    let raw = args[parameter.name] ?? environmentValue ?? (parameter.deferredDefault ? undefined : parameter.default);
    if (parameter.repeat === 'collect' && typeof raw === 'string') raw = raw.split(/\s+/).filter(Boolean);
    if (raw === undefined) {
      if (parameter.required) throw usageFailure(`Missing argument ${parameter.valueHint ?? parameter.name}.`, name, parameter.missingReason ?? 'missing_input');
      continue;
    }
    const fromEnvironment = args[parameter.name] === undefined && environmentValue !== undefined;
    args[parameter.name] = Array.isArray(raw) ? raw.map((item) => valueFor(parameter, item, name, fromEnvironment)) : valueFor(parameter, raw, name, fromEnvironment);
  }
  const problem = command.validate?.(args);
  if (problem) throw problem instanceof Failure ? problem : usageFailure(problem, name);
  return args;
}
