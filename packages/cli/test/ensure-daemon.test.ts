import { EXIT_VERSION_MISMATCH, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { DaemonStartError, ensureDaemon, probeSupervisor, restoreDaemon, stopDaemon } from '../src/daemon/ensure-daemon.ts';
import type { DaemonPorts } from '../src/daemon/ensure-daemon.ts';
import { createSupervisorClient } from '../src/client/supervisor-client.ts';
import type { SelfExecutable } from '../src/ports.ts';
import { readyChildren, recordingSpawn, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';
import type { FakeSupervisor } from './fake-supervisor.ts';

const VERSION = '1.2.3';
const BOUNDS = { readyMs: 500, stopMs: 500 };
const SELF: SelfExecutable = { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' };

const setup = async (context: TestContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  const running: FakeSupervisor[] = [];
  registerCleanup(context, async () => {
    await Promise.all(running.map((supervisor) => supervisor.stop()));
  });
  const start = async (options: Omit<Parameters<typeof startFakeSupervisor>[0], 'paths'>): Promise<FakeSupervisor> => {
    const supervisor = await startFakeSupervisor({ paths, ...options });
    running.push(supervisor);
    return supervisor;
  };
  const portsWith = (spawn: DaemonPorts['spawnDetached']): DaemonPorts => ({ version: VERSION, env: { PATH: '/usr/bin' }, home, clock: virtualClock(), self: SELF, spawnDetached: spawn });
  return { home, paths, start, portsWith };
};

describe('probeSupervisor', () => {
  it('answers undefined only when nothing listens on the socket', async (context) => {
    const { paths } = await setup(context);
    const client = createSupervisorClient({ socketPath: paths.sockets.supervisor });
    expect(await probeSupervisor(client)).toBeUndefined();
    await client.close();
  });

  it('lets any other failure propagate with its meaning', async (context) => {
    const { paths, start } = await setup(context);
    await start({ version: VERSION });
    const client = createSupervisorClient({ socketPath: paths.sockets.supervisor.replace('supervisor.sock', 'supervisor.sock/x') });
    await expect(probeSupervisor(client)).rejects.toThrow();
    await client.close();
  });
});

describe('ensureDaemon', () => {
  it('does not spawn when a daemon of the same version is ready', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    await start({ version: VERSION });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const health = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(health.version).toBe(VERSION);
    expect(spawned).toEqual([]);
  });

  it('spawns the supervisor detached from this executable with the contract flags and waits for health', async (context) => {
    const { home, paths, start, portsWith } = await setup(context);
    const { spawn, spawned } = recordingSpawn(() => {
      void start({ version: VERSION });
      return undefined;
    });

    const health = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(health.phase).toBe('running');
    expect(spawned).toEqual([{ command: '/opt/node', args: ['/opt/momonga/main.js', '__supervise', `--home=${home}`, '--log-target=file'] }]);
  });

  it('refuses a daemon it started whose binary reports another version than this client, naming both', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(() => {
      void start({ version: '9.0.0' });
      return undefined;
    });

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toContain(`runs version 9.0.0, not ${VERSION}`);
  });

  it('waits for children that are not ready yet', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    await start({ version: VERSION, children: [{ role: 'gateway', state: 'starting', restarts: 0, consecutiveFailures: 0 }, ...readyChildren().slice(1)], phase: 'running' });
    const { spawn } = recordingSpawn(() => undefined);

    await expect(ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS })).rejects.toThrow('timed out after 500 ms waiting for the daemon to become ready');
  });

  it('drains the daemon that is older than this CLI and starts one of this version', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const old = await start({ version: '0.0.1' });
    const { spawn, spawned } = recordingSpawn(() => {
      void start({ version: VERSION });
      return undefined;
    });

    const health = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(old.shutdowns).toBe(1);
    expect(health.version).toBe(VERSION);
    expect(spawned).toHaveLength(1);
  });

  it('replaces an older daemon whose runtime is not ready, because only the direction of the versions decides', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const old = await start({ version: '0.0.1', children: [readyChildren()[0] as ReturnType<typeof readyChildren>[number], { role: 'runtime', state: 'starting', restarts: 1, consecutiveFailures: 0 }] });
    const { spawn } = recordingSpawn(() => {
      void start({ version: VERSION });
      return undefined;
    });

    expect((await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS })).version).toBe(VERSION);
    expect(old.shutdowns).toBe(1);
  });

  it('stops waiting for an older daemon that never answers the shutdown request when the caller aborts', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const controller = new AbortController();
    await start({ version: '0.0.1', unresponsiveShutdown: { onRequest: () => controller.abort(new Error('interrupted')) } });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    await expect(ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS, signal: controller.signal })).rejects.toThrow('interrupted');
    expect(spawned).toEqual([]);
  });

  it('tells a session of the old version that meets a daemon of a newer version that momonga was updated and to reopen the session', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const other = await start({ version: '1.2.4' });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toContain(`momonga was updated to 1.2.4; reopen this session (the daemon, pid ${process.pid}, runs version 1.2.4, not ${VERSION})`);
    expect(other.shutdowns).toBe(0);
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
    const old = await start({ version: '0.0.1' });
    const { spawn } = recordingSpawn(() => {
      void start({ version: VERSION });
      return undefined;
    });

    await restoreDaemon(portsWith(spawn), paths)(undefined);

    expect(old.shutdowns).toBe(1);
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

  it('keeps waiting when the spawned supervisor lost the single-instance race', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(async () => {
      await start({ version: VERSION });
      return { code: 75, signal: null };
    });

    expect((await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS })).version).toBe(VERSION);
  });

  it('reports a version message when the spawned supervisor exits because a component runs another version', async (context) => {
    const { paths, portsWith } = await setup(context);
    const { spawn } = recordingSpawn(async () => ({ code: EXIT_VERSION_MISMATCH, signal: null }));

    const failure = await ensureDaemon(portsWith(spawn), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toContain(`runs another version than this CLI (${VERSION})`);
    expect((failure as DaemonStartError).message).not.toContain('exited (code');
    expect((failure as DaemonStartError).message).toContain(paths.logFiles.supervisor);
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
