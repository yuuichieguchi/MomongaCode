import { BASE_ENTRY_FLAGS, announceReady, momongaPaths, parseFlags } from '@momonga/foundation';
import { SUPERVISOR_APP_VERSION } from '../app-version.ts';

export const STDERR_FLOOD_BYTES = 128 * 1024;

const FLOOD_LINE = `${'x'.repeat(1023)}\n`;

const writeFlood = (): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stderr.write(FLOOD_LINE.repeat(STDERR_FLOOD_BYTES / FLOOD_LINE.length), (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });

export const stderrFloodMain = async (argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
  const flags = parseFlags(argv, BASE_ENTRY_FLAGS);
  const home = flags.home;
  if (home === undefined) throw new Error('the stderr flood fixture requires --home');
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
  await writeFlood();
  announceReady({ service: 'supervisor', pid: process.pid, version: SUPERVISOR_APP_VERSION, socketPath: momongaPaths(home).sockets.supervisor, startedAt: new Date().toISOString() });
};

if (import.meta.main) await stderrFloodMain();
