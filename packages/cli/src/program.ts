import { colourOffWhenAsked } from './tui/screen/theme.ts';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_OK, EXIT_USAGE, HELPER_COMMAND, LONGEST_LIMIT_MS, SANDBOX_NETWORK_SETTINGS } from '@momonga/foundation';
import type { EntryIo, SandboxNetworkSetting } from '@momonga/foundation';
import { REASONING_EFFORTS, DEFAULT_PROBE_STEP_SECONDS, PERMISSION_MODES, PROMPT_TEXT_MAX_CHARS, TRACE_CONTENT_PAGE_OPTION, issueRunInput, messageOf, probeStepBoundMs } from '@momonga/protocol';
import type { Mandate, PermissionMode, ReasoningEffort } from '@momonga/protocol';
import { serveAcp } from './acp/serve.ts';
import { daemonStart, daemonStatus, daemonStop } from './commands/daemon.ts';
import { registerProductCommands } from './commands/register.ts';
import { runUpdate } from './commands/update.ts';
import { describeFailure } from './failure.ts';
import { UPDATE_CHECK_COMMAND, announceUpdate, runBackgroundCheck, startBackgroundCheck } from './update/background.ts';
import type { BackgroundCheckHandle } from './update/background.ts';
import { probeModel } from './commands/gateway.ts';
import { approve, attachRun, cancelRun } from './commands/runs.ts';
import { showTrace } from './commands/trace.ts';
import { showReport } from './commands/report.ts';
import { sessionSocketResolver } from './daemon/generations.ts';
import { INTERNAL_COMMANDS } from './daemon/launcher.ts';
import { createGatewayClient } from './client/gateway-client.ts';
import type { GatewayClient } from './client/gateway-client.ts';
import { pathsOf } from './paths.ts';
import { terminalPorts } from './terminal-writer.ts';
import { runHelper } from './helper-mode.ts';
import { UsageError } from './usage-error.ts';
import type { ProgramDeps } from './program-deps.ts';
import type { HeadlessReopen, Reopen } from './run/resolve-session.ts';
import type { ShellPort } from './tui/slash.ts';
import type { StandardInput } from './ports.ts';
import { OUTPUT_FORMATS, runHeadless } from './run/headless.ts';
import type { OutputFormat } from './run/headless.ts';

const LONGEST_PROMPT = `the longest prompt is ${PROMPT_TEXT_MAX_CHARS.toLocaleString('en-US')} characters`;

const pipedText = async (stdin: StandardInput, signal: AbortSignal): Promise<string> => {
  if (stdin.isTerminal) return '';
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stdin.bytes()) {
    signal.throwIfAborted();
    text += decoder.decode(chunk, { stream: true });
    if (text.length > PROMPT_TEXT_MAX_CHARS) throw new UsageError(`the standard input piped to -p is longer than a prompt may be: ${LONGEST_PROMPT}`);
  }
  return text + decoder.decode();
};

const printedPrompt = async (given: string | true, stdin: StandardInput, signal: AbortSignal): Promise<string> => {
  const piped = await pipedText(stdin, signal);
  if (given === true) {
    if (piped === '') throw new UsageError('-p needs a prompt: give it after -p, or pipe it on standard input');
    return piped;
  }
  if (piped === '') return given;
  const prompt = `${given}\n\n${piped}`;
  if (prompt.length > PROMPT_TEXT_MAX_CHARS) throw new UsageError(`the prompt with the standard input piped to it is ${prompt.length.toLocaleString('en-US')} characters: ${LONGEST_PROMPT}`);
  return prompt;
};

const startsInteractiveSession = (program: Command, action: Command): boolean => action === program && action.opts<RootOptions>().print === undefined;

const isBackgroundCheckExempt = (commandName: string): boolean => commandName.startsWith('__') || commandName === 'update';

type RootOptions = {
  print?: string | true;
  outputFormat: OutputFormat;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: ReasoningEffort;
  dangerouslySkipPermissions?: true;
  sandboxNetwork?: SandboxNetworkSetting;
  skill?: string;
  image: string[];
  until: string[];
  require: string[];
  mandate?: string;
  issue?: string;
  maxCostUsd?: number;
  verbose?: true;
  resume?: string | true;
  continue?: true;
  screenReader?: true;
};

export const reopenOf = (options: Pick<RootOptions, 'resume' | 'continue'>): Reopen | undefined => {
  if (options.resume === true) return { kind: 'pick' };
  if (options.resume !== undefined) return { kind: 'id', id: options.resume };
  return options.continue === true ? { kind: 'newest' } : undefined;
};

const headlessReopenOf = (reopen: Reopen | undefined): HeadlessReopen | undefined => {
  if (reopen?.kind === 'pick') throw new UsageError(messageOf('resumeNeedsIdToPrint', 'cli'));
  return reopen;
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

const LARGEST_HOST_TIMER_SECONDS = Math.floor(LONGEST_LIMIT_MS / 1000);

const integerBetween =
  (minimum: number, maximum: number) =>
  (text: string): number => {
    const value = Number(text);
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new InvalidArgumentError(`expected an integer from ${minimum} to ${maximum}`);
    return value;
  };

const collectValues = (value: string, previous: string[]): string[] => [...previous, value];

const mandateOf = (options: Pick<RootOptions, 'until' | 'require' | 'mandate'>): { mandate?: Mandate } => {
  const completes = options.until.length > 0 || options.require.length > 0;
  if (!completes && options.mandate === undefined) return {};
  return {
    mandate: {
      ...(options.mandate === undefined ? {} : { profile: options.mandate }),
      ...(completes
        ? {
            completion: {
              ...(options.until.length === 0 ? {} : { conditions: options.until.map((command) => ({ command })) }),
              ...(options.require.length === 0 ? {} : { requirements: options.require }),
            },
          }
        : {}),
    },
  };
};

type ModeOption = { readonly name: keyof RootOptions; readonly flag: string };

const PRINT_ONLY_OPTIONS: readonly ModeOption[] = [
  { name: 'outputFormat', flag: '--output-format' },
  { name: 'verbose', flag: '--verbose' },
];

const INTERACTIVE_ONLY_OPTIONS: readonly ModeOption[] = [{ name: 'screenReader', flag: '--screen-reader' }];

const moneyArgument = (text: string): number => {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new InvalidArgumentError('expected an amount of US dollars, zero or more');
  return value;
};

const returnInsteadOfExit = (command: Command): void => {
  command.exitOverride();
  for (const sub of command.commands) returnInsteadOfExit(sub);
};

const isInterruption = (error: unknown, interrupt: AbortSignal | undefined): boolean => {
  if (interrupt?.aborted !== true) return false;
  for (let current = error; current !== undefined && current !== null; current = current instanceof Error ? current.cause : undefined) {
    if (current === interrupt.reason) return true;
  }
  return false;
};

export const exitOfFailure = (error: unknown, stderr: { write(text: string): unknown }, interrupt?: AbortSignal): number => {
  if (error instanceof CommanderError) return error.exitCode === EXIT_OK ? EXIT_OK : EXIT_USAGE;
  if (isInterruption(error, interrupt)) return EXIT_INTERRUPTED;
  stderr.write(`momonga: ${describeFailure(error)}\n`);
  return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE;
};

const outputFormatOption = (): Option => new Option('--output-format <format>', 'output format of --print and attach').choices(OUTPUT_FORMATS).default('text');

export const buildProgram = (given: ProgramDeps, options: { embedded?: boolean } = {}): Command => {
  const deps: ProgramDeps = { ...given, ports: terminalPorts(given.ports) };
  const { ports } = deps;
  const program = new Command();
  let backgroundCheck: BackgroundCheckHandle | undefined;
  program.configureOutput({ writeOut: (text) => ports.stdout.write(text), writeErr: (text) => ports.stderr.write(text) });
  program.name('momonga').version(ports.version).enablePositionalOptions().showHelpAfterError();

  program.hook('preAction', async (_program, action) => {
    backgroundCheck = undefined;
    if (options.embedded === true || isBackgroundCheckExempt(action.name())) return;
    const wiring = await deps.update();
    try {
      if (!startsInteractiveSession(program, action)) {
        const notice = await announceUpdate(wiring);
        if (notice !== undefined) ports.stderr.write(`momonga: ${notice}\n`);
      }
      if (ports.handover?.started === undefined) backgroundCheck = await startBackgroundCheck(wiring);
    } catch (error) {
      ports.stderr.write(`momonga: the background update check was not started: ${describeFailure(error)}\n`);
    }
  });

  program
    .argument('[prompt]', 'initial prompt of the interactive session')
    .option('-p, --print [prompt]', 'run the prompt without a terminal UI and print the result; text piped on standard input is given to the run after the prompt, and is the prompt when -p has none')
    .addOption(outputFormatOption())
    .addOption(new Option('--permission-mode <mode>', 'permission mode of the session').choices(PERMISSION_MODES))
    .option('--model <model>', 'the model of the session, for example devstral-small-2 (momonga models lists them; /model switches it in an interactive session)')
    .addOption(new Option('--effort <level>', 'the reasoning effort the session asks of its model, sent only to a model that declares a reasoning control and moved to the nearest level it accepts (/effort changes it in an interactive session)').choices(REASONING_EFFORTS))
    .option('--dangerously-skip-permissions', 'run in bypassPermissions mode')
    .addOption(new Option('--sandbox-network <setting>', 'the network of a sandboxed command in this session: deny, ask or allow; wins over the setting sandboxNetwork').choices(SANDBOX_NETWORK_SETTINGS))
    .option('--skill <name>', 'run the prompt with this skill activated')
    .option('--image <path>', 'attach an image to the prompt; repeat for several (needs a model that declares image input)', collectValues, [])
    .option('--until <command>', 'a shell command that must exit 0 before the run counts as complete; repeat for several. The runtime runs it after the model stops, never the model, so it must only check and change nothing', collectValues, [])
    .option('--require <text>', 'a completion requirement that has no mechanical check; the report lists it as not run; repeat for several', collectValues, [])
    .option('--mandate <name>', 'run under the mandate of this name from the user settings (mandates): only what it allows is run, what it asks for is held for your approval while other work goes on, and its budget bounds the run')
    .option('--issue <address>', 'run without a terminal UI to resolve an issue on a declared forge, given by its address as the forge shows it (https://<host>/<owner>/<name>/issues/<number>); needs --mandate; the run ends with a pull request that closes the issue and a comment on it')
    .option('--max-cost-usd <usd>', 'the money limit of the run in US dollars; the run stops before a model request that would pass it', moneyArgument)
    .option('--verbose', 'print tool activity to stderr')
    .addOption(new Option('--resume [session-id]', 'reopen a conversation of this folder by its id or a unique prefix of at least 8 characters; without an id, choose from a list').conflicts('continue'))
    .option('--continue', 'reopen the newest conversation of this folder')
    .option('--screen-reader', 'draw the interactive session as plain appended lines for a screen reader')
    .action(async (prompt: string | undefined, options: RootOptions, command: Command) => {
      if (options.issue !== undefined) {
        if (options.print !== undefined || prompt !== undefined) throw new UsageError(messageOf('issueBesidePrompt', 'cli'));
        if (options.mandate === undefined) throw new UsageError(messageOf('issueNeedsMandate', 'cli'));
      }
      const printing = options.print !== undefined || options.issue !== undefined;
      const typed = (name: keyof RootOptions): boolean => command.getOptionValueSource(name) === 'cli';
      const unapplied = (printing ? INTERACTIVE_ONLY_OPTIONS : PRINT_ONLY_OPTIONS).find((option) => typed(option.name));
      if (unapplied !== undefined) throw new UsageError(messageOf(printing ? 'optionNeedsInteractive' : 'optionNeedsPrint', 'cli', { option: unapplied.flag }));
      if (options.print !== undefined && options.print !== true && prompt !== undefined) throw new UsageError(messageOf('promptGivenTwice', 'cli', { value: options.print, prompt }));
      const print = options.print === true && prompt !== undefined ? prompt : options.print;
      const reopen = reopenOf(options);
      const permissionMode = options.dangerouslySkipPermissions === true ? 'bypassPermissions' : options.permissionMode;
      const session = {
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.dangerouslySkipPermissions === true ? { bypassAllowed: true } : {}),
        ...(options.sandboxNetwork === undefined ? {} : { sandboxNetwork: options.sandboxNetwork }),
      };
      const bounds = { ...mandateOf(options), ...(options.maxCostUsd === undefined ? {} : { limits: { maxCostUsd: options.maxCostUsd } }) };
      const headlessInput = options.issue !== undefined ? { issue: options.issue } : print === undefined ? undefined : { print };
      if (headlessInput !== undefined) {
        const resumed = headlessReopenOf(reopen);
        const headlessPrompt = async (): Promise<string> => ('issue' in headlessInput ? issueRunInput(headlessInput.issue) : printedPrompt(headlessInput.print, ports.stdin, deps.interrupt));
        const paths = await pathsOf(ports);
        const asked = async <T>(ask: (gateway: GatewayClient) => Promise<T>): Promise<T> => {
          const gateway = createGatewayClient({ resolveSocket: sessionSocketResolver(ports, paths, 'gateway') });
          try {
            return await ask(gateway);
          } finally {
            await gateway.close();
          }
        };
        const capabilitiesOf = (model: string) => asked((gateway) => gateway.capabilitiesOf(model));
        const modelList = () => asked((gateway) => gateway.modelList(deps.interrupt));
        deps.complete(await runHeadless(ports, paths, { capabilitiesOf, modelList, prompt: headlessPrompt, ...(options.issue === undefined ? {} : { issue: options.issue }), format: options.outputFormat, verbose: options.verbose === true, interrupt: deps.interrupt, ...(options.skill === undefined ? {} : { skill: options.skill }), images: options.image, ...bounds, ...session, ...(resumed === undefined ? {} : { reopen: resumed }) }));
        return;
      }
      if (ports.terminal === undefined) {
        const read = prompt === undefined ? '' : ` "${prompt}" is not the name of a command and was read as its first prompt;`;
        throw new Error(`the interactive session needs a terminal;${read} pass --print <prompt> to run without one`);
      }
      colourOffWhenAsked(ports.env, ports.terminal);
      const { runInteractive } = await import('./tui/run-interactive.tsx');
      deps.complete(await runInteractive(ports, await pathsOf(ports), ports.terminal, { ...(prompt === undefined ? {} : { prompt }), ...(options.skill === undefined ? {} : { skill: options.skill }), images: options.image, ...bounds, ...session, ...(reopen === undefined ? {} : { reopen }), ...(backgroundCheck === undefined ? {} : { backgroundCheck }), screenReader: options.screenReader === true }, await deps.update(), createShellPort(given)));
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
    .command('report [run-id]')
    .description('show the verification report of a run: the declared completion conditions, what passed, failed or was not run, and the residual risk; the latest run of this directory when no id is given')
    .option('--json', 'print the report as JSON')
    .action(async (runId: string | undefined, options: { json?: true }) => {
      deps.complete(await showReport(ports, await pathsOf(ports), runId, options.json === true));
    });

  program
    .command('trace [run-id]')
    .description('show the model and tool spans of a run; the latest run of this directory when no id is given')
    .option('--json', 'print the trace as JSON')
    .option('--content', 'print the stored message content of the run that has not expired, instead of the trace; with --json one JSON object per line')
    .option(
      `${TRACE_CONTENT_PAGE_OPTION.flag} <count>`,
      `with --content: the stored bodies read per request, from ${TRACE_CONTENT_PAGE_OPTION.minimum} to ${TRACE_CONTENT_PAGE_OPTION.maximum}; ${TRACE_CONTENT_PAGE_OPTION.default} when omitted`,
      integerBetween(TRACE_CONTENT_PAGE_OPTION.minimum, TRACE_CONTENT_PAGE_OPTION.maximum),
      TRACE_CONTENT_PAGE_OPTION.default,
    )
    .action(async (runId: string | undefined, options: { json?: true; content?: true; pageSize: number }, command: Command) => {
      if (options.content !== true && command.getOptionValueSource('pageSize') === 'cli') throw new UsageError(`${TRACE_CONTENT_PAGE_OPTION.flag} sets how many stored bodies --content reads per request, so it needs --content`);
      deps.complete(await showTrace(ports, await pathsOf(ports), runId, { json: options.json === true, content: options.content === true, pageSize: options.pageSize }));
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
  daemon.command('start').description('start the daemon, or start a new one beside it when this program is newer').action(async () => {
    deps.complete(await daemonStart(ports, await pathsOf(ports)));
  });
  daemon
    .command('status')
    .description('show whether the daemon runs, its version and the state of its processes')
    .option('--json', 'print the status as one JSON document')
    .action(async (options: { json?: true }) => {
      deps.complete(await daemonStatus(ports, await pathsOf(ports), { json: options.json === true }));
    });
  daemon.command('stop').description('stop the daemon and the work it runs, after a bounded wait for its processes to end').action(async () => {
    deps.complete(await daemonStop(ports, await pathsOf(ports)));
  });

  const gateway = program.command('gateway').description('inspect and tune the model gateway');
  gateway
    .command('probe <model>')
    .description('measure a model of a managed server, an OpenAI-compatible server or an Ollama server and record the result for the gateway (an Ollama server: trained context length, tools, vision, thinking and model digest; a managed or OpenAI-compatible server: tool calling, structured output, stop sequences, parallel calls, reasoning control, usage)')
    .option('--samples <count>', 'samples per measured rate', integerArgument(1))
    .option('--step-timeout <seconds>', 'the bound of each measuring step, in seconds', integerBetween(1, LARGEST_HOST_TIMER_SECONDS), DEFAULT_PROBE_STEP_SECONDS)
    .option('--yes', 'consent to measure a model paid for by use, up to the bound of requests and tokens the measurement can send')
    .action(async (model: string, options: { samples?: number; stepTimeout: number; yes?: true }) => {
      deps.complete(
        await probeModel(ports, await pathsOf(ports), model, {
          interrupt: deps.interrupt,
          stepTimeoutMs: probeStepBoundMs(options.stepTimeout),
          consented: options.yes === true,
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
  program
    .command(HELPER_COMMAND, { hidden: true })
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .argument('[args...]')
    .action(async () => {
      deps.complete(await runHelper(deps.helper));
    });
  internal(INTERNAL_COMMANDS.supervise, deps.entries.supervise);
  internal(INTERNAL_COMMANDS.gateway, deps.entries.gateway);
  internal(INTERNAL_COMMANDS.runtime, deps.entries.runtime);

  returnInsteadOfExit(program);
  return program;
};

export const createShellPort = (given: ProgramDeps): ShellPort => ({
  run: async (argv, io) => {
    let code: number = EXIT_OK;
    const sink = { write: io.write };
    const program = buildProgram({ ...given, ports: { ...given.ports, stdout: sink, stderr: sink, terminal: undefined }, interrupt: io.signal, complete: (exitCode) => void (code = exitCode) }, { embedded: true });
    try {
      await program.parseAsync([...argv], { from: 'user' });
    } catch (error) {
      return exitOfFailure(error, sink, io.signal);
    }
    return code;
  },
});
