import { createStopValuesReader, readUserStopValuesOrDefault } from '@momonga/config';
import type { StopValuesReader } from '@momonga/config';
import {
  COMMON_ENTRY_FLAGS,
  EntryUsageError,
  withLogData,
  generationLayout,
  momongaPaths,
  runDaemonEntry,
  supervisorMaxCloseMs,
} from '@momonga/foundation';
import type { EntryIo, JsonLogger } from '@momonga/foundation';
import { SUPERVISOR_SERVICE } from './constants.ts';
import { entryReaperPass } from './reaper-pass.ts';
import type { EntryReaperOptions } from './reaper-pass.ts';
import { startSupervisor } from './start-supervisor.ts';
import type { SupervisorOptions } from './start-supervisor.ts';

export type SupervisorEntryDeps = Omit<
  SupervisorOptions,
  'home' | 'env' | 'logger' | 'droppedLogLines' | 'stdout' | 'signal' | 'onShutdownRequested' | 'stopValues' | 'generation'
> & { reaper?: EntryReaperOptions };

export const SUPERVISE_ENTRY_FLAGS = { ...COMMON_ENTRY_FLAGS, generation: { kind: 'string' } } as const;

export const GENERATION_FLAG_USAGE = 'supervise requires --generation=<N>, a positive whole number';

const POSITIVE_WHOLE_NUMBER = /^[1-9][0-9]*$/;

export const generationOfFlag = (value: string | undefined): number => {
  const generation = value !== undefined && POSITIVE_WHOLE_NUMBER.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(generation)) throw new EntryUsageError(GENERATION_FLAG_USAGE);
  return generation;
};

const pathsOf = (home: string): ReturnType<typeof momongaPaths> => momongaPaths(home, process.platform, {});

export const runSupervisorEntry = (io: EntryIo, deps: SupervisorEntryDeps): Promise<number> => {
  let stopValues: StopValuesReader | undefined;
  const stopValuesOf = (logger: JsonLogger): StopValuesReader => {
    stopValues ??= createStopValuesReader({ onNotice: (message) => logger.warn(message) });
    return stopValues;
  };
  return runDaemonEntry(io, {
    service: SUPERVISOR_SERVICE,
    version: deps.version,
    flags: SUPERVISE_ENTRY_FLAGS,
    maxCloseMs: (_flags, values) => supervisorMaxCloseMs(values),
    readStopValues: ({ logger }) => stopValuesOf(logger).read(),
    ownLockPath: (home, flags) => generationLayout(home, generationOfFlag(flags.generation)).locks.supervisor,
    logPath: (home) => pathsOf(home).logFiles.supervisor,
    isConfigError: () => false,
    start: async (context) => {
      const clock = deps.clock ?? io.clock;
      const timers = deps.timers ?? io.timers;
      const logger = withLogData(context.logger, { generation: generationOfFlag(context.flags.generation) });
      const stopValuesAtStart = stopValuesOf(context.logger);
      stopValuesAtStart.remember(await readUserStopValuesOrDefault({ home: context.home, signal: context.signal, onNotice: (message) => context.logger.warn(message) }));
      const supervisor = await startSupervisor({
        ...deps,
        reaperPass: deps.reaperPass ?? entryReaperPass(deps, { home: context.home, clock, timers, logger, stopValues: stopValuesAtStart }),
        clock,
        timers,
        home: context.home,
        version: context.version,
        generation: generationOfFlag(context.flags.generation),
        env: context.env,
        logger,
        droppedLogLines: context.droppedLogLines,
        stdout: context.stdout,
        signal: context.signal,
        onShutdownRequested: context.requestShutdown,
        stopValues: stopValuesAtStart,
        acquireLock: context.acquireLock,
      });
      return { close: supervisor.close, abort: supervisor.abort, fatal: supervisor.fatal };
    },
  });
};
