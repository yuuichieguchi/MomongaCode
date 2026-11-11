import fs from 'node:fs';
import { ensureMomongaDirs, momongaPaths, readCurrentGeneration } from '@momonga/foundation';
import { firstGeneration, registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { ensureDaemon } from '../src/daemon/ensure-daemon.ts';
import type { DaemonPorts } from '../src/daemon/ensure-daemon.ts';
import type { CliClock, SelfExecutable } from '../src/ports.ts';
import { createFakeWork, installedProgram, recordingSpawn, startFakeSupervisor } from './fake-supervisor.ts';
import type { FakeSupervisor } from './fake-supervisor.ts';

const VERSION = '1.2.3';
const BOUNDS = { readyMs: 600_000, stopMs: 500 };
const SELF: SelfExecutable = { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' };

const yieldOnce = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

describe('ensureDaemon and run/current', () => {
  it('never returns from a start before the started generation has published run/current', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const work = createFakeWork();
    let releasePublish: () => void = () => undefined;
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    let supervisor: FakeSupervisor | undefined;
    registerCleanup(context, async () => {
      releasePublish();
      await work.settled();
      await supervisor?.stop();
    });
    let now = 0;
    let sleptAfterReadyAnswer = false;
    const clock: CliClock = {
      now: () => now,
      sleep: async (ms) => {
        if ((supervisor?.healthRequests ?? 0) >= 1) sleptAfterReadyAnswer = true;
        now += ms;
        await yieldOnce();
      },
    };
    const { spawn } = recordingSpawn(() => {
      void startFakeSupervisor({ paths, work, version: VERSION, publishGate }).then((started) => {
        supervisor = started;
      });
      return undefined;
    });
    const ports: DaemonPorts = { version: VERSION, env: { PATH: '/usr/bin' }, home, clock, self: SELF, spawnDetached: spawn, ...installedProgram(VERSION).ports };

    let returned = false;
    const pending = ensureDaemon(ports, paths, { bounds: BOUNDS }).finally(() => {
      returned = true;
    });
    while (!returned && !sleptAfterReadyAnswer) await yieldOnce();

    expect(fs.existsSync(paths.current)).toBe(false);
    expect(returned).toBe(false);

    releasePublish();
    const connection = await pending;

    expect(connection.health.phase).toBe('running');
    expect(await readCurrentGeneration(paths)).toEqual({ generation: 1, version: VERSION, sockets: firstGeneration(paths).sockets });
  });
});
