import { COMMON_ENTRY_FLAGS, announceReady, momongaPaths, parseFlags, watchLifeline } from '@momonga/foundation';
import type { FlagSpec } from '@momonga/foundation';
import { SUPERVISOR_APP_VERSION } from '../app-version.ts';

export const NOISY_STDERR_LINES = ['raw stderr line', '{"level":"info","msg":"fake daemon log","service":"gateway"}'] as const;
export const NOISY_STDOUT_LINE = 'stray stdout line';
export const NOISY_JSON_MSG = 'fake daemon log';

const NOISY_FLAGS = { ...COMMON_ENTRY_FLAGS, role: { kind: 'string', required: true } } as const satisfies FlagSpec;
const HOLD_OPEN_INTERVAL_MS = 60_000;

const writeLine = (stream: NodeJS.WriteStream, line: string): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.write(`${line}\n`, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });

export const noisyDaemonMain = async (argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
  const flags = parseFlags(argv, NOISY_FLAGS);
  const home = flags.home;
  if (home === undefined) throw new Error('the noisy daemon requires --home');
  const role = flags.role;
  if (role !== 'gateway' && role !== 'runtime') throw new Error(`unknown --role ${role}`);
  const lifelineFd = flags['lifeline-fd'];
  if (lifelineFd === undefined) throw new Error('the noisy daemon requires --lifeline-fd');
  const stop = (): never => process.exit(0);
  process.on('SIGTERM', stop);
  watchLifeline(lifelineFd, { onEnd: stop, onLine: () => undefined, onOverlongLine: () => undefined });
  for (const line of NOISY_STDERR_LINES) await writeLine(process.stderr, line);
  await writeLine(process.stdout, NOISY_STDOUT_LINE);
  announceReady({ service: role, pid: process.pid, version: SUPERVISOR_APP_VERSION, socketPath: momongaPaths(home).sockets[role], startedAt: new Date().toISOString() });
  setInterval(() => undefined, HOLD_OPEN_INTERVAL_MS);
};

if (import.meta.main) await noisyDaemonMain();
