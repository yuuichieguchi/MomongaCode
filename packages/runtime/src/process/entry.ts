import { ConfigError, createStopValuesReader, readUserStopValues } from '@momonga/config';
import { CHILD_ENTRY_FLAGS, generationLayout, momongaPaths, runDaemonEntry, runtimeMaxCloseMs } from '@momonga/foundation';
import type { EntryIo, FlagSpec } from '@momonga/foundation';
import { installOtelErrorHandler } from '@momonga/observability';
import { startRuntimeProcess } from './start-runtime-process.ts';
import type { BundledRipgrepSource, StartRuntimeProcessOptions } from './start-runtime-process.ts';
import type { RuleSolverSource } from './rule-verifier.ts';

export const RUNTIME_ENTRY_FLAGS = {
  ...CHILD_ENTRY_FLAGS,
  'lease-ms': { kind: 'int' },
  'worker-count': { kind: 'int' },
  'sandbox-exec-path': { kind: 'string' },
} as const satisfies FlagSpec;

export type RuntimeEntryDeps = { version: string; bundledRipgrep?: BundledRipgrepSource; ruleSolver?: RuleSolverSource };

export const runRuntimeEntry = (io: EntryIo, deps: RuntimeEntryDeps): Promise<number> =>
  runDaemonEntry(io, {
    service: 'runtime',
    version: deps.version,
    flags: RUNTIME_ENTRY_FLAGS,
    maxCloseMs: (_flags, values) => runtimeMaxCloseMs(values),
    readStopValues: ({ home, logger }) => createStopValuesReader({ load: () => readUserStopValues(home), onNotice: (message) => logger.warn(message) }).read(),
    ownLockPath: (home, flags) => generationLayout(home, flags.generation).locks.runtime,
    logPath: (home) => momongaPaths(home, process.platform, {}).logFiles.runtime,
    isConfigError: (error) => error instanceof ConfigError,
    start: async ({ version, flags, home, signal, logger, stdout, locks, acquireLock, requestShutdown }) => {
      installOtelErrorHandler((error) => logger.warn('otel.error', { err: error }));
      const tuning: Partial<StartRuntimeProcessOptions> = {
        ...(flags['lease-ms'] === undefined ? {} : { leaseMs: flags['lease-ms'] }),
        ...(flags['worker-count'] === undefined ? {} : { workerCount: flags['worker-count'] }),
        ...(flags['sandbox-exec-path'] === undefined ? {} : { sandboxExecPath: flags['sandbox-exec-path'] }),
      };
      const handle = await startRuntimeProcess({
        home,
        generation: flags.generation,
        version,
        logger,
        stdout,
        signal,
        locks,
        acquireLock,
        requestShutdown: () => requestShutdown(),
        ...tuning,
        ...(deps.bundledRipgrep === undefined ? {} : { bundledRipgrep: deps.bundledRipgrep }),
        ...(deps.ruleSolver === undefined ? {} : { ruleSolver: deps.ruleSolver }),
      });
      return { close: handle.close, abort: handle.abort, fatal: handle.fatal };
    },
  });

export { RIPGREP_MANIFEST_ASSET, ensureBundledRipgrep } from '@momonga/tools';
