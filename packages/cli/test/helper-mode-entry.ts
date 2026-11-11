import type { ExecutableHelpers } from '@momonga/foundation';
import { runMain } from '../src/run-main.ts';

const textOf = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const helpers: ExecutableHelpers = {
  report: async (host) => {
    host.stdout.write(JSON.stringify({ args: host.args, input: await textOf(host.stdin), marker: host.env['HELPER_MODE_MARKER'] }));
    host.stderr.write('the helper wrote this');
    return 7;
  },
};

await runMain('0.0.0', {}, async () => helpers);
