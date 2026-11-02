import { nodeEntryIo } from '@momonga/foundation';
import { daemonEntries } from './daemon/entries.ts';
import { describeFailure } from './failure.ts';
import { nodePorts } from './node-ports.ts';
import type { CliPorts } from './ports.ts';
import { buildProgram } from './program.ts';

const entryIo = (args: readonly string[]): ReturnType<typeof nodeEntryIo> => ({ ...nodeEntryIo(), argv: [...args] });

export const runMain = async (version: string, overrides: Partial<CliPorts> = {}): Promise<void> => {
  const interrupt = new AbortController();
  process.once('SIGINT', () => interrupt.abort());

  const ports: CliPorts = { ...nodePorts(version), ...overrides };

  const program = buildProgram({
    ports,
    entries: daemonEntries(ports.self),
    interrupt: interrupt.signal,
    entryIo,
    complete: (code) => {
      process.exitCode = code;
    },
  });

  try {
    await program.parseAsync();
  } catch (error) {
    process.stderr.write(`momonga: ${describeFailure(error)}\n`);
    process.exitCode = 1;
  }
};
