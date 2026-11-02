import { nodeEntryIo } from '@momonga/foundation';
import { daemonEntries } from './daemon/entries.ts';
import { describeFailure } from './failure.ts';
import { nodePorts } from './node-ports.ts';
import type { CliPorts } from './ports.ts';
import { pathsOf } from './paths.ts';
import { buildProgram } from './program.ts';
import type { UpdateWiring } from './update/background.ts';
import { nodeUpdateWiring } from './update/wiring.ts';
import { nodePolicyVerifyHost } from './verify/host.ts';

const entryIo = (args: readonly string[]): ReturnType<typeof nodeEntryIo> => ({ ...nodeEntryIo(), argv: [...args] });

export const runMain = async (version: string, overrides: Partial<CliPorts> = {}): Promise<void> => {
  const interrupt = new AbortController();
  process.once('SIGINT', () => interrupt.abort());

  try {
    const ports: CliPorts = { ...nodePorts(version), ...overrides };
    let update: UpdateWiring | undefined;
    const program = buildProgram({
      ports,
      policyVerify: nodePolicyVerifyHost(ports, pathsOf(ports)),
      entries: daemonEntries(ports.self),
      update: () => (update ??= nodeUpdateWiring(ports, pathsOf(ports))),
      interrupt: interrupt.signal,
      entryIo,
      complete: (code) => {
        process.exitCode = code;
      },
    });
    await program.parseAsync();
  } catch (error) {
    process.stderr.write(`momonga: ${describeFailure(error)}\n`);
    process.exitCode = 1;
  }
};
