import { nodeEntryIo } from '@momonga/foundation';
import packageJson from '../package.json' with { type: 'json' };
import { describeFailure } from './failure.ts';
import { nodePorts } from './node-ports.ts';
import { buildProgram } from './program.ts';

const interrupt = new AbortController();
process.once('SIGINT', () => interrupt.abort());

const entryIo = (args: readonly string[]): ReturnType<typeof nodeEntryIo> => ({ ...nodeEntryIo(), argv: [...args] });

const program = buildProgram({
  ports: nodePorts(packageJson.version),
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
