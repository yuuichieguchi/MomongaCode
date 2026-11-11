import fs from 'node:fs';
import path from 'node:path';
import { ensureMomongaDirs, fixedSocket, momongaPaths } from '@momonga/foundation';
import { firstGeneration, registerCleanup, withTempDir, testKernelLock } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { DaemonStartError, ensureDaemon, probeSupervisor, restoreDaemon, stopDaemon } from '../src/daemon/ensure-daemon.ts';
import type { DaemonPorts } from '../src/daemon/ensure-daemon.ts';
import { createSupervisorClient } from '../src/client/supervisor-client.ts';
import type { SelfExecutable } from '../src/ports.ts';
import { createFakeWork, readyChildren, recordingSpawn, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';
import type { FakeSupervisor } from './fake-supervisor.ts';

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
    const supervisor = await startFakeSupervisor({ paths, work, ...options });
    running.push(supervisor);
    return supervisor;
  };
  const portsWith = (spawn: DaemonPorts['spawnDetached']): DaemonPorts => ({ version: VERSION, env: { PATH: '/usr/bin' }, home, clock: virtualClock(work), self: SELF, spawnDetached: spawn });
  return { home, paths, start, portsWith };
};

describe('probeSupervisor', () => {
  it('answers undefined only when nothing listens on the socket', async (context) => {
    const { paths } = await setup(context);
    const client = createSupervisorClient({ resolveSocket: fixedSocket(firstGeneration(paths).sockets.supervisor) });
    expect(await probeSupervisor(client)).toBeUndefined();
    await client.close();
  });

  it('lets any other failure propagate with its meaning', async (context) => {
    const { paths, start } = await setup(context);
    await start({ version: VERSION });
    const client = createSupervisorClient({ resolveSocket: fixedSocket(firstGeneration(paths).sockets.supervisor.replace('supervisor.sock', 'supervisor.sock/x')) });
    await expect(probeSupervisor(client)).rejects.toThrow();
    await client.close();
  });
});

describe('ensureDaemon', () => {
  it('does not spawn when a daemon of the same version is ready', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    await start({ version: VERSION });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const connection = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(connection.health.version).toBe(VERSION);
    expect(connection.clientIsOlder).toBe(false);
    expect(spawned).toEqual([]);
  });

  it('spawns the supervisor detached from this executable with the contract flags and waits for health', async (context) => {
    const { home, paths, start, portsWith } = await setup(context);
    const { spawn, spawned } = recordingSpawn(() => {
      void start({ version: VERSION });
      return undefined;
    });

    const connection = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(spawned).toEqual([{ command: '/opt/node', args: ['/opt/momonga/main.js', '__supervise', `--home=${home}`, '--generation=1', '--log-target=file'] }]);
    expect(connection).toMatchObject({ health: { phase: 'running' }, clientIsOlder: false });
  });

  it('takes a daemon it started that reports a higher version as a success, and is then the older client (20.30)', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(() => {
      void start({ version: '9.0.0', startRecordVersion: VERSION });
      return undefined;
    });

    const connection = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(connection).toMatchObject({ health: { version: '9.0.0' }, clientIsOlder: true });
  });

  it('waits for children that are not ready yet', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    await start({ version: VERSION, children: [{ role: 'gateway', state: 'starting', restarts: 0, consecutiveFailures: 0 }, ...readyChildren().slice(1)], phase: 'running' });
    const { spawn } = recordingSpawn(() => undefined);

    await expect(ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS })).rejects.toThrow('timed out after 500 ms waiting for the daemon to become ready');
  });

  it('starts a generation of this version beside the older daemon and never stops it (rule 1)', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    fs.writeFileSync(path.join(paths.run, 'generation.counter'), '1');
    const old = await start({ version: '0.0.1', holdsKernelLock: true });
    const { spawn, spawned } = recordingSpawn((spec) => {
      if (spec.args.includes('--generation=2')) void start({ version: VERSION, generation: 2, holdsKernelLock: true });
      return undefined;
    });

    const connection = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(old.shutdowns).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(connection).toMatchObject({ health: { version: VERSION }, clientIsOlder: false });
  });

  it('starts beside an older daemon whose runtime is not ready, and stops nothing', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    fs.writeFileSync(path.join(paths.run, 'generation.counter'), '1');
    const old = await start({ version: '0.0.1', holdsKernelLock: true, children: [readyChildren()[0] as ReturnType<typeof readyChildren>[number], { role: 'runtime', state: 'starting', restarts: 1, consecutiveFailures: 0 }] });
    const { spawn } = recordingSpawn((spec) => {
      if (spec.args.includes('--generation=2')) void start({ version: VERSION, generation: 2, holdsKernelLock: true });
      return undefined;
    });

    const connection = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(old.shutdowns).toBe(0);
    expect(connection).toMatchObject({ health: { version: VERSION } });
  });

  it('sends no shutdown to an older daemon that would never answer one, and starts beside it', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    fs.writeFileSync(path.join(paths.run, 'generation.counter'), '1');
    let shutdownRequests = 0;
    const controller = new AbortController();
    await start({
      version: '0.0.1',
      holdsKernelLock: true,
      unresponsiveShutdown: {
        onRequest: () => {
          shutdownRequests += 1;
          controller.abort(new Error('a shutdown was sent'));
        },
      },
    });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS, signal: controller.signal }).catch(() => undefined);

    expect(shutdownRequests).toBe(0);
    expect(spawned).toHaveLength(1);
  });

  it('answers a client older than the serving daemon with that daemon and clientIsOlder, starting and stopping nothing (15.4 rule 2)', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const other = await start({ version: '1.2.4' });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const connection = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(connection).toMatchObject({ health: { version: '1.2.4', pid: process.pid }, clientIsOlder: true });
    expect(other.shutdowns).toBe(0);
    expect(spawned).toEqual([]);
  });

  it('tells a restored session of the old version that momonga was updated and to reopen the session (20.69)', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    await start({ version: '1.2.4' });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const failure = await restoreDaemon(portsWith(spawn), paths)(undefined).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toBe('momonga was updated to v1.2.4; reopen this session.');
    expect(spawned).toEqual([]);
  });

  it.for([
    ['a daemon whose version cannot be ordered against this one', 'e2e'],
  ] as const)('never stops or replaces %s, and tells the person to update or restart this CLI', async ([, version], context) => {
    const { paths, start, portsWith } = await setup(context);
    const other = await start({ version });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toContain(`runs version ${version}, not ${VERSION}`);
    expect((failure as DaemonStartError).message).toContain('update or restart this CLI');
    expect((failure as DaemonStartError).message).not.toContain('daemon stop');
    expect(other.shutdowns).toBe(0);
    expect(spawned).toEqual([]);
  });

  it('follows the same rule when the daemon is restored', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    fs.writeFileSync(path.join(paths.run, 'generation.counter'), '1');
    const old = await start({ version: '0.0.1', holdsKernelLock: true });
    const { spawn } = recordingSpawn((spec) => {
      if (spec.args.includes('--generation=2')) void start({ version: VERSION, generation: 2, holdsKernelLock: true });
      return undefined;
    });

    await restoreDaemon(portsWith(spawn), paths)(undefined).catch(() => undefined);

    expect(old.shutdowns).toBe(0);
  });

  it('reports a child held by its configuration instead of waiting for it', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    await start({
      version: VERSION,
      children: [{ role: 'gateway', state: 'held-config', restarts: 0, consecutiveFailures: 0, heldReason: 'invalid settings' }, ...readyChildren().slice(1)],
    });
    const { spawn } = recordingSpawn(() => undefined);

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toContain('gateway is held by its configuration: invalid settings');
    expect((failure as DaemonStartError).message).toContain(paths.logFiles.supervisor);
  });

  it('fails fast with the log path when the spawned supervisor exits before it is ready', async (context) => {
    const { paths, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(async () => ({ code: 78, signal: null }));

    await expect(ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS })).rejects.toThrow(`the supervisor exited (code 78, signal null) before it was ready; see ${paths.logFiles.supervisor}`);
  });

  it('reports an abandoned start when the spawned supervisor exits 0 without ever claiming its generation', async (context) => {
    const { paths, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(async () => ({ code: 0, signal: null }));

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toBe(
      `The new daemon (v${VERSION}) did not start (its start was abandoned before it began: the installed program is another version).; see ${paths.logFiles.supervisor}`,
    );
    expect(await testKernelLock().isHeld(firstGeneration(paths).startingLock)).toBe(false);
  });

  it('surfaces a spawn failure as it is', async (context) => {
    const { paths, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(() => Promise.reject(new Error('spawn ENOENT')));

    await expect(ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS })).rejects.toThrow('spawn ENOENT');
  });
});

describe('stopDaemon', () => {
  it('drains a running daemon and returns once its lock is free', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const supervisor = await start({ version: VERSION });

    expect(await stopDaemon(portsWith(recordingSpawn(() => undefined).spawn), paths, BOUNDS)).toEqual({ stopped: true });
    expect(supervisor.shutdowns).toBe(1);
  });

  it('reports that nothing was running', async (context) => {
    const { paths, portsWith } = await setup(context);

    expect(await stopDaemon(portsWith(recordingSpawn(() => undefined).spawn), paths, BOUNDS)).toEqual({ stopped: false });
  });
});
