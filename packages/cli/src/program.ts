import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { currentSocketResolver } from '@momonga/foundation';
import type { EntryIo } from '@momonga/foundation';
import { PERMISSION_MODES } from '@momonga/protocol';
import type { PermissionMode } from '@momonga/protocol';
import { serveAcp } from './acp/serve.ts';
import { daemonStart, daemonStatus, daemonStop } from './commands/daemon.ts';
import { registerProductCommands } from './commands/register.ts';
import { runUpdate } from './commands/update.ts';
import { describeFailure } from './failure.ts';
import { UPDATE_CHECK_COMMAND, announceUpdate, runBackgroundCheck, startBackgroundCheck } from './update/background.ts';
import { probeTarget } from './commands/gateway.ts';
import { approve, attachRun, cancelRun } from './commands/runs.ts';
import { showTrace } from './commands/trace.ts';
import { INTERNAL_COMMANDS } from './daemon/launcher.ts';
import { createGatewayClient } from './client/gateway-client.ts';
import { pathsOf } from './paths.ts';
import { terminalPorts } from './terminal-writer.ts';
import type { ProgramDeps } from './program-deps.ts';
import type { ShellPort } from './tui/slash.ts';
import { OUTPUT_FORMATS, runHeadless } from './run/headless.ts';
import type { OutputFormat } from './run/headless.ts';

const startsInteractiveSession = (program: Command, action: Command): boolean => action === program && action.opts<RootOptions>().print === undefined;

const isBackgroundCheckExempt = (commandName: string): boolean => commandName.startsWith('__') || commandName === 'update';

type RootOptions = {
  print?: string;
  outputFormat: OutputFormat;
  permissionMode?: PermissionMode;
  model?: string;
  dangerouslySkipPermissions?: true;
  skill?: string;
  image: string[];
  verbose?: true;
};

export { pathsOf } from './paths.ts';
export type { ProgramDeps } from './program-deps.ts';

const integerArgument =
  (minimum: number) =>
  (text: string): number => {
    const value = Number(text);
    if (!Number.isInteger(value) || value < minimum) throw new InvalidArgumentError(`expected an integer of at least ${minimum}`);
    return value;
  };

const collectValues = (value: string, previous: string[]): string[] => [...previous, value];

const outputFormatOption = (): Option => new Option('--output-format <format>', 'output format of --print and attach').choices(OUTPUT_FORMATS).default('text');

export const buildProgram = (given: ProgramDeps, options: { embedded?: boolean } = {}): Command => {
  const deps: ProgramDeps = { ...given, ports: terminalPorts(given.ports) };
  const { ports } = deps;
  const program = new Command();
  program.configureOutput({ writeOut: (text) => ports.stdout.write(text), writeErr: (text) => ports.stderr.write(text) });
  program.name('momonga').version(ports.version).enablePositionalOptions().showHelpAfterError();

  program.hook('preAction', async (_program, action) => {
    if (options.embedded === true || isBackgroundCheckExempt(action.name())) return;
    const wiring = await deps.update();
    try {
      if (!startsInteractiveSession(program, action)) {
        const notice = await announceUpdate(wiring);
        if (notice !== undefined) ports.stderr.write(`momonga: ${notice}\n`);
      }
      await startBackgroundCheck(wiring);
    } catch (error) {
      ports.stderr.write(`momonga: the background update check was not started: ${describeFailure(error)}\n`);
    }
  });

  program
    .argument('[prompt]', 'initial prompt of the interactive session')
    .option('-p, --print <prompt>', 'run the prompt without a terminal UI and print the result')
    .addOption(outputFormatOption())
    .addOption(new Option('--permission-mode <mode>', 'permission mode of the session').choices(PERMISSION_MODES))
    .option('--model <alias>', 'the model alias of the session; momonga models lists them, and /model switches it in an interactive session')
    .option('--dangerously-skip-permissions', 'run in bypassPermissions mode')
    .option('--skill <name>', 'run the prompt with this skill activated')
    .option('--image <path>', 'attach an image to the prompt; repeat for several (needs a model that declares image input)', collectValues, [])
    .option('--verbose', 'print tool activity to stderr')
    .action(async (prompt: string | undefined, options: RootOptions) => {
      const permissionMode = options.dangerouslySkipPermissions === true ? 'bypassPermissions' : options.permissionMode;
      const session = {
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(options.model === undefined ? {} : { modelAlias: options.model }),
        ...(options.dangerouslySkipPermissions === true ? { bypassAllowed: true } : {}),
      };
      if (options.print !== undefined) {
        const paths = await pathsOf(ports);
        const capabilitiesOf = async (alias: string) => {
          const gateway = createGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway') });
          try {
            return await gateway.capabilitiesOf(alias);
          } finally {
            await gateway.close();
          }
        };
        deps.complete(await runHeadless(ports, paths, { capabilitiesOf, prompt: options.print, format: options.outputFormat, verbose: options.verbose === true, interrupt: deps.interrupt, ...(options.skill === undefined ? {} : { skill: options.skill }), images: options.image, ...session }));
        return;
      }
      if (ports.terminal === undefined) throw new Error('the interactive session needs a terminal; pass --print <prompt> to run without one');
      const { runInteractive } = await import('./tui/run-interactive.tsx');
      deps.complete(await runInteractive(ports, await pathsOf(ports), ports.terminal, { ...(prompt === undefined ? {} : { prompt }), ...(options.skill === undefined ? {} : { skill: options.skill }), images: options.image, ...session }, await deps.update(), createShellPort(given)));
    });

  program
    .command('attach [run-id]')
    .description('follow a run until it ends; the latest run of this directory when no id is given')
    .addOption(outputFormatOption())
    .option('--after <seq>', 'show events after this sequence number', integerArgument(0), 0)
    .option('--verbose', 'print tool activity to stderr')
    .action(async (runId: string | undefined, options: { outputFormat: OutputFormat; after: number; verbose?: true }) => {
      deps.complete(
        await attachRun(ports, await pathsOf(ports), {
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
      deps.complete(await approve(ports, await pathsOf(ports), approvalId, option));
    });

  program
    .command('cancel [run-id]')
    .description('cancel a run; the running run of this directory when no id is given')
    .action(async (runId: string | undefined) => {
      deps.complete(await cancelRun(ports, await pathsOf(ports), runId));
    });

  program
    .command('trace [run-id]')
    .description('show the model and tool spans of a run; the latest run of this directory when no id is given')
    .option('--json', 'print the trace as JSON')
    .action(async (runId: string | undefined, options: { json?: true }) => {
      deps.complete(await showTrace(ports, await pathsOf(ports), runId, options.json === true));
    });

  program
    .command('acp')
    .description('speak the Agent Client Protocol on standard input and output so an editor can drive momonga')
    .action(async () => {
      deps.complete(await serveAcp(ports, await pathsOf(ports), deps.interrupt));
    });

  program
    .command('update')
    .description('replace this executable with the latest release after verifying its checksum and signature')
    .option('--check', 'only report whether a newer release exists')
    .action(async (options: { check?: true }) => {
      deps.complete(await runUpdate(await deps.update(), ports.stdout, { checkOnly: options.check === true, interrupt: deps.interrupt }));
    });

  const daemon = program.command('daemon').description('manage the background daemon');
  daemon.command('start').description('start the daemon, or restart it when it runs another version').action(async () => {
    deps.complete(await daemonStart(ports, await pathsOf(ports)));
  });
  daemon.command('status').action(async () => {
    deps.complete(await daemonStatus(ports, await pathsOf(ports)));
  });
  daemon.command('stop').action(async () => {
    deps.complete(await daemonStop(ports, await pathsOf(ports)));
  });

  const gateway = program.command('gateway').description('inspect and tune the model gateway');
  gateway
    .command('probe <target>')
    .description('measure a managed server, chat-completions or ollama target and record the result for the gateway (an ollama target: trained context length, tools, vision, thinking and model digest; a managed or chat-completions target: tool calling, structured output, stop sequences, parallel calls, reasoning control, usage)')
    .option('--samples <count>', 'samples per measured rate', integerArgument(1))
    .action(async (target: string, options: { samples?: number }) => {
      deps.complete(
        await probeTarget(ports, await pathsOf(ports), target, {
          interrupt: deps.interrupt,
          ...(options.samples === undefined ? {} : { samples: options.samples }),
        }),
      );
    });

  registerProductCommands(program, deps);

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
  program
    .command(UPDATE_CHECK_COMMAND, { hidden: true })
    .helpOption(false)
    .action(async () => {
      deps.complete(await runBackgroundCheck(await deps.update(), deps.interrupt));
    });
  internal(INTERNAL_COMMANDS.supervise, deps.entries.supervise);
  internal(INTERNAL_COMMANDS.gateway, deps.entries.gateway);
  internal(INTERNAL_COMMANDS.runtime, deps.entries.runtime);

  return program;
};

export const createShellPort = (given: ProgramDeps): ShellPort => ({
  run: async (argv, io) => {
    let code = 0;
    const sink = { write: io.write };
    const program = buildProgram({ ...given, ports: { ...given.ports, stdout: sink, stderr: sink }, interrupt: io.signal, complete: (exitCode) => void (code = exitCode) }, { embedded: true });
    program.exitOverride();
    try {
      await program.parseAsync([...argv], { from: 'user' });
    } catch (error) {
      if (error instanceof CommanderError) return error.exitCode;
      throw error;
    }
    return code;
  },
});
