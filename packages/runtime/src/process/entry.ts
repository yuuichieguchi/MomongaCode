import { ConfigError } from '@momonga/config';
import { COMMON_ENTRY_FLAGS, RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS, canonicalPath, momongaPaths, runDaemonEntry, runtimeMaxCloseMs } from '@momonga/foundation';
import type { EntryIo, FlagSpec } from '@momonga/foundation';
import { installOtelErrorHandler } from '@momonga/observability';
import { startRuntimeProcess } from './start-runtime-process.ts';
import type { StartRuntimeProcessOptions } from './start-runtime-process.ts';

export const RUNTIME_ENTRY_FLAGS = {
  ...COMMON_ENTRY_FLAGS,
  'lease-ms': { kind: 'int' },
  'drain-timeout-ms': { kind: 'int' },
  'worker-count': { kind: 'int' },
  'sandbox-exec-path': { kind: 'string' },
} as const satisfies FlagSpec;

export const runRuntimeEntry = (io: EntryIo): Promise<number> =>
  runDaemonEntry(io, {
    service: 'runtime',
    flags: RUNTIME_ENTRY_FLAGS,
    maxCloseMs: (flags) => runtimeMaxCloseMs(flags['drain-timeout-ms'] ?? RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS),
    ownLockPath: (home) => momongaPaths(canonicalPath(home), process.platform, {}).locks.runtime,
    logPath: (home) => momongaPaths(canonicalPath(home), process.platform, {}).logFiles.runtime,
    isConfigError: (error) => error instanceof ConfigError,
    start: async ({ flags, home, signal, logger, stdout, acquireLock }) => {
      installOtelErrorHandler((error) => logger.warn('otel.error', { err: error }));
      const tuning: Partial<StartRuntimeProcessOptions> = {
        ...(flags['lease-ms'] === undefined ? {} : { leaseMs: flags['lease-ms'] }),
        ...(flags['drain-timeout-ms'] === undefined ? {} : { drainTimeoutMs: flags['drain-timeout-ms'] }),
        ...(flags['worker-count'] === undefined ? {} : { workerCount: flags['worker-count'] }),
        ...(flags['sandbox-exec-path'] === undefined ? {} : { sandboxExecPath: flags['sandbox-exec-path'] }),
      };
      const handle = await startRuntimeProcess({ home, version: flags['app-version'], logger, stdout, signal, acquireLock, ...tuning });
      return { close: handle.close, abort: handle.abort, fatal: handle.fatal };
    },
  });
