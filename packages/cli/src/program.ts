import { Command, InvalidArgumentError, Option } from 'commander';
import { canonicalPath, momongaPaths } from '@momonga/foundation';
import type { EntryIo, MomongaPaths } from '@momonga/foundation';
import { PERMISSION_MODES } from '@momonga/protocol';
import type { PermissionMode } from '@momonga/protocol';
import { serveAcp } from './acp/serve.ts';
import { daemonStatus, daemonStop } from './commands/daemon.ts';
import { DEFAULT_FM_BINARY, probeFm } from './commands/gateway.ts';
import { approve, attachRun, cancelRun } from './commands/runs.ts';
import { showTrace } from './commands/trace.ts';
import type { DaemonEntries } from './daemon/entries.ts';
import { INTERNAL_COMMANDS } from './daemon/launcher.ts';
import type { CliPorts } from './ports.ts';
import { OUTPUT_FORMATS, runHeadless } from './run/headless.ts';
import type { OutputFormat } from './run/headless.ts';

export type ProgramDeps = {
  ports: CliPorts;
  interrupt: AbortSignal;
  entryIo(args: readonly string[]): EntryIo;
  entries: DaemonEntries;
  complete(code: number): void;
};

type RootOptions = {
  print?: string;
  outputFormat: OutputFormat;
  permissionMode?: PermissionMode;
  dangerouslySkipPermissions?: true;
  verbose?: true;
};

export const pathsOf = (ports: Pick<CliPorts, 'home'>): MomongaPaths => momongaPaths(canonicalPath(ports.home), process.platform, {});

const integerArgument =
  (minimum: number) =>
  (text: string): number => {
    const value = Number(text);
    if (!Number.isInteger(value) || value < minimum) throw new InvalidArgumentError(`expected an integer of at least ${minimum}`);
    return value;
  };

const outputFormatOption = (): Option => new Option('--output-format <format>', 'output format of --print and attach').choices(OUTPUT_FORMATS).default('text');

export const buildProgram = (deps: ProgramDeps): Command => {
  const { ports } = deps;
  const program = new Command();
  program.name('momonga').version(ports.version).enablePositionalOptions().showHelpAfterError();

  program
    .argument('[prompt]', 'initial prompt of the interactive session')
    .option('-p, --print <prompt>', 'run the prompt without a terminal UI and print the result')
    .addOption(outputFormatOption())
    .addOption(new Option('--permission-mode <mode>', 'permission mode of the session').choices(PERMISSION_MODES))
    .option('--dangerously-skip-permissions', 'run in bypassPermissions mode')
    .option('--verbose', 'print tool activity to stderr')
    .action(async (prompt: string | undefined, options: RootOptions) => {
      const permissionMode = options.dangerouslySkipPermissions === true ? 'bypassPermissions' : options.permissionMode;
      const session = {
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(options.dangerouslySkipPermissions === true ? { bypassAllowed: true } : {}),
      };
      if (options.print !== undefined) {
        deps.complete(await runHeadless(ports, pathsOf(ports), { prompt: options.print, format: options.outputFormat, verbose: options.verbose === true, interrupt: deps.interrupt, ...session }));
        return;
      }
      if (ports.terminal === undefined) throw new Error('the interactive session needs a terminal; pass --print <prompt> to run without one');
      const { runInteractive } = await import('./tui/run-interactive.tsx');
      deps.complete(await runInteractive(ports, pathsOf(ports), ports.terminal, { ...(prompt === undefined ? {} : { prompt }), ...session }));
    });

  program
    .command('attach [run-id]')
    .description('follow a run until it ends; the latest run of this directory when no id is given')
    .addOption(outputFormatOption())
    .option('--after <seq>', 'show events after this sequence number', integerArgument(0), 0)
    .option('--verbose', 'print tool activity to stderr')
    .action(async (runId: string | undefined, options: { outputFormat: OutputFormat; after: number; verbose?: true }) => {
      deps.complete(
        await attachRun(ports, pathsOf(ports), {
          ...(runId === undefined ? {} : { runId }),
          format: options.outputFormat,
          after: options.after,
          verbose: options.verbose === true,
          interrupt: deps.interrupt,
        }),
      );
    });

  program
    .command('approve [approval-id] [option]')
    .description('list pending approvals, show one, or resolve it with allow_once, allow_always, reject_once or reject_always')
    .action(async (approvalId: string | undefined, option: string | undefined) => {
      deps.complete(await approve(ports, pathsOf(ports), approvalId, option));
    });

  program
    .command('cancel [run-id]')
    .description('cancel a run; the running run of this directory when no id is given')
    .action(async (runId: string | undefined) => {
      deps.complete(await cancelRun(ports, pathsOf(ports), runId));
    });

  program
    .command('trace [run-id]')
    .description('show the model and tool spans of a run; the latest run of this directory when no id is given')
    .option('--json', 'print the trace as JSON')
    .action(async (runId: string | undefined, options: { json?: true }) => {
      deps.complete(await showTrace(ports, pathsOf(ports), runId, options.json === true));
    });

  program
    .command('acp')
    .description('speak the Agent Client Protocol on standard input and output so an editor can drive momonga')
    .action(async () => {
      deps.complete(await serveAcp(ports, pathsOf(ports), deps.interrupt));
    });

  const daemon = program.command('daemon').description('manage the background daemon');
  daemon.command('status').action(async () => {
    deps.complete(await daemonStatus(ports, pathsOf(ports)));
  });
  daemon.command('stop').action(async () => {
    deps.complete(await daemonStop(ports, pathsOf(ports)));
  });

  const gateway = program.command('gateway').description('inspect and tune the model gateway');
  gateway
    .command('probe <target>')
    .description('measure an fm target (context window, tool calling) and record the result for the gateway')
    .option('--fm-binary <path>', 'the fm executable to probe', DEFAULT_FM_BINARY)
    .option('--samples <count>', 'samples per measured rate', integerArgument(1))
    .action(async (target: string, options: { fmBinary: string; samples?: number }) => {
      deps.complete(
        await probeFm(ports, pathsOf(ports), target, {
          fmBinary: options.fmBinary,
          interrupt: deps.interrupt,
          ...(options.samples === undefined ? {} : { samples: options.samples }),
        }),
      );
    });

  const internal = (name: string, run: (io: EntryIo) => Promise<number>): void => {
    program
      .command(name, { hidden: true })
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .argument('[args...]')
      .action(async (args: string[]) => {
        deps.complete(await run(deps.entryIo(args)));
      });
  };
  internal(INTERNAL_COMMANDS.supervise, deps.entries.supervise);
  internal(INTERNAL_COMMANDS.gateway, deps.entries.gateway);
  internal(INTERNAL_COMMANDS.runtime, deps.entries.runtime);

  return program;
};
