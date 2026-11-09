import { BASE_ENTRY_FLAGS, FIRST_GENERATION, announceReady, generationLayout, parseFlags } from '@momonga/foundation';
import { SUPERVISOR_APP_VERSION } from '../app-version.ts';

export const EXIT_AFTER_READY_CODE = 3;

export const exitAfterReadyMain = (argv: readonly string[] = process.argv.slice(2)): void => {
  const flags = parseFlags(argv, BASE_ENTRY_FLAGS);
  const home = flags.home;
  if (home === undefined) throw new Error('the exit-after-ready fixture requires --home');
  announceReady({ service: 'supervisor', pid: process.pid, version: SUPERVISOR_APP_VERSION, socketPath: generationLayout(home, FIRST_GENERATION).sockets.supervisor, startedAt: new Date().toISOString() });
  process.stdout.write('', () => process.exit(EXIT_AFTER_READY_CODE));
};

if (import.meta.main) exitAfterReadyMain();
