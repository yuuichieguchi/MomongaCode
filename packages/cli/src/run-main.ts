import { HELPER_COMMAND, guardStandardStreams, nodeEntryIo } from '@momonga/foundation';
import type { ExecutableHelpers } from '@momonga/foundation';
import { daemonEntries } from './daemon/entries.ts';
import { helperCallOf } from './helper-mode.ts';
import { provideEmbeddedWindowsKeeper } from './keeper/host.ts';
import { nodeHelperHost, nodePorts, processHome } from './node-ports.ts';
import type { CliPorts } from './ports.ts';
import { pathsOf } from './paths.ts';
import { buildProgram, exitOfFailure } from './program.ts';
import { terminalSink } from './terminal-writer.ts';
import type { UpdateWiring } from './update/background.ts';
import { nodeUpdateWiring } from './update/wiring.ts';

const registeredHelpers = async (): Promise<ExecutableHelpers> => (await import('@momonga/tools/executable-helpers')).executableHelpers;

export const runMain = async (version: string, overrides: Partial<CliPorts> = {}, helpers: () => Promise<ExecutableHelpers> = registeredHelpers): Promise<void> => {
  const interrupt = new AbortController();
  process.on('SIGINT', () => interrupt.abort());
  const streams = guardStandardStreams(process);
  const entryIo = (args: readonly string[]): ReturnType<typeof nodeEntryIo> => ({ ...nodeEntryIo(process, streams), argv: [...args] });

  try {
    const ports: CliPorts = { ...nodePorts(version, interrupt.signal, overrides.home ?? processHome(), streams), ...overrides };
    const given = ports.handover === undefined ? process.argv.slice(2) : [...ports.handover.args];
    const helperCall = helperCallOf(given);
    let update: UpdateWiring | undefined;
    const program = buildProgram({
      ports,
      entries: daemonEntries(ports.self, ports.version, ports.spawnDetached),
      helper: { helpers, call: helperCall, host: nodeHelperHost() },
      update: async () => (update ??= nodeUpdateWiring(ports, await pathsOf(ports))),
      interrupt: interrupt.signal,
      entryIo,
      complete: (code) => {
        process.exitCode = code;
      },
    });
    program.hook('preAction', () => provideEmbeddedWindowsKeeper(ports));
    await program.parseAsync(helperCall === undefined ? given : [HELPER_COMMAND], { from: 'user' });
  } catch (error) {
    process.exitCode = exitOfFailure(error, terminalSink(() => streams.stderr), interrupt.signal);
  }
};
