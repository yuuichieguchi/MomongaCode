import fs from 'node:fs';
import path from 'node:path';
import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import type { DaemonPorts } from '../src/daemon/ensure-daemon.ts';
import type { SelfExecutable } from '../src/ports.ts';
import { createFakeWork, installedProgram, recordingSpawn, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';
import type { FakeSupervisor, FakeSupervisorOptions } from './fake-supervisor.ts';

export const SELF: SelfExecutable = { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' };

export type Sink = { chunks: string[]; write(chunk: string): boolean };

export const sink = (): Sink => {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string) => (chunks.push(chunk), true) };
};

export const setupGenerations = async (context: TestContext, version: string, installedVersion: string | (() => string) = version) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, process.env);
  await ensureMomongaDirs(paths);
  const work = createFakeWork();
  const running: FakeSupervisor[] = [];
  let highest = 0;
  registerCleanup(context, async () => {
    await work.settled();
    await Promise.all(running.map((supervisor) => supervisor.stop()));
  });
  const start = async (options: Omit<FakeSupervisorOptions, 'paths' | 'work'>): Promise<FakeSupervisor> => {
    const supervisor = await startFakeSupervisor({ paths, work, holdsKernelLock: true, ...options });
    running.push(supervisor);
    highest = Math.max(highest, options.generation ?? 1);
    fs.writeFileSync(path.join(paths.run, 'generation.counter'), String(highest));
    return supervisor;
  };
  const spawning = recordingSpawn(() => undefined);
  const installed = installedProgram(() => ({ exitCode: 0, stdout: `${typeof installedVersion === 'string' ? installedVersion : installedVersion()}\n`, stderr: '' }));
  const stdout = sink();
  const stderr = sink();
  const ports: DaemonPorts & { stdout: Sink; stderr: Sink } = { version, env: { PATH: '/usr/bin' }, home, clock: virtualClock(work), self: SELF, spawnDetached: spawning.spawn, ...installed.ports, stdout, stderr };
  return { home, paths, start, ports, spawned: spawning.spawned, asked: installed.asked, stdout, stderr };
};
