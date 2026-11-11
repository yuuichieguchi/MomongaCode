import fs from 'node:fs';
import path from 'node:path';
import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { daemonStart } from '../src/commands/daemon.ts';
import type { CliPorts } from '../src/ports.ts';
import { createFakeWork, installedProgram, recordingSpawn, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';
import type { FakeSupervisor } from './fake-supervisor.ts';

describe('momonga daemon start', () => {
  it('starts a generation of this version beside an older daemon and stops none (rule 1)', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const work = createFakeWork();
    const started: FakeSupervisor[] = [];
    const start = async (version: string, generation: number): Promise<FakeSupervisor> => {
      const supervisor = await startFakeSupervisor({ paths, version, work, generation, holdsKernelLock: true });
      started.push(supervisor);
      return supervisor;
    };
    registerCleanup(context, async () => {
      await work.settled();
      await Promise.all(started.map((supervisor) => supervisor.stop()));
    });
    fs.writeFileSync(path.join(paths.run, 'generation.counter'), '1');
    const old = await start('1.0.0', 1);
    const { spawn, spawned } = recordingSpawn((spec) => {
      if (spec.args.includes('--generation=2')) void start('2.0.0', 2);
      return undefined;
    });
    const written: string[] = [];
    const ports = {
      version: '2.0.0',
      env: { PATH: '/usr/bin' },
      home,
      clock: virtualClock(work),
      self: { kind: 'single-binary', execPath: '/opt/momonga' },
      spawnDetached: spawn,
      ...installedProgram('2.0.0').ports,
      stdout: { write: (text: string) => void written.push(text) },
    } as unknown as CliPorts;

    const exitCode = await daemonStart(ports, paths).catch((error: unknown) => error);

    expect(old.shutdowns).toBe(0);
    expect(spawned).toEqual([{ command: '/opt/momonga', args: ['__supervise', `--home=${home}`, '--generation=2', '--log-target=file'] }]);
    expect(exitCode).toBe(0);
    expect(written.join('')).toMatch(/^momonga daemon running: pid \d+, version 2\.0\.0\n$/);
  });
});
