import { ConfigError } from '@momonga/config';
import { COMMON_ENTRY_FLAGS, EntryUsageError, GATEWAY_MAX_CLOSE_MS, canonicalPath, momongaPaths, runDaemonEntry } from '@momonga/foundation';
import type { EntryIo, FlagSpec, SecretStore } from '@momonga/foundation';
import { installOtelErrorHandler } from '@momonga/observability';
import { startGatewayProcess } from './process.ts';

export const GATEWAY_ENTRY_FLAGS = {
  ...COMMON_ENTRY_FLAGS,
  'fm-binary': { kind: 'string' },
  'debug-tcp-port': { kind: 'int' },
  'debug-tcp-token-file': { kind: 'string' },
} as const satisfies FlagSpec;

export type GatewayEntryDeps = { secretStore?: SecretStore };

export const runGatewayEntry = (io: EntryIo, deps: GatewayEntryDeps = {}): Promise<number> =>
  runDaemonEntry(io, {
    service: 'gateway',
    flags: GATEWAY_ENTRY_FLAGS,
    maxCloseMs: () => GATEWAY_MAX_CLOSE_MS,
    ownLockPath: (home) => momongaPaths(canonicalPath(home), process.platform, {}).locks.gateway,
    logPath: (home) => momongaPaths(canonicalPath(home), process.platform, {}).logFiles.gateway,
    isConfigError: (error) => error instanceof ConfigError,
    start: async ({ flags, home, env, signal, logger, stdout }) => {
      installOtelErrorHandler((error) => logger.warn('otel.error', { err: error }));
      const fmBinary = flags['fm-binary'];
      const debugPort = flags['debug-tcp-port'];
      const debugTokenFile = flags['debug-tcp-token-file'];
      if ((debugPort === undefined) !== (debugTokenFile === undefined)) {
        throw new EntryUsageError('--debug-tcp-port and --debug-tcp-token-file must be given together');
      }
      const handle = await startGatewayProcess({
        home: canonicalPath(home),
        env,
        version: flags['app-version'],
        logger,
        stdout,
        signal,
        ...(fmBinary === undefined ? {} : { fmBinary }),
        ...(debugPort === undefined || debugTokenFile === undefined ? {} : { debugTcp: { port: debugPort, tokenFile: debugTokenFile } }),
        ...(deps.secretStore === undefined ? {} : { secretStore: deps.secretStore }),
      });
      return { close: handle.close, abort: handle.abort, fatal: handle.fatal };
    },
  });
