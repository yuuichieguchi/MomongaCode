import { ConfigError } from '@momonga/config';
import { COMMON_ENTRY_FLAGS, RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS, canonicalPath, momongaPaths, runDaemonEntry, runtimeMaxCloseMs } from '@momonga/foundation';
import type { EntryIo, FlagSpec } from '@momonga/foundation';
import { installOtelErrorHandler } from '@momonga/observability';
import { startRuntimeProcess } from './start-runtime-process.ts';
import type { BundledRipgrepSource, StartRuntimeProcessOptions } from './start-runtime-process.ts';

export const RUNTIME_ENTRY_FLAGS = {
  ...COMMON_ENTRY_FLAGS,
  'lease-ms': { kind: 'int' },
  'drain-timeout-ms': { kind: 'int' },
  'worker-count': { kind: 'int' },
  'sandbox-exec-path': { kind: 'string' },
} as const satisfies FlagSpec;

export type RuntimeEntryDeps = { version: string; bundledRipgrep?: BundledRipgrepSource };

export const runRuntimeEntry = (io: EntryIo, deps: RuntimeEntryDeps): Promise<number> =>
  runDaemonEntry(io, {
    service: 'runtime',
    version: deps.version,
    flags: RUNTIME_ENTRY_FLAGS,
    maxCloseMs: (flags) => runtimeMaxCloseMs(flags['drain-timeout-ms'] ?? RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS),
    ownLockPath: (home) => momongaPaths(canonicalPath(home), process.platform, {}).locks.runtime,
    logPath: (home) => momongaPaths(canonicalPath(home), process.platform, {}).logFiles.runtime,
    isConfigError: (error) => error instanceof ConfigError,
    start: async ({ version, flags, home, signal, logger, stdout, acquireLock }) => {
      installOtelErrorHandler((error) => logger.warn('otel.error', { err: error }));
      const tuning: Partial<StartRuntimeProcessOptions> = {
        ...(flags['lease-ms'] === undefined ? {} : { leaseMs: flags['lease-ms'] }),
        ...(flags['drain-timeout-ms'] === undefined ? {} : { drainTimeoutMs: flags['drain-timeout-ms'] }),
        ...(flags['worker-count'] === undefined ? {} : { workerCount: flags['worker-count'] }),
        ...(flags['sandbox-exec-path'] === undefined ? {} : { sandboxExecPath: flags['sandbox-exec-path'] }),
      };
      const handle = await startRuntimeProcess({
        home,
        version,
        logger,
        stdout,
        signal,
        acquireLock,
        ...tuning,
        ...(deps.bundledRipgrep === undefined ? {} : { bundledRipgrep: deps.bundledRipgrep }),
      });
      return { close: handle.close, abort: handle.abort, fatal: handle.fatal };
    },
  });

export { RIPGREP_MANIFEST_ASSET, ensureBundledRipgrep } from '@momonga/tools';
