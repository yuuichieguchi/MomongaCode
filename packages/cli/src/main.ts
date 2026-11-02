import { nodeEntryIo } from '@momonga/foundation';
import packageJson from '../package.json' with { type: 'json' };
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

await program.parseAsync();
