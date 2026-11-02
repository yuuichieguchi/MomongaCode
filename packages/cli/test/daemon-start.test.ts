import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { daemonStart } from '../src/commands/daemon.ts';
import type { CliPorts } from '../src/ports.ts';
import { recordingSpawn, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';
import type { FakeSupervisor } from './fake-supervisor.ts';

describe('momonga daemon start', () => {
  it('drains a daemon of another version and starts one of this version', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const started: FakeSupervisor[] = [];
    const start = async (version: string): Promise<FakeSupervisor> => {
      const supervisor = await startFakeSupervisor({ paths, version });
      started.push(supervisor);
      return supervisor;
    };
    registerCleanup(context, async () => {
      await Promise.all(started.map((supervisor) => supervisor.stop()));
    });
    const old = await start('1.0.0');
    const { spawn, spawned } = recordingSpawn(() => {
      void start('2.0.0');
      return undefined;
    });
    const written: string[] = [];
    const ports = {
      version: '2.0.0',
      env: { PATH: '/usr/bin' },
      home,
      clock: virtualClock(),
      self: { kind: 'single-binary', execPath: '/opt/momonga' },
      spawnDetached: spawn,
      stdout: { write: (text: string) => void written.push(text) },
    } as unknown as CliPorts;

    expect(await daemonStart(ports, paths)).toBe(0);

    expect(old.shutdowns).toBe(1);
    expect(spawned).toEqual([{ command: '/opt/momonga', args: ['__supervise', '--app-version=2.0.0', `--home=${home}`, '--log-target=file'] }]);
    expect(written.join('')).toMatch(/^momonga daemon running: pid \d+, version 2\.0\.0\n$/);
  });
});
