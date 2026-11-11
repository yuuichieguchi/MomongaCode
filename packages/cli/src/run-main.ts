import { nodeEntryIo } from '@momonga/foundation';
import { daemonEntries } from './daemon/entries.ts';
import { provideEmbeddedWindowsKeeper } from './keeper/host.ts';
import { nodePorts } from './node-ports.ts';
import type { CliPorts } from './ports.ts';
import { pathsOf } from './paths.ts';
import { buildProgram, exitOfFailure } from './program.ts';
import { terminalSink } from './terminal-writer.ts';
import type { UpdateWiring } from './update/background.ts';
import { nodeUpdateWiring } from './update/wiring.ts';
import { nodePolicyVerifyHost } from './verify/host.ts';

const entryIo = (args: readonly string[]): ReturnType<typeof nodeEntryIo> => ({ ...nodeEntryIo(), argv: [...args] });

export const runMain = async (version: string, overrides: Partial<CliPorts> = {}): Promise<void> => {
  const interrupt = new AbortController();
  process.once('SIGINT', () => interrupt.abort());

  try {
    const ports: CliPorts = { ...nodePorts(version, interrupt.signal), ...overrides };
    let update: UpdateWiring | undefined;
    const program = buildProgram({
      ports,
      policyVerify: async () => nodePolicyVerifyHost(ports, await pathsOf(ports)),
      entries: daemonEntries(ports.self, ports.version, ports.spawnDetached),
      update: async () => (update ??= nodeUpdateWiring(ports, await pathsOf(ports))),
      interrupt: interrupt.signal,
      entryIo,
      complete: (code) => {
        process.exitCode = code;
      },
    });
    program.hook('preAction', () => provideEmbeddedWindowsKeeper(ports));
    if (ports.handover === undefined) await program.parseAsync();
    else await program.parseAsync([...ports.handover.args], { from: 'user' });
  } catch (error) {
    process.exitCode = exitOfFailure(error, terminalSink(() => process.stderr));
  }
};
