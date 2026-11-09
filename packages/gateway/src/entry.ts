import { ConfigError, createStopValuesReader, readUserStopValues } from '@momonga/config';
import type { StopValuesReader } from '@momonga/config';
import { CHILD_ENTRY_FLAGS, EntryUsageError, canonicalPath, gatewayMaxCloseMs, generationLayout, momongaPaths, runDaemonEntry } from '@momonga/foundation';
import type { EntryIo, FlagSpec, JsonLogger, SecretStore } from '@momonga/foundation';
import { installOtelErrorHandler } from '@momonga/observability';
import { startGatewayProcess } from './process.ts';

export const GATEWAY_ENTRY_FLAGS = {
  ...CHILD_ENTRY_FLAGS,
  'fm-binary': { kind: 'string' },
  'debug-tcp-port': { kind: 'int' },
  'debug-tcp-token-file': { kind: 'string' },
} as const satisfies FlagSpec;

export type GatewayEntryDeps = { version: string; secretStore?: SecretStore };

export const runGatewayEntry = (io: EntryIo, deps: GatewayEntryDeps): Promise<number> => {
  let stopValues: StopValuesReader | undefined;
  const stopValuesOf = (home: string, logger: JsonLogger): StopValuesReader => {
    stopValues ??= createStopValuesReader({ load: () => readUserStopValues(canonicalPath(home)), onNotice: (message) => logger.warn(message) });
    return stopValues;
  };
  return runDaemonEntry(io, {
    service: 'gateway',
    version: deps.version,
    flags: GATEWAY_ENTRY_FLAGS,
    maxCloseMs: (_flags, values) => gatewayMaxCloseMs(values),
    readStopValues: ({ home, logger }) => stopValuesOf(home, logger).read(),
    ownLockPath: (home, flags) => generationLayout(canonicalPath(home), flags.generation).locks.gateway,
    logPath: (home) => momongaPaths(canonicalPath(home), process.platform, {}).logFiles.gateway,
    isConfigError: (error) => error instanceof ConfigError,
    start: async ({ version, flags, home, env, signal, logger, stdout, acquireLock }) => {
      installOtelErrorHandler((error) => logger.warn('otel.error', { err: error }));
      const fmBinary = flags['fm-binary'];
      const debugPort = flags['debug-tcp-port'];
      const debugTokenFile = flags['debug-tcp-token-file'];
      if ((debugPort === undefined) !== (debugTokenFile === undefined)) {
        throw new EntryUsageError('--debug-tcp-port and --debug-tcp-token-file must be given together');
      }
      const handle = await startGatewayProcess({
        home: canonicalPath(home),
        generation: flags.generation,
        env,
        version,
        logger,
        stdout,
        signal,
        acquireLock,
        stopValues: stopValuesOf(home, logger),
        ...(fmBinary === undefined ? {} : { fmBinary }),
        ...(debugPort === undefined || debugTokenFile === undefined ? {} : { debugTcp: { port: debugPort, tokenFile: debugTokenFile } }),
        ...(deps.secretStore === undefined ? {} : { secretStore: deps.secretStore }),
      });
      return { close: handle.close, abort: handle.abort, fatal: handle.fatal };
    },
  });
};
