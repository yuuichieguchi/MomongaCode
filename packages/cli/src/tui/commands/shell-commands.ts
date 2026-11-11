import { describeFailure } from '../../failure.ts';
import { commandWords } from '../command-words.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';

type ShellSlash = {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly subcommands?: readonly string[];
  readonly elsewhere?: Readonly<Record<string, string>>;
};

export const SHELL_SLASH_COMMANDS: readonly ShellSlash[] = [
  { name: 'cost', usage: '[run-id] [--session <id>] [--all] [--breakdown] [--json]', description: 'show the model cost of a run, of a session, or of the sessions of this folder' },
  { name: 'reliability', usage: '[--group-by <key>] [--days <n>] [--explain]', description: 'report the completion, recovery, duplicate, intervention, budget, time and cost indicators of the terminal tasks of the period' },
  { name: 'auth', usage: 'status [--json] | logout <account>', description: 'show the saved subscription accounts, or sign one out', subcommands: ['status', 'logout'], elsewhere: { login: 'sign in with /login' } },
  { name: 'status', usage: '[run-id] [--json]', description: 'show a run, the subagent runs under it and the approvals waiting in them' },
  { name: 'jobs', usage: '[session-id] [--json]', description: 'list the background jobs of a session, including those of its subagents' },
  { name: 'trace', usage: '[run-id] [--json]', description: 'show the model and tool spans of a run' },
  { name: 'mcp', usage: 'list [--json] | login <server> [--no-browser]', description: 'inspect and authorize the MCP servers of this folder', subcommands: ['list', 'login'] },
  {
    name: 'context',
    usage: 'improve --dataset <file> --model <model> --token-cap <n> --outcome <file> | guideline adopt <file> | guideline list | guideline rollback <version>',
    description: 'improve how the context is compacted, and inspect, adopt and roll back the compaction guideline',
    subcommands: ['improve', 'guideline'],
  },
  { name: 'policy', usage: 'verify [--json] [--mode <mode>] [--secret <path>] [--mandate <name>]', description: 'check the permission rules of this folder', subcommands: ['verify'] },
  { name: 'models', usage: '[--json] | detect [url...] [--json]', description: 'list the configured models with the capabilities they declare, or find the local model servers that are running' },
  { name: 'gateway', usage: 'probe <model> [--samples <count>]', description: 'measure a model and record the result for the gateway', subcommands: ['probe'] },
];

const refusalOf = (entry: ShellSlash | undefined, words: readonly string[]): string | undefined => {
  const [first] = words;
  if (entry?.subcommands === undefined || first === undefined || first.startsWith('-') || entry.subcommands.includes(first)) return undefined;
  const usage = `usage: /${entry.name} ${entry.usage}`;
  const pointer = entry.elsewhere?.[first];
  return pointer === undefined ? `/${entry.name} has no subcommand ${first}; ${usage}` : `${usage}; ${pointer}`;
};

export const runShellCommand = async (name: string, line: string, context: SlashContext): Promise<void> => {
  const parsed = commandWords(line);
  if (parsed.kind === 'refused') {
    context.info(`/${name} was not run: ${parsed.reason}`);
    return;
  }
  const refusal = refusalOf(
    SHELL_SLASH_COMMANDS.find((entry) => entry.name === name),
    parsed.words,
  );
  if (refusal !== undefined) {
    context.info(refusal);
    return;
  }
  const argv = [name, ...parsed.words];
  const work = async (signal: AbortSignal): Promise<void> => {
    const code = await context.shell.run(argv, { write: (text) => context.info(text.replace(/\n$/, '')), signal });
    if (code !== 0) context.info(`/${name} exited with code ${code}`);
  };
  context.background(`/${name}`, work).then(
    () => undefined,
    (error: unknown) => context.info(`/${name} stopped: ${describeFailure(error)}`),
  );
};

const commandOf = (entry: ShellSlash): SlashCommand => ({
  name: entry.name,
  needsSession: false,
  usage: entry.usage,
  description: entry.description,
  run: (args, context) => runShellCommand(entry.name, args, context),
});

export const SCREEN_COMMAND_NAMES: readonly string[] = ['mcp', 'models'];

export const shellSlashCommands: readonly SlashCommand[] = SHELL_SLASH_COMMANDS.filter((entry) => !SCREEN_COMMAND_NAMES.includes(entry.name)).map(commandOf);

export const shellFormOf = (name: string): SlashCommand => {
  const entry = SHELL_SLASH_COMMANDS.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no shell command is named ${name}`);
  return commandOf(entry);
};
