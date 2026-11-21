import { describeFailure } from '../../failure.ts';
import { commandWords } from '../command-words.ts';
import { NEEDS_SESSION_NOTE } from '../slash.ts';
import type { SlashCommand, SlashContext, SlashSubcommand } from '../slash.ts';

type ShellSlash = {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly subcommands?: readonly SlashSubcommand[];
  readonly elsewhere?: Readonly<Record<string, string>>;
  readonly sessionArgument?: true;
};

export const SHELL_SLASH_COMMANDS: readonly ShellSlash[] = [
  { name: 'cost', usage: '[run-id] [--session <id>] [--all] [--breakdown] [--json]', description: 'show the model cost of a run, of a session, or of the sessions of this folder' },
  { name: 'reliability', usage: '[--group-by <key>] [--days <n>] [--explain]', description: 'report the completion, recovery, duplicate, intervention, budget, time and cost indicators of the ended runs of the period' },
  { name: 'auth', usage: 'status [--json] | logout <account>', description: 'show the saved subscription accounts, or sign one out', subcommands: [
      { name: 'status', usage: '[--json]', description: 'show the saved accounts, their state, where to manage usage, and the model new sessions start with or the model named' },
      { name: 'logout', usage: '<account>', description: 'sign out a saved account' },
    ], elsewhere: { login: 'sign in with /login' } },
  { name: 'status', usage: '[run-id] [--json]', description: 'show a run, the subagent runs under it and the approvals waiting in them' },
  { name: 'jobs', usage: '[session-id] [--json]', description: 'list the background jobs of a session, including those of its subagents', sessionArgument: true },
  { name: 'trace', usage: '[run-id] [--json]', description: 'show the model and tool spans of a run' },
  { name: 'mcp', usage: 'list [--json] | login <server> [--no-browser]', description: 'inspect and authorize the MCP servers of this folder', subcommands: [
      { name: 'list', usage: '[--json]', description: 'list the MCP servers with their transport and authorization state' },
      { name: 'login', usage: '<server> [--no-browser]', description: 'authorize a remote MCP server in the browser' },
    ] },
  {
    name: 'context',
    usage: 'improve [--candidates <n>] [--dataset <file>] [--model <model>] [--token-cap <n>] [--outcome <file>] [--yes] | guideline adopt <file> | guideline list | guideline rollback <version>',
    description: 'improve how the context is compacted, and inspect, adopt and roll back the compaction guideline',
    subcommands: [
      { name: 'improve', usage: '[--candidates <n>] [--dataset <file>] [--model <model>] [--token-cap <n>] [--outcome <file>] [--yes]', description: 'improve how the context is compacted, from the failures a bench shows' },
      {
        name: 'guideline',
        usage: 'adopt <file> | list | rollback <version>',
        description: 'inspect, adopt and roll back the compaction guideline',
        subcommands: [
          { name: 'adopt', usage: '<file>', description: 'store the winner of an outcome file that context improve wrote' },
          { name: 'list', description: 'list the adopted guidelines, oldest first' },
          { name: 'rollback', usage: '<version>', description: 'return to the text of an earlier version, recorded as a new version' },
        ],
      },
    ],
  },
  { name: 'policy', usage: 'verify [--json] [--mode <mode>] [--secret <path>] [--mandate <name>]', description: 'check the permission rules of this folder', subcommands: [
      { name: 'verify', usage: '[--json] [--mode <mode>] [--secret <path>] [--mandate <name>]', description: 'prove that no allow rule gets around a deny rule, that no rule leaves a route to secrets, and that every rule can take effect' },
    ] },
  { name: 'gateway', usage: 'probe <model> [--samples <count>] [--step-timeout <seconds>] [--yes]', description: 'measure a model and record the result for the gateway', subcommands: [{ name: 'probe', usage: '<model> [--samples <count>] [--step-timeout <seconds>] [--yes]', description: 'measure a model of a managed server, an OpenAI-compatible server or an Ollama server and record what it supports' }] },
];

const subcommandLines = (entry: ShellSlash, subcommands: readonly SlashSubcommand[]): string[] => {
  const width = Math.max(...subcommands.map((subcommand) => subcommand.name.length));
  return [...subcommands.map((subcommand) => `  /${entry.name} ${subcommand.name.padEnd(width)}  ${subcommand.description}`), `usage: /${entry.name} ${entry.usage}`];
};

const answerWithoutRunning = (entry: ShellSlash | undefined, words: readonly string[]): string | undefined => {
  if (entry?.subcommands === undefined) return undefined;
  const [first] = words;
  if (first === undefined) return [`/${entry.name} has these subcommands:`, ...subcommandLines(entry, entry.subcommands)].join('\n');
  if (first.startsWith('-') || entry.subcommands.some((subcommand) => subcommand.name === first)) return undefined;
  const pointer = entry.elsewhere?.[first];
  if (pointer !== undefined) return `usage: /${entry.name} ${entry.usage}; ${pointer}`;
  return [`/${entry.name} has no subcommand ${first}; it has these subcommands:`, ...subcommandLines(entry, entry.subcommands)].join('\n');
};

const argvOf = (entry: ShellSlash | undefined, name: string, words: readonly string[], context: SlashContext): readonly string[] | undefined => {
  if (entry?.sessionArgument === undefined || words.some((word) => !word.startsWith('-'))) return [name, ...words];
  const own = context.sessions.current();
  return own === undefined ? undefined : [name, own, ...words];
};

export const runShellArgv = (name: string, argv: readonly string[], context: SlashContext): void => {
  const work = async (signal: AbortSignal): Promise<void> => {
    const code = await context.shell.run(argv, { write: (text) => context.info(text.replace(/\n$/, '')), signal });
    if (code !== 0) context.info(`/${name} exited with code ${code}`);
  };
  context.background(`/${name}`, work).then(
    () => undefined,
    (error: unknown) => context.info(`/${name} stopped: ${describeFailure(error)}`),
  );
};

export const runShellCommand = async (name: string, line: string, context: SlashContext): Promise<void> => {
  const parsed = commandWords(line);
  if (parsed.kind === 'refused') {
    context.info(`/${name} was not run: ${parsed.reason}`);
    return;
  }
  const entry = SHELL_SLASH_COMMANDS.find((candidate) => candidate.name === name);
  const answer = answerWithoutRunning(entry, parsed.words);
  if (answer !== undefined) {
    context.info(answer);
    return;
  }
  const argv = argvOf(entry, name, parsed.words, context);
  if (argv === undefined) {
    context.info(NEEDS_SESSION_NOTE);
    return;
  }
  runShellArgv(name, argv, context);
};

const commandOf = (entry: ShellSlash): SlashCommand => ({
  name: entry.name,
  needsSession: false,
  usage: entry.usage,
  description: entry.description,
  ...(entry.subcommands === undefined ? {} : { subcommands: entry.subcommands }),
  run: (args, context) => runShellCommand(entry.name, args, context),
});

export const SCREEN_COMMAND_NAMES: readonly string[] = ['mcp', 'context'];

export const shellSlashCommands: readonly SlashCommand[] = SHELL_SLASH_COMMANDS.filter((entry) => !SCREEN_COMMAND_NAMES.includes(entry.name)).map(commandOf);

export const shellFormOf = (name: string): SlashCommand => {
  const entry = SHELL_SLASH_COMMANDS.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no shell command is named ${name}`);
  return commandOf(entry);
};
