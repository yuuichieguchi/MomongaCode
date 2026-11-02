import {
  BASE_ENTRY_FLAGS,
  RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS,
  canonicalPath,
  momongaPaths,
  runDaemonEntry,
  supervisorMaxCloseMs,
} from '@momonga/foundation';
import type { EntryIo } from '@momonga/foundation';
import { SUPERVISOR_SERVICE } from './constants.ts';
import { startSupervisor } from './start-supervisor.ts';
import type { SupervisorOptions } from './start-supervisor.ts';

export type SupervisorEntryDeps = Omit<
  SupervisorOptions,
  'home' | 'env' | 'logger' | 'droppedLogLines' | 'stdout' | 'signal' | 'onShutdownRequested'
>;

const pathsOf = (home: string): ReturnType<typeof momongaPaths> => momongaPaths(canonicalPath(home), process.platform, {});

export const runSupervisorEntry = (io: EntryIo, deps: SupervisorEntryDeps): Promise<number> =>
  runDaemonEntry(io, {
    service: SUPERVISOR_SERVICE,
    version: deps.version,
    flags: BASE_ENTRY_FLAGS,
    maxCloseMs: () => supervisorMaxCloseMs(deps.runtime?.drainTimeoutMs ?? RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS),
    ownLockPath: (home) => pathsOf(home).locks.supervisor,
    logPath: (home) => pathsOf(home).logFiles.supervisor,
    isConfigError: () => false,
    start: async (context) => {
      const supervisor = await startSupervisor({
        ...deps,
        clock: deps.clock ?? io.clock,
        timers: deps.timers ?? io.timers,
        home: canonicalPath(context.home),
        version: context.version,
        env: context.env,
        logger: context.logger,
        droppedLogLines: context.droppedLogLines,
        stdout: context.stdout,
        signal: context.signal,
        onShutdownRequested: context.requestShutdown,
        acquireLock: context.acquireLock,
      });
      return { close: supervisor.close, abort: supervisor.abort, fatal: supervisor.fatal };
    },
  });
