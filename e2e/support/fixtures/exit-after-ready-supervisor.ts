import { BASE_ENTRY_FLAGS, announceReady, momongaPaths, parseFlags } from '@momonga/foundation';

export const EXIT_AFTER_READY_CODE = 3;

export const exitAfterReadyMain = (argv: readonly string[] = process.argv.slice(2)): void => {
  const flags = parseFlags(argv, BASE_ENTRY_FLAGS);
  const home = flags.home;
  if (home === undefined) throw new Error('the exit-after-ready fixture requires --home');
  announceReady({ service: 'supervisor', pid: process.pid, version: flags['app-version'], socketPath: momongaPaths(home).sockets.supervisor, startedAt: new Date().toISOString() });
  process.stdout.write('', () => process.exit(EXIT_AFTER_READY_CODE));
};

if (import.meta.main) exitAfterReadyMain();
