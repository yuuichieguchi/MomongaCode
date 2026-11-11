import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { PollTimeout } from '../src/poll.ts';
import type { CliPorts, SelfExecutable } from '../src/ports.ts';
import { createTuiBackend } from '../src/tui/backend.ts';
import { installedProgram, recordingSpawn, virtualClock } from './fake-supervisor.ts';

const SELF: SelfExecutable = { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' };

describe('the TUI backend', () => {
  it('stops starting the daemon when the interface is closed during boot', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const holder: { backend?: ReturnType<typeof createTuiBackend> } = {};
    const { spawn, spawned } = recordingSpawn(() => {
      void holder.backend?.close();
      return undefined;
    });
    const ports = { version: '1.2.3', env: { PATH: '/usr/bin' }, home, cwd: home, clock: virtualClock(), self: SELF, spawnDetached: spawn, ...installedProgram('1.2.3').ports } as unknown as CliPorts;
    holder.backend = createTuiBackend(ports, paths, {}, { load: async () => [], append: async () => undefined }, []);

    const failure: unknown = await holder.backend.boot().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(spawned).toHaveLength(1);
    expect(failure).toBeDefined();
    expect(failure).not.toBeInstanceOf(PollTimeout);
    expect((failure as Error).name).toBe('AbortError');
  });
});
