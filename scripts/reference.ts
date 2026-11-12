import fs from 'node:fs';
import path from 'node:path';
import type { Command, Option } from 'commander';
import { SETTINGS_SCHEMA, USER_LAYER_ONLY_MODES, USER_LAYER_ONLY_PARTS, USER_LAYER_ONLY_SETTINGS, PROJECT_ENV_NAMES } from '@momonga/config';
import { ENVIRONMENT_VARIABLES, EXIT_CODES, homeLayout } from '@momonga/foundation';
import type { EntryIo, EnvironmentVariableKind } from '@momonga/foundation';
import { TOOL_NAMES } from '@momonga/protocol';
import { OPERATION_SPECS } from '@momonga/tools';
import { buildProgram } from '../packages/cli/src/program.ts';
import type { CliPorts } from '../packages/cli/src/ports.ts';
import { INTERNAL_COMMANDS } from '../packages/cli/src/daemon/launcher.ts';
import { KEYS } from '../packages/cli/src/tui/keys/table.ts';

export const REFERENCE_FILE = path.resolve(import.meta.dirname, '..', 'docs', 'reference.md');

const SHOWN_HOME = '~';
const SHOWN_VERSION = '0.0.0';
const INTERNAL_NAMES: ReadonlySet<string> = new Set(Object.values(INTERNAL_COMMANDS));
const HELP_FLAGS = '-h, --help';

const unbuilt = (what: string): never => {
  throw new Error(`the reference reads the command tree only; ${what} is not built`);
};

const commandTree = (): Command => {
  const neverRun = new AbortController().signal;
  const ports = { version: SHOWN_VERSION, interrupt: neverRun, home: SHOWN_HOME, cwd: SHOWN_HOME, env: {}, platform: 'linux', terminal: undefined } as unknown as CliPorts;
  return buildProgram({
    ports,
    interrupt: neverRun,
    entryIo: () => unbuilt('an entry') as EntryIo,
    entries: { supervise: () => unbuilt('the supervisor'), gateway: () => unbuilt('the gateway'), runtime: () => unbuilt('the runtime') },
    helper: { run: () => unbuilt('a helper') } as never,
    update: () => unbuilt('the update'),
    complete: () => unbuilt('an exit'),
  });
};

type ShownCommand = { readonly path: string; readonly usage: string; readonly description: string; readonly options: readonly Option[] };

const isShown = (command: Command): boolean => !INTERNAL_NAMES.has(command.name()) && !command.name().startsWith('__') && !(command as unknown as { _hidden: boolean })._hidden;

const commandsOf = (command: Command, prefix: readonly string[]): ShownCommand[] =>
  command.commands.filter(isShown).flatMap((child) => {
    const words = [...prefix, child.name()];
    const usage = [...words, ...child.registeredArguments.map((argument) => (argument.required ? `<${argument.name()}${argument.variadic ? '...' : ''}>` : `[${argument.name()}${argument.variadic ? '...' : ''}]`))].join(' ');
    return [{ path: words.join(' '), usage, description: child.description(), options: child.options.filter((option) => !option.hidden) }, ...commandsOf(child, words)];
  });

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

const code = (text: string): string => `\`${text}\``;

const optionRow = (option: Option): string => {
  const notes = [
    ...(option.argChoices === undefined ? [] : [`values: ${option.argChoices.map(code).join(', ')}`]),
    ...(option.defaultValue === undefined || (Array.isArray(option.defaultValue) && option.defaultValue.length === 0) ? [] : [`default: ${code(JSON.stringify(option.defaultValue))}`]),
  ];
  return `| ${code(cell(option.flags))} | ${cell([option.description, ...notes].filter((part) => part !== '').join('; '))} |`;
};

const optionTable = (options: readonly Option[]): string[] => ['| Option | Meaning |', '| --- | --- |', ...options.map(optionRow), `| ${code(HELP_FLAGS)} | display help for the command |`];

type Schema = Readonly<Record<string, unknown>>;

const isSchema = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);

const schemasOf = (value: unknown): Schema[] => (Array.isArray(value) ? value.filter(isSchema) : []);

const boundsOf = (schema: Schema): string => {
  const bounds = [
    ...(typeof schema['minimum'] === 'number' ? [`at least ${schema['minimum']}`] : []),
    ...(typeof schema['maximum'] === 'number' ? [`at most ${schema['maximum']}`] : []),
    ...(typeof schema['minLength'] === 'number' && schema['minLength'] > 0 ? ['not empty'] : []),
    ...(typeof schema['minItems'] === 'number' && schema['minItems'] > 0 ? [`at least ${schema['minItems']} entry`] : []),
  ];
  return bounds.length === 0 ? '' : ` (${bounds.join(', ')})`;
};

const typeOf = (schema: Schema): string => {
  if (Array.isArray(schema['enum'])) return schema['enum'].map((value) => code(JSON.stringify(value))).join(' or ');
  if (schema['const'] !== undefined) return code(JSON.stringify(schema['const']));
  const choices = [...schemasOf(schema['oneOf']), ...schemasOf(schema['anyOf'])];
  if (choices.length > 0) return choices.map(typeOf).join(' or ');
  const type = schema['type'];
  if (type === 'array') return `array of ${isSchema(schema['items']) ? typeOf(schema['items']) : 'values'}${boundsOf(schema)}`;
  if (type === 'object') return isSchema(schema['properties']) ? 'object' : isSchema(schema['additionalProperties']) ? `map of ${typeOf(schema['additionalProperties'])}` : 'object';
  if (Array.isArray(type)) return type.join(' or ');
  if (typeof type === 'string') return `${type}${boundsOf(schema)}`;
  return 'any value';
};

type SettingRow = { readonly key: string; readonly type: string; readonly defaultText: string; readonly unit: string };

const ENTRY = '<name>';

const DEFAULTS_BY_TEXT: Readonly<Record<string, (key: string, value: string) => string>> = {
  platform: (key, value) => `${value} on ${key}`,
  event: (key, value) => `${code(key)}: ${value}`,
};

const valueText = (value: unknown): string => code(JSON.stringify(value));

const defaultsByOf = (schema: Schema): string[] => {
  const defaultsBy = schema['defaultsBy'];
  if (!isSchema(defaultsBy) || typeof defaultsBy['by'] !== 'string' || !isSchema(defaultsBy['values'])) return [];
  const text = DEFAULTS_BY_TEXT[defaultsBy['by']];
  if (text === undefined) throw new Error(`the reference has no text for defaults by ${defaultsBy['by']}`);
  return Object.entries(defaultsBy['values']).map(([key, value]) => text(key, valueText(value)));
};

const defaultTextOf = (schema: Schema): string => [...(schema['default'] === undefined ? [] : [valueText(schema['default'])]), ...defaultsByOf(schema)].join('; ');

const unitOf = (schema: Schema): string => (typeof schema['unit'] === 'string' ? schema['unit'] : '');

const settingRows = (schema: Schema, prefix: string): SettingRow[] => {
  const properties = schema['properties'];
  if (isSchema(properties)) {
    return Object.entries(properties).flatMap(([name, child]) => {
      const key = prefix === '' ? name : `${prefix}.${name}`;
      return isSchema(child) ? [{ key, type: typeOf(child), defaultText: defaultTextOf(child), unit: unitOf(child) }, ...settingRows(child, key)] : [];
    });
  }
  const entry = schema['additionalProperties'];
  if (schema['type'] === 'object' && isSchema(entry)) return settingRows(entry, `${prefix}.${ENTRY}`);
  const items = schema['items'];
  if (schema['type'] === 'array' && isSchema(items)) return settingRows(items, `${prefix}[]`);
  return [];
};

const topLevelOf = (key: string): string => key.split(/[.[]/)[0] ?? key;

const layerOf = (key: string): string => {
  if (USER_LAYER_ONLY_SETTINGS.includes(topLevelOf(key)) || USER_LAYER_ONLY_PARTS.some((part) => key === part || key.startsWith(`${part}.`))) return 'user';
  if (key === 'permissions.defaultMode') return `user, project, local (${USER_LAYER_ONLY_MODES.map(code).join(' and ')}: user only)`;
  if (key === 'env') return `user, project, local (project and local: only ${PROJECT_ENV_NAMES.map(code).join(', ')} and \`LC_*\`)`;
  return 'user, project, local';
};

const KIND_HEADINGS: Readonly<Record<EnvironmentVariableKind, string>> = {
  read: 'Read by momonga',
  given: 'Given by momonga to the commands it starts',
  installer: 'Read by the installers (install.sh and install.ps1)',
};

const environmentSection = (): string[] =>
  Object.entries(KIND_HEADINGS).flatMap(([kind, heading]) => [
    `### ${heading}`,
    '',
    '| Variable | Meaning |',
    '| --- | --- |',
    ...ENVIRONMENT_VARIABLES.filter((variable) => variable.kind === kind).map((variable) => `| ${code(variable.name)} | ${cell(variable.meaning)} |`),
    '',
  ]);

const keyFileName = (): string => path.posix.basename(homeLayout(SHOWN_HOME, 'linux').keybindingsFile);

export const renderReference = async (): Promise<string> => {
  const program = commandTree();
  const commands = commandsOf(program, []);
  const settings = settingRows(SETTINGS_SCHEMA, '');
  const lines = [
    '# momonga reference',
    '',
    'Generated by `node scripts/reference.ts` from the tables of the product. Do not edit this file by hand: change the product and generate it again.',
    '',
    '## Root options',
    '',
    '```text',
    `momonga [options] [prompt]`,
    '```',
    '',
    ...optionTable(program.options.filter((option) => !option.hidden)),
    '',
    '## Commands',
    '',
    '| Command | Meaning |',
    '| --- | --- |',
    ...commands.map((command) => `| ${code(`momonga ${command.usage}`)} | ${cell(command.description)} |`),
    '',
    ...commands.filter((command) => command.options.length > 0).flatMap((command) => [`### momonga ${command.path}`, '', ...optionTable(command.options), '']),
    '## Settings keys',
    '',
    'The layer column names the settings files that may set the key: the user file `~/.momonga/settings.json`, the project file `.momonga/settings.json` of a trusted folder, and the local file of the folder. A key that a project or local file sets outside its layer is discarded with a warning. `<name>` stands for a name you choose and `[]` for each entry of a list.',
    '',
    '| Key | Value | Default | Unit | Layer |',
    '| --- | --- | --- | --- | --- |',
    ...settings.map((row) => `| ${code(row.key)} | ${cell(row.type)} | ${cell(row.defaultText)} | ${row.unit} | ${cell(layerOf(row.key))} |`),
    '',
    '## Environment variables',
    '',
    ...environmentSection(),
    '## Exit codes',
    '',
    '| Code | Meaning |',
    '| --- | --- |',
    ...Object.values(EXIT_CODES).map((exit) => `| ${exit.code} | ${cell(exit.meaning)} |`),
    '',
    '## Key bindings',
    '',
    `The file \`~/.momonga/${keyFileName()}\` changes the keys of the interactive session; \`/keybindings\` shows and changes them.`,
    '',
    '| Action | Where | Default keys | Meaning |',
    '| --- | --- | --- | --- |',
    ...KEYS.map((row) => `| ${code(row.id)} | ${row.context} | ${row.default.map((key) => code(key)).join(', ')} | ${cell(row.description)} |`),
    '',
    '## Built-in tools',
    '',
    ...TOOL_NAMES.map((name) => `- ${code(name)}`),
    '',
    '### Operations tools',
    '',
    '| Tool | Meaning |',
    '| --- | --- |',
    ...OPERATION_SPECS.map((spec) => `| ${code(spec.name)} | ${cell(spec.description)} |`),
    '',
  ];
  return lines.join('\n');
};

export type ReferenceNames = {
  readonly commands: ReadonlySet<string>;
  readonly settings: ReadonlySet<string>;
  readonly topLevelSettings: ReadonlySet<string>;
  readonly environment: ReadonlySet<string>;
  readonly userOnlySettings: readonly string[];
};

export const referenceNames = async (): Promise<ReferenceNames> => ({
  commands: new Set(commandsOf(commandTree(), []).map((command) => command.path)),
  settings: new Set(settingRows(SETTINGS_SCHEMA, '').map((row) => row.key)),
  topLevelSettings: new Set(Object.keys(SETTINGS_SCHEMA.properties)),
  environment: new Set(ENVIRONMENT_VARIABLES.map((variable) => variable.name)),
  userOnlySettings: USER_LAYER_ONLY_SETTINGS,
});

if (import.meta.main) {
  fs.writeFileSync(REFERENCE_FILE, await renderReference());
}
