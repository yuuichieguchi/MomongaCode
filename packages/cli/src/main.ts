import { nodeEntryIo } from '@momonga/foundation';
import packageJson from '../package.json' with { type: 'json' };
import { daemonEntries } from './daemon/entries.ts';
import { describeFailure } from './failure.ts';
import { nodePorts } from './node-ports.ts';
import { buildProgram, pathsOf } from './program.ts';
import { nodeUpdateWiring } from './update/wiring.ts';

const interrupt = new AbortController();
process.once('SIGINT', () => interrupt.abort());

const entryIo = (args: readonly string[]): ReturnType<typeof nodeEntryIo> => ({ ...nodeEntryIo(), argv: [...args] });

const ports = nodePorts(packageJson.version);

const program = buildProgram({
  ports,
  entries: daemonEntries(ports.self),
  update: nodeUpdateWiring(ports, pathsOf(ports)),
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
