import fs from 'node:fs';
import path from 'node:path';
import { ensureMomongaDirs, generationLayout, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { DaemonStartError, ensureDaemon, stopDaemon } from '../src/daemon/ensure-daemon.ts';
import type { DaemonPorts } from '../src/daemon/ensure-daemon.ts';
import type { SelfExecutable } from '../src/ports.ts';
import { createFakeWork, recordingSpawn, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';
import type { FakeSupervisor, SpawnedProcess } from './fake-supervisor.ts';

const VERSION = '1.2.3';
const BOUNDS = { readyMs: 500, stopMs: 500 };
const SELF: SelfExecutable = { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' };

const setup = async (context: TestContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  const work = createFakeWork();
  const running: FakeSupervisor[] = [];
  registerCleanup(context, async () => {
    await work.settled();
    await Promise.all(running.map((supervisor) => supervisor.stop()));
  });
  const start = async (options: Omit<Parameters<typeof startFakeSupervisor>[0], 'paths' | 'work'>): Promise<FakeSupervisor> => {
    const supervisor = await startFakeSupervisor({ paths, work, holdsKernelLock: true, ...options });
    running.push(supervisor);
    return supervisor;
  };
  const portsWith = (spawn: DaemonPorts['spawnDetached'], version = VERSION): DaemonPorts => ({ version, env: { PATH: '/usr/bin' }, home, clock: virtualClock(work), self: SELF, spawnDetached: spawn });
  const counter = path.join(paths.run, 'generation.counter');
  return { home, paths, start, portsWith, counter };
};

const generationArgOf = (spawned: SpawnedProcess): string | undefined => spawned.args.find((arg) => arg.startsWith('--generation='));

const startsAllocated = (start: (options: { version: string; generation: number }) => Promise<FakeSupervisor>) => (spec: SpawnedProcess): undefined => {
  const arg = generationArgOf(spec);
  if (arg !== undefined) void start({ version: VERSION, generation: Number(arg.slice('--generation='.length)) });
  return undefined;
};

describe('ensureDaemon starts a numbered generation (15.1, 15.3 S1, 15.9)', () => {
  it('allocates generation 1 on a fresh home, passes it to the supervisor, and records the counter and start.json', async (context) => {
    const { home, paths, start, portsWith, counter } = await setup(context);
    const { spawn, spawned } = recordingSpawn(startsAllocated(start));

    const health = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(spawned.map(generationArgOf)).toEqual(['--generation=1']);
    expect(health).toMatchObject({ version: VERSION });
    expect(fs.readFileSync(counter, 'utf8').trim()).toBe('1');
    expect(JSON.parse(fs.readFileSync(path.join(generationLayout(home, 1).dir, 'start.json'), 'utf8'))).toEqual({ version: VERSION, foldVersion: FIDELITY_FOLD_VERSION });
  });

  it('allocates the number after the counter and watches that generation until it is current', async (context) => {
    const { paths, start, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '3');
    const { spawn, spawned } = recordingSpawn(startsAllocated(start));

    const health = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(spawned.map(generationArgOf)).toEqual(['--generation=4']);
    expect(health).toMatchObject({ version: VERSION });
    expect(JSON.parse(fs.readFileSync(paths.current, 'utf8'))).toMatchObject({ generation: 4, version: VERSION });
  });

  it('a newer client never stops the older serving generation: it starts the next generation beside it (rule 1)', async (context) => {
    const { paths, start, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '1');
    const old = await start({ version: '0.0.1', generation: 1 });
    const { spawn, spawned } = recordingSpawn(startsAllocated(start));

    const health = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(old.shutdowns).toBe(0);
    expect(spawned.map(generationArgOf)).toEqual(['--generation=2']);
    expect(health).toMatchObject({ version: VERSION });
    expect(JSON.parse(fs.readFileSync(paths.current, 'utf8'))).toMatchObject({ generation: 2, version: VERSION });
  });

  it('a second start request during a start joins the starting generation, so one supervisor is spawned (rule 2)', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { spawn, spawned } = recordingSpawn(startsAllocated((options) => start({ ...options, publishGate: gate })));

    const first = ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });
    const second = ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });
    release();
    const outcomes = await Promise.allSettled([first, second]);

    expect(spawned).toHaveLength(1);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('refuses a client below the floor of run/current when no generation serves, and starts nothing (15.4 rule 3)', async (context) => {
    const { home, paths, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '1');
    await publishCurrentGeneration(paths, { generation: 1, version: '2.0.0', sockets: generationLayout(home, 1).sockets });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toContain('momonga was updated to 2.0.0');
    expect(spawned).toEqual([]);
    expect(fs.readFileSync(counter, 'utf8').trim()).toBe('1');
  });
});

describe('the user stop is the only forced stop, and it reaches every live generation (15.7)', () => {
  it('sends a shutdown to the serving generation and to a starting one', async (context) => {
    const { paths, start, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '2');
    const serving = await start({ version: '0.0.1', generation: 1 });
    const starting = await start({ version: VERSION, generation: 2, publishes: false });
    const { spawn } = recordingSpawn(() => undefined);
    const notices: string[] = [];

    const outcome = await stopDaemon(portsWith(spawn), paths, BOUNDS, (message) => notices.push(message));

    expect(outcome).toEqual({ stopped: true });
    expect(serving.shutdowns).toBe(1);
    expect(starting.shutdowns).toBe(1);
  });
});
