import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHILD_ENTRY_FLAGS, DEFAULT_STOP_VALUES, announceReady, generationLayout, momongaPaths, nodeEntryIo, runDaemonEntry } from '@momonga/foundation';
import type { FlagSpec } from '@momonga/foundation';

export const OVERLONG_STDERR_BYTES = 10_000;
export const RAW_STDERR_LINES = [
  '{"fixture":"stderr-json","level":"info"}',
  'plain stderr text',
  'Error: fixture crash',
  '    at fixture (p3b-engine-child.ts:1:1)',
  'x'.repeat(OVERLONG_STDERR_BYTES),
] as const;
export const STRAY_STDOUT_LINE = 'stray stdout line after ready';
export const OWN_LOG_MSG = 'fixture.own_line';

const FIXTURE_FLAGS = { ...CHILD_ENTRY_FLAGS, role: { kind: 'string' } } as const satisfies FlagSpec;

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const role = process.argv.slice(2).includes('--role=gateway') ? 'gateway' : 'runtime';
  const pathsOf = (home: string) => momongaPaths(home, process.platform, {});
  await runDaemonEntry(nodeEntryIo(), {
    service: role,
    version: '0.0.0-e2e',
    flags: FIXTURE_FLAGS,
    maxCloseMs: () => 1000,
    readStopValues: () => DEFAULT_STOP_VALUES,
    ownLockPath: (home, flags) => generationLayout(home, flags.generation).locks[role],
    logPath: (home) => pathsOf(home).logFiles[role],
    isConfigError: () => false,
    start: async (context) => {
      context.logger.info(OWN_LOG_MSG, { data: { role } });
      for (const line of RAW_STDERR_LINES) process.stderr.write(`${line}\n`);
      announceReady(
        { service: role, pid: process.pid, version: context.version, socketPath: generationLayout(context.home, context.flags.generation).sockets[role], startedAt: new Date().toISOString() },
        context.stdout,
      );
      process.stdout.write(`${STRAY_STDOUT_LINE}\n`);
      return { close: async () => ({ clean: true }), abort: async () => ({ clean: true }), fatal: new Promise<Error>(() => undefined) };
    },
  });
}
