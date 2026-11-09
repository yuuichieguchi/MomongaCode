import { createStopValuesReader, readUserStopValues } from '@momonga/config';
import type { StopValuesReader } from '@momonga/config';
import {
  COMMON_ENTRY_FLAGS,
  RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS,
  canonicalPath,
  generationLayout,
  momongaPaths,
  runDaemonEntry,
  supervisorMaxCloseMs,
} from '@momonga/foundation';
import type { EntryIo, JsonLogger } from '@momonga/foundation';
import { SUPERVISOR_GENERATION, SUPERVISOR_SERVICE } from './constants.ts';
import { startSupervisor } from './start-supervisor.ts';
import type { SupervisorOptions } from './start-supervisor.ts';

export type SupervisorEntryDeps = Omit<
  SupervisorOptions,
  'home' | 'env' | 'logger' | 'droppedLogLines' | 'stdout' | 'signal' | 'onShutdownRequested' | 'stopValues'
>;

const pathsOf = (home: string): ReturnType<typeof momongaPaths> => momongaPaths(canonicalPath(home), process.platform, {});

export const runSupervisorEntry = (io: EntryIo, deps: SupervisorEntryDeps): Promise<number> => {
  let stopValues: StopValuesReader | undefined;
  const stopValuesOf = (home: string, logger: JsonLogger): StopValuesReader => {
    stopValues ??= createStopValuesReader({ load: () => readUserStopValues(canonicalPath(home)), onNotice: (message) => logger.warn(message) });
    return stopValues;
  };
  return runDaemonEntry(io, {
    service: SUPERVISOR_SERVICE,
    version: deps.version,
    flags: COMMON_ENTRY_FLAGS,
    maxCloseMs: (_flags, values) => supervisorMaxCloseMs(deps.runtime?.drainTimeoutMs ?? RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS, values),
    readStopValues: ({ home, logger }) => stopValuesOf(home, logger).read(),
    ownLockPath: (home) => generationLayout(canonicalPath(home), SUPERVISOR_GENERATION).locks.supervisor,
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
        stopValues: stopValuesOf(context.home, context.logger),
        acquireLock: context.acquireLock,
      });
      return { close: supervisor.close, abort: supervisor.abort, fatal: supervisor.fatal };
    },
  });
};
