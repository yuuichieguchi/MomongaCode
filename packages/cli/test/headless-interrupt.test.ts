import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { CliPorts } from '../src/ports.ts';
import { EXIT_INTERRUPTED } from '@momonga/foundation';
import { runHeadless, watchRun } from '../src/run/headless.ts';
import { installedProgram, recordingSpawn, virtualClock } from './fake-supervisor.ts';
import { capabilitiesOf, runView } from './fake-backend.ts';

describe('an interrupt that arrives before the run is followed', () => {
  it('starts no daemon and no run when it arrived before the daemon was ensured', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const { spawn, spawned } = recordingSpawn(() => undefined);
    const ports = {
      version: '1.0.0',
      env: { PATH: '/usr/bin' },
      home,
      cwd: home,
      clock: virtualClock(),
      self: { kind: 'single-binary', execPath: '/opt/momonga' },
      spawnDetached: spawn,
      ...installedProgram('1.0.0').ports,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    } as unknown as CliPorts;
    const interrupt = new AbortController();
    interrupt.abort();

    const code = await runHeadless(ports, paths, { prompt: async () => 'hello', format: 'text', verbose: false, interrupt: interrupt.signal, capabilitiesOf: async () => capabilitiesOf(), modelList: async () => ({ data: [], start: null }) });

    expect(code).toBe(EXIT_INTERRUPTED);
    expect(spawned).toEqual([]);
  });

  it('cancels the run at once when it arrived while the run was being created', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    const cancelled: string[] = [];
    const client = {
      cancel: async (runId: string) => {
        cancelled.push(runId);
        return { status: 202, run: runView({ status: 'CANCELLED' }) };
      },
      streamEvents: async function* () {},
      getRun: async () => runView({ status: 'CANCELLED' }),
    } as unknown as RuntimeClient;
    const ports = { clock: virtualClock(), random: () => 0.5, stdout: { write: () => undefined }, stderr: { write: () => undefined } } as unknown as CliPorts;
    const interrupt = new AbortController();
    interrupt.abort();

    const code = await watchRun(ports, paths, { client, runId: 'run-1', format: 'text', verbose: false, interrupt: interrupt.signal, onInterrupt: 'cancel' });

    expect(cancelled).toEqual(['run-1']);
    expect(code).toBe(EXIT_INTERRUPTED);
  });
});
