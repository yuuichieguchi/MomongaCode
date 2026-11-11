import type { ExecutableHelpers } from '@momonga/foundation';
import { runMain } from '../src/run-main.ts';
import { nodePorts } from '../src/node-ports.ts';

const LINES = 20_000;
const OWN_EXIT_CODE = 7;

const helpers: ExecutableHelpers = {
  flood: async () => {
    const ports = nodePorts('0.0.0', new AbortController().signal);
    for (let line = 0; line < LINES; line += 1) {
      ports.stdout.write(`line ${line} of the output of a command whose reader has gone\n`);
      if (line % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    ports.stderr.write('the command reached its end\n');
    return OWN_EXIT_CODE;
  },
};

await runMain('0.0.0', {}, async () => helpers);
