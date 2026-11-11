import fs from 'node:fs';
import path from 'node:path';
import { STARTUP_TIMEOUT_MS, ensureMomongaDirs, generationLayout, hostKernelLock, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { DaemonStartError, ensureDaemon, stopDaemon } from '../src/daemon/ensure-daemon.ts';
import type { DaemonPorts } from '../src/daemon/ensure-daemon.ts';
import { DAEMON_POLL_INTERVAL_MS } from '../src/constants.ts';
import { PollTimeout } from '../src/poll.ts';
import type { CliClock, SelfExecutable } from '../src/ports.ts';
import { createFakeWork, installedProgram, recordingSpawn, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';
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
  const portsWith = (spawn: DaemonPorts['spawnDetached'], version = VERSION): DaemonPorts => ({ version, env: { PATH: '/usr/bin' }, home, clock: virtualClock(work), self: SELF, spawnDetached: spawn, ...installedProgram(version).ports });
  const counter = path.join(paths.run, 'generation.counter');
  return { home, paths, start, portsWith, counter };
};

const generationArgOf = (spawned: SpawnedProcess): string | undefined => spawned.args.find((arg) => arg.startsWith('--generation='));

const startsAllocated = (start: (options: { version: string; generation: number }) => Promise<FakeSupervisor>) => (spec: SpawnedProcess): undefined => {
  const arg = generationArgOf(spec);
  if (arg !== undefined) void start({ version: VERSION, generation: Number(arg.slice('--generation='.length)) });
  return undefined;
};

const holdLock = async (context: TestContext, lockPath: string): Promise<{ release(): void }> => {
  const outcome = await hostKernelLock().claim(lockPath);
  if (outcome.kind !== 'claimed') throw new Error(`${lockPath} is held`);
  registerCleanup(context, () => outcome.lock.release());
  return { release: () => outcome.lock.release() };
};

const hostClock: CliClock = { now: () => Date.now(), sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

const startRecordOf = (home: string, generation: number): unknown => JSON.parse(fs.readFileSync(generationLayout(home, generation).startRecord, 'utf8'));

const startingLockHeld = (home: string, generation: number): Promise<boolean> => hostKernelLock().isHeld(generationLayout(home, generation).startingLock);

describe('ensureDaemon starts a numbered generation (15.1, 15.3 S1, 15.9)', () => {
  it('allocates generation 1 on a fresh home, passes it to the supervisor, and records the counter and start.json', async (context) => {
    const { home, paths, start, portsWith, counter } = await setup(context);
    const { spawn, spawned } = recordingSpawn(startsAllocated(start));

    const connection = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(spawned).toEqual([{ command: '/opt/node', args: ['/opt/momonga/main.js', '__supervise', `--home=${home}`, '--generation=1', '--log-target=file'] }]);
    expect(connection).toMatchObject({ health: { version: VERSION, generation: 1 }, clientIsOlder: false });
    expect(fs.readFileSync(counter, 'utf8')).toBe('1\n');
    expect(startRecordOf(home, 1)).toEqual({ version: VERSION, foldVersion: FIDELITY_FOLD_VERSION });
    expect(await startingLockHeld(home, 1)).toBe(false);
  });

  it('allocates the number after the counter and is ready only when run/current names that generation', async (context) => {
    const { paths, start, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '3');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { spawn, spawned } = recordingSpawn(startsAllocated((options) => start({ ...options, publishGate: gate })));

    let settled = false;
    const pending = ensureDaemon({ ...portsWith(spawn), clock: hostClock }, paths, { bounds: { readyMs: STARTUP_TIMEOUT_MS, stopMs: STARTUP_TIMEOUT_MS } }).finally(() => {
      settled = true;
    });
    while (!fs.existsSync(generationLayout(path.dirname(paths.root), 4).sockets.supervisor)) await hostClock.sleep(5);
    await hostClock.sleep(4 * DAEMON_POLL_INTERVAL_MS);
    expect(settled).toBe(false);
    expect(fs.existsSync(paths.current)).toBe(false);
    release();
    const connection = await pending;

    expect(spawned.map(generationArgOf)).toEqual(['--generation=4']);
    expect(connection.health).toMatchObject({ version: VERSION, generation: 4 });
    expect(JSON.parse(fs.readFileSync(paths.current, 'utf8'))).toMatchObject({ generation: 4, version: VERSION });
  });

  it('a newer client never stops the older serving generation: it starts the next generation beside it (rule 1)', async (context) => {
    const { paths, start, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '1');
    const old = await start({ version: '0.0.1', generation: 1 });
    const { spawn, spawned } = recordingSpawn(startsAllocated(start));

    const connection = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(old.shutdowns).toBe(0);
    expect(spawned.map(generationArgOf)).toEqual(['--generation=2']);
    expect(connection).toMatchObject({ health: { version: VERSION, generation: 2 }, clientIsOlder: false });
    expect(JSON.parse(fs.readFileSync(paths.current, 'utf8'))).toMatchObject({ generation: 2, version: VERSION });
  });

  it('a second start request during a start joins the starting generation, so one supervisor is spawned (rule 2)', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { spawn, spawned } = recordingSpawn(startsAllocated((options) => start({ ...options, publishGate: gate })));

    const waiting = { bounds: { readyMs: STARTUP_TIMEOUT_MS, stopMs: STARTUP_TIMEOUT_MS } };
    const first = ensureDaemon({ ...portsWith(spawn), clock: hostClock }, paths, waiting);
    const second = ensureDaemon({ ...portsWith(spawn), clock: hostClock }, paths, waiting);
    release();
    const outcomes = await Promise.all([first, second]);

    expect(spawned).toHaveLength(1);
    expect(outcomes.map((outcome) => outcome.health.generation)).toEqual([1, 1]);
  });

  it('refuses a client below the floor of run/current when no generation serves, with the settled text, and starts nothing (15.4 rule 3, 20.30)', async (context) => {
    const { home, paths, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '1');
    await publishCurrentGeneration(paths, { generation: 1, version: '2.0.0', sockets: generationLayout(home, 1).sockets });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toBe(`momonga v${VERSION} is older than the last daemon version v2.0.0; update this program, then run it again.`);
    expect(spawned).toEqual([]);
    expect(fs.readFileSync(counter, 'utf8')).toBe('1');
  });

  it('never falls back to generation 1: it dials the generation it allocated', async (context) => {
    const { home, paths, start, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '5');
    const stale = await start({ version: VERSION, generation: 1, holdsKernelLock: false, publishes: false });
    const { spawn, spawned } = recordingSpawn(startsAllocated(start));

    const connection = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(spawned.map(generationArgOf)).toEqual(['--generation=6']);
    expect(connection.health.generation).toBe(6);
    expect(stale.healthRequests).toBe(0);
    expect(fs.existsSync(generationLayout(home, 6).dir)).toBe(true);
  });

  it('puts the lifeline flag last, after the generation (20.30)', async (context) => {
    const { home, paths, start, portsWith } = await setup(context);
    const { spawn, spawned } = recordingSpawn(startsAllocated(start));

    await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS, lifeline: true });

    expect(spawned).toEqual([{ command: '/opt/node', args: ['/opt/momonga/main.js', '__supervise', `--home=${home}`, '--generation=1', '--log-target=file', '--lifeline-fd=3'], lifeline: true }]);
  });

  it('a superseded starter succeeds through the newer generation of at least its version (S5)', async (context) => {
    const { paths, start, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '1');
    const { spawn } = recordingSpawn((spec) => {
      if (generationArgOf(spec) !== '--generation=2') return undefined;
      return start({ version: '1.2.4', generation: 3 }).then(() => ({ code: 0, signal: null }));
    });

    const connection = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(connection).toMatchObject({ health: { version: '1.2.4', generation: 3 }, clientIsOlder: true });
  });
});

describe('the busy lock and the starting lock (15.14 P7 a, P10)', () => {
  it('retries a busy run/generation.lock at the readiness poll and allocates at the first free claim', async (context) => {
    const { home, paths, start, portsWith, counter } = await setup(context);
    const holder = await holdLock(context, paths.generationLock);
    const { spawn, spawned } = recordingSpawn(startsAllocated(start));
    const ports = portsWith(spawn);
    const sleeps: number[] = [];
    let released = false;
    const clock: CliClock = {
      now: ports.clock.now,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (sleeps.length === 4 && !released) {
          released = true;
          holder.release();
        }
        await ports.clock.sleep(ms, signal);
      },
    };

    const connection = await ensureDaemon({ ...ports, clock }, paths, { bounds: BOUNDS });

    expect(sleeps.slice(0, 4)).toEqual([DAEMON_POLL_INTERVAL_MS, DAEMON_POLL_INTERVAL_MS, DAEMON_POLL_INTERVAL_MS, DAEMON_POLL_INTERVAL_MS]);
    expect(spawned.map(generationArgOf)).toEqual(['--generation=1']);
    expect(connection.health.generation).toBe(1);
    expect(fs.readFileSync(counter, 'utf8')).toBe('1\n');
    expect(fs.existsSync(generationLayout(home, 1).dir)).toBe(true);
  });

  it('ends with the ready-timeout message and writes nothing when the lock stays busy', async (context) => {
    const { paths, portsWith, counter } = await setup(context);
    await holdLock(context, paths.generationLock);
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PollTimeout);
    expect((failure as Error).message).toBe('timed out after 500 ms waiting for the daemon to become ready');
    expect(fs.existsSync(counter)).toBe(false);
    expect(fs.readdirSync(paths.run).filter((name) => /^g\d+$/.test(name))).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it('releases the starting lock at the ready bound when the supervisor never publishes, and keeps the directory', async (context) => {
    const { home, paths, start, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(startsAllocated((options) => start({ ...options, publishes: false })));

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect((failure as Error).message).toBe('timed out after 500 ms waiting for the daemon to become ready');
    expect(await startingLockHeld(home, 1)).toBe(false);
    expect(fs.existsSync(generationLayout(home, 1).dir)).toBe(true);
  });

  it('releases the starting lock when the supervisor exits before it is ready, and reports the exit with the log file', async (context) => {
    const { home, paths, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(async () => ({ code: 78, signal: null }));

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect((failure as Error).message).toBe(`The new daemon (v${VERSION}) did not start (it stopped with exit code 78 before it was ready). The reason is in ${paths.logFiles.supervisor}.`);
    expect(await startingLockHeld(home, 1)).toBe(false);
  });
});

describe('a start that does not happen says why (20.12, 20.14)', () => {
  it('reports the child held by its configuration of the generation it started', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(
      startsAllocated((options) =>
        start({ ...options, children: [{ role: 'gateway', state: 'held-config', restarts: 0, consecutiveFailures: 0, heldReason: 'invalid settings' }, { role: 'runtime', state: 'ready', pid: 102, restarts: 0, consecutiveFailures: 0 }] }),
      ),
    );

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect((failure as Error).message).toBe(`gateway is held by its configuration: invalid settings; see ${paths.logFiles.supervisor}`);
  });

  it('says its files were removed, and that the older daemon keeps running, when its start was abandoned', async (context) => {
    const { home, paths, start, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '1');
    await start({ version: '0.0.1', generation: 1 });
    const { spawn } = recordingSpawn(async () => {
      fs.rmSync(generationLayout(home, 2).dir, { recursive: true });
      return { code: 0, signal: null };
    });

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe(
      `The new daemon (v${VERSION}) did not start (its files were removed while it was starting); v0.0.1 keeps running. Run the command again.`,
    );
  });

  it('says it stopped before it was ready, and where the reason is, when the supervisor claimed the generation and then ended', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(async (spec) => {
      const supervisor = await start({ version: VERSION, generation: Number(generationArgOf(spec)?.slice('--generation='.length)), publishes: false });
      await hostClock.sleep(4 * DAEMON_POLL_INTERVAL_MS);
      await supervisor.stop();
      return { code: 0, signal: null };
    });

    const failure = await ensureDaemon({ ...portsWith(spawn), clock: hostClock }, paths, { bounds: { readyMs: STARTUP_TIMEOUT_MS, stopMs: STARTUP_TIMEOUT_MS } }).catch((error: unknown) => error);

    expect((failure as Error).message).toBe(`The new daemon (v${VERSION}) did not start (it stopped before it was ready). The reason is in ${paths.logFiles.supervisor}.`);
  });

  it('says a daemon of the older version started at the same time when a later generation of a lower version became current', async (context) => {
    const { paths, start, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '1');
    const { spawn } = recordingSpawn((spec) => {
      if (generationArgOf(spec) !== '--generation=2') return undefined;
      return start({ version: '1.2.2', generation: 3 }).then(() => ({ code: 0, signal: null }));
    });

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect((failure as Error).message).toBe(`The new daemon (v${VERSION}) did not start (a daemon of v1.2.2 started at the same time); v1.2.2 keeps running. Run the command again.`);
  });

  it('refuses a start with the settled text when run/current cannot be read (20.15)', async (context) => {
    const { paths, portsWith } = await setup(context);
    fs.writeFileSync(paths.current, '[]');
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe(`momonga cannot read ${paths.current}: it is not an object. No generation was started. Repair or remove the file, then run the command again.`);
    expect(spawned).toEqual([]);
  });
});

describe('the user stop is the only forced stop, and it reaches every live generation (15.7, 20.20)', () => {
  it('sends one shutdown to the serving generation and to a starting one whose supervisor is up, and none to a generation allocated afterwards', async (context) => {
    const { paths, start, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '2');
    const serving = await start({ version: '0.0.1', generation: 1 });
    const starting = await start({ version: VERSION, generation: 2, publishes: false });
    const { spawn } = recordingSpawn(() => undefined);
    const host = hostKernelLock();
    let afterSnapshot: Promise<FakeSupervisor> | undefined;
    const lock: KernelLockMechanism = {
      ...host,
      claim: async (lockPath) => {
        const claim = await host.claim(lockPath);
        if (lockPath !== paths.generationLock || claim.kind !== 'claimed') return claim;
        return {
          kind: 'claimed',
          lock: {
            ...claim.lock,
            release: () => {
              claim.lock.release();
              afterSnapshot ??= start({ version: VERSION, generation: 3, publishes: false });
            },
          },
        };
      },
    };

    const outcome = await stopDaemon(portsWith(spawn), paths, BOUNDS, () => undefined, lock);
    const later = await afterSnapshot;

    expect(outcome).toEqual({ stopped: true });
    expect(serving.shutdowns).toBe(1);
    expect(starting.shutdowns).toBe(1);
    expect(later?.shutdowns).toBe(0);
  });

  it('skips a generation that only a starter holds: nothing listens for it', async (context) => {
    const { home, paths, portsWith, counter } = await setup(context);
    fs.writeFileSync(counter, '1');
    fs.mkdirSync(generationLayout(home, 1).dir, { recursive: true, mode: 0o700 });
    await holdLock(context, generationLayout(home, 1).startingLock);
    const { spawn } = recordingSpawn(() => undefined);

    expect(await stopDaemon(portsWith(spawn), paths, BOUNDS, () => undefined)).toEqual({ stopped: false });
  });

  it('answers stopped false and sends nothing when nothing is live', async (context) => {
    const { paths, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(() => undefined);

    expect(await stopDaemon(portsWith(spawn), paths, BOUNDS, () => undefined)).toEqual({ stopped: false });
  });

  it('waits for the snapshot while run/generation.lock is busy, bounded by the stop bound', async (context) => {
    const { paths, portsWith } = await setup(context);
    await holdLock(context, paths.generationLock);
    const { spawn } = recordingSpawn(() => undefined);

    const failure = await stopDaemon(portsWith(spawn), paths, BOUNDS, () => undefined).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PollTimeout);
    expect((failure as PollTimeout).boundMs).toBe(BOUNDS.stopMs);
  });
});
