import { momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { CliPorts } from '../src/ports.ts';
import { DAEMON_STOPPING_TEXT } from '../src/run/follow.ts';
import { watchRun } from '../src/run/headless.ts';
import { virtualClock } from './fake-supervisor.ts';
import { runView } from './fake-backend.ts';

const stoppingTwice = (): RuntimeClient =>
  ({
    streamEvents: async function* (_runId: string, options: { onDaemonStopping?: () => void }) {
      options.onDaemonStopping?.();
      options.onDaemonStopping?.();
      yield* [];
    },
    getRun: async () => runView({ status: 'COMPLETED' }),
  }) as unknown as RuntimeClient;

const portsOf = (stdout: string[], stderr: string[]): CliPorts =>
  ({ version: '1.0.0', clock: virtualClock(), random: () => 0.5, stdout: { write: (text: string) => void stdout.push(text) }, stderr: { write: (text: string) => void stderr.push(text) } }) as unknown as CliPorts;

describe('a daemon stop under a headless run or attach (real-use-30, one rule for every reader)', () => {
  for (const format of ['text', 'json'] as const) {
    it(`says once on standard error that the daemon is stopping (${format})`, async (context) => {
      const paths = momongaPaths(withTempDir(context, { asHome: true }), process.platform, process.env);
      const stdout: string[] = [];
      const stderr: string[] = [];
      await watchRun(portsOf(stdout, stderr), paths, { client: stoppingTwice(), runId: 'run-1', format, verbose: false, interrupt: new AbortController().signal, onInterrupt: 'detach' });
      expect(stderr.join('').split(DAEMON_STOPPING_TEXT)).toHaveLength(2);
      expect(stdout.join('')).not.toContain(DAEMON_STOPPING_TEXT);
    });
  }
});
