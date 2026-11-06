import { describeFailure } from '../../failure.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';

type ShellSlash = {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly longRunning: (tokens: readonly string[]) => boolean;
};

const never = (): boolean => false;
const always = (): boolean => true;

export const SHELL_SLASH_COMMANDS: readonly ShellSlash[] = [
  { name: 'cost', usage: '[run-id] [--session <id>] [--all] [--breakdown] [--json]', description: 'show the model cost of a run, of a session, or of the sessions of this folder', longRunning: never },
  { name: 'reliability', usage: '[--group-by <key>] [--explain]', description: 'report the completion, recovery, duplicate, intervention, budget and time indicators of the terminal tasks', longRunning: never },
  { name: 'status', usage: '[run-id] [--json]', description: 'show a run, the subagent runs under it and the approvals waiting in them', longRunning: never },
  { name: 'jobs', usage: '[session-id] [--json]', description: 'list the background jobs of a session, including those of its subagents', longRunning: never },
  { name: 'trace', usage: '[run-id] [--json]', description: 'show the model and tool spans of a run', longRunning: never },
  { name: 'mcp', usage: 'list [--json] | login <server> [--no-browser]', description: 'inspect and authorize the MCP servers of this folder', longRunning: (tokens) => tokens[0] === 'login' },
  {
    name: 'context',
    usage: 'improve --dataset <file> --alias <alias> --token-cap <n> --outcome <file> | guideline adopt <file> | guideline list | guideline rollback <version>',
    description: 'improve how the context is compacted, and inspect, adopt and roll back the compaction guideline',
    longRunning: (tokens) => tokens[0] === 'improve',
  },
  { name: 'policy', usage: 'verify [--json] [--mode <mode>] [--secret <path>]', description: 'check the permission rules of this folder', longRunning: always },
  { name: 'models', usage: '[--json]', description: 'list the model aliases with the capabilities their targets declare', longRunning: never },
  { name: 'gateway', usage: 'probe <target> [--fm-binary <path>] [--samples <count>]', description: 'measure a model target and record the result for the gateway', longRunning: always },
];

export const runShellCommand = async (name: string, args: string, context: SlashContext, longRunning: boolean): Promise<void> => {
  const argv = [name, ...args.split(/\s+/).filter((part) => part !== '')];
  const work = async (signal: AbortSignal): Promise<void> => {
    const code = await context.shell.run(argv, { write: (text) => context.info(text.replace(/\n$/, '')), signal });
    if (code !== 0) context.info(`/${name} exited with code ${code}`);
  };
  if (longRunning) {
    context.background(`/${name}`, work).then(
      () => undefined,
      (error: unknown) => context.info(`/${name} stopped: ${describeFailure(error)}`),
    );
    return;
  }
  try {
    await work(new AbortController().signal);
  } catch (error) {
    context.info(`/${name} failed: ${describeFailure(error)}`);
  }
};

const commandOf = (entry: ShellSlash): SlashCommand => ({
  name: entry.name,
  usage: entry.usage,
  description: entry.description,
  run: (args, context) => runShellCommand(entry.name, args, context, entry.longRunning(args.split(/\s+/).filter((part) => part !== ''))),
});

export const shellSlashCommands: readonly SlashCommand[] = SHELL_SLASH_COMMANDS.map(commandOf);
