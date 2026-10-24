import path from 'node:path';
import { COMMON_ENTRY_FLAGS, announceReady } from '../../src/index.ts';
import type { DaemonDefinition } from '../../src/index.ts';

const FLAGS = { ...COMMON_ENTRY_FLAGS, 'bulk-bytes': { kind: 'int' } } as const;

export const epipeDaemon: DaemonDefinition<typeof FLAGS> = {
  service: 'runtime',
  flags: FLAGS,
  maxCloseMs: () => 5000,
  ownLockPath: (home) => path.join(home, '.momonga', 'run', 'runtime.lock'),
  logPath: (home) => path.join(home, '.momonga', 'logs', 'runtime.log'),
  isConfigError: () => false,
  start: async ({ flags, logger, stdout }) => {
    announceReady({ service: 'runtime', pid: process.pid, version: flags['app-version'], socketPath: '/nonexistent/runtime.sock', startedAt: new Date().toISOString() }, stdout);
    const close = async (): Promise<{ clean: boolean }> => {
      logger.info('fixture.close.one');
      logger.info('fixture.close.two');
      logger.info('fixture.close.three');
      const bulk = flags['bulk-bytes'] ?? 0;
      const filler = 'z'.repeat(1000);
      for (let written = 0; written < bulk; written += filler.length) logger.info('fixture.bulk', { step: filler });
      return { clean: true };
    };
    return { close, abort: close, fatal: new Promise<Error>(() => undefined) };
  },
};
