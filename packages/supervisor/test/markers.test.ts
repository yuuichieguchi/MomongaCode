import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, isProcessAlive, momongaPaths, scopeToGeneration } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, afterMicrotasks, registerCleanup, spawnTracked, waitFor, withTempDir, firstGeneration } from '@momonga/testkit';
import { openDaemonMarker } from '../src/orphans.ts';
import { errnoError } from './support/p2-fake-spawn-port.ts';
import { createManagerHarness } from './support/p2-manager-harness.ts';
import type { ManagerHarness } from './support/p2-manager-harness.ts';
import { lsofAccess, lsofHolders, lsofNames, pollUntil } from './support/p2-poll.ts';
import { CHILD_FIXTURE } from './support/p2-real-children.ts';
import { trackSupervisorChildren } from './support/track-supervisor-children.ts';
import { trackedSpawnPort } from './support/tracked-spawn-port.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SUPERVISOR_FIXTURE = fileURLToPath(new URL('./fixtures/p2-supervisor-fixture.ts', import.meta.url));
const MARKER_NAME = /^runtime-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const markerPath = (harness: ManagerHarness): string => {
  const names = harness.markers();
  expect(names).toHaveLength(1);
  return path.join(harness.paths.markers.daemons, names[0] as string);
};

const untilReapEnds = (reapEnded: () => boolean): Promise<void> => pollUntil(reapEnded, REAL_PROCESS_TEST_TIMEOUT_MS, 'the reap to end');

const trackUnhandled = (context: Parameters<typeof registerCleanup>[0]): unknown[] => {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', listener);
  registerCleanup(context, () => {
    process.off('unhandledRejection', listener);
  });
  return rejections;
};

const failOpenWith = (failingFlag: string) => {
  const realOpen = fs.openSync;
  return vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode | null) => {
    if (flags === failingFlag) throw errnoError('EMFILE', 'EMFILE: too many open files');
    return realOpen(file, flags, mode);
  }) as typeof fs.openSync);
};

const reportedPid = (harness: ManagerHarness, key: string): number | undefined => {
  for (const line of harness.events('child.stdout')) {
    const match = new RegExp(`"${key}":(\\d+)`).exec(String(line['raw']));
    if (match !== null) return Number(match[1]);
  }
  return undefined;
};

describe('openDaemonMarker', () => {
  it('creates an empty 0600 marker named <role>-<uuidv7> and opens it read-only', async (context) => {
    const dir = withTempDir(context);
    const marker = openDaemonMarker(dir, 'runtime');
    registerCleanup(context, () => marker.closeFd());
    expect(path.dirname(marker.path)).toBe(dir);
    expect(path.basename(marker.path)).toMatch(MARKER_NAME);
    const stat = fs.statSync(marker.path);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.size).toBe(0);
    expect(() => fs.writeSync(marker.fd, 'x')).toThrow(expect.objectContaining({ code: 'EBADF' }));
    marker.remove();
    expect(fs.existsSync(marker.path)).toBe(false);
  });

  it('marker creation failure leaves no marker', async (context) => {
    const dir = withTempDir(context);
    const exclusive = failOpenWith('wx');
    expect(() => openDaemonMarker(dir, 'runtime')).toThrow(expect.objectContaining({ code: 'EMFILE' }));
    expect(fs.readdirSync(dir)).toEqual([]);
    exclusive.mockRestore();
    const reopen = failOpenWith('r');
    expect(() => openDaemonMarker(dir, 'gateway')).toThrow(expect.objectContaining({ code: 'EMFILE' }));
    expect(fs.readdirSync(dir)).toEqual([]);
    reopen.mockRestore();
  });

  it('marker creation failure makes the role back off without calling spawn', async (context) => {
    const harness = await createManagerHarness(context);
    const spy = failOpenWith('wx');
    registerCleanup(context, () => spy.mockRestore());
    await harness.spawnInitial();
    await waitFor(() => harness.manager.state() === 'backoff');
    expect(harness.spawnCount()).toBe(0);
    expect(harness.manager.health().lastExit?.reason).toBe('spawn-failed');
    expect(harness.markers()).toEqual([]);
  });
});

describe('daemon markers at spawn', () => {
  it('marker is created 0600 before spawn and its fd is passed read-only as stdio[4]', async (context) => {
    const harness = await createManagerHarness(context);
    const scratchDir = withTempDir(context);
    const checks: { mode: number; access: string | undefined; writeError: unknown; controlWritten: number; name: string }[] = [];
    harness.port.hook = (_command, _args, options) => {
      const fd = options.stdio[4];
      const name = fs.readdirSync(harness.paths.markers.daemons)[0] as string;
      const mode = fs.statSync(path.join(harness.paths.markers.daemons, name)).mode & 0o777;
      const access = lsofAccess(process.pid, fd);
      let writeError: unknown;
      try {
        fs.writeSync(fd, 'x');
      } catch (error) {
        writeError = error;
      }
      const controlFd = fs.openSync(path.join(scratchDir, 'control'), 'w');
      const controlWritten = fs.writeSync(controlFd, 'x');
      fs.closeSync(controlFd);
      checks.push({ mode, access, writeError, controlWritten, name });
    };
    await harness.spawnInitial();
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toMatch(MARKER_NAME);
    expect(checks[0]?.mode).toBe(0o600);
    expect(checks[0]?.access).toBe('r');
    expect(checks[0]?.writeError).toMatchObject({ code: 'EBADF' });
    expect(checks[0]?.controlWritten).toBe(1);
  });

  it('the supervisor closes its marker fd after spawn', async (context) => {
    const port = trackedSpawnPort(context);
    const harness = await createManagerHarness(context, { port, launcher: () => ({ command: process.execPath, args: [CHILD_FIXTURE] }) });
    await harness.spawnInitial();
    const marker = markerPath(harness);
    const childPid = port.spawned[0]?.pid as number;
    await pollUntil(() => lsofHolders(marker).includes(childPid), 5000, 'child holds the marker');
    expect(lsofHolders(marker)).toEqual([childPid]);
  });

  it('the supervisor process does not retain the marker fd', async (context) => {
    const markerHolders = async (leak: boolean): Promise<{ listed: boolean; errors: string }> => {
      const home = withTempDir(context, { asHome: true });
      const paths = scopeToGeneration(momongaPaths(home, process.platform, {}), FIRST_GENERATION);
      const args = [SUPERVISOR_FIXTURE, `--home=${home}`, `--child=${CHILD_FIXTURE}`, ...(leak ? ['--leak-marker-fd'] : [])];
      const supervisor = spawnTracked(context, process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      trackSupervisorChildren(context, firstGeneration(paths).sockets.supervisor);
      let errors = '';
      supervisor.stderr?.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      let exited = false;
      supervisor.once('exit', () => {
        exited = true;
      });
      const markers = (): string[] => (fs.existsSync(paths.markers.daemons) ? fs.readdirSync(paths.markers.daemons).filter((name) => name.startsWith('runtime-')) : []);
      await pollUntil(() => exited || markers().some((name) => lsofHolders(path.join(paths.markers.daemons, name)).length > 0), 10_000, 'runtime marker held');
      expect(exited, errors).toBe(false);
      const marker = path.join(paths.markers.daemons, markers()[0] as string);
      for (const holder of lsofHolders(marker)) if (holder !== supervisor.pid) registerCleanup(context, () => void (isProcessAlive(holder) && process.kill(holder, 'SIGKILL')));
      return { listed: lsofNames(supervisor.pid).includes(marker), errors };
    };
    expect((await markerHolders(false)).listed).toBe(false);
    expect((await markerHolders(true)).listed).toBe(true);
  });

  it('spawn error removes the marker', async (context) => {
    for (const failure of [
      { kind: 'throw' as const, error: errnoError('ENOENT', 'spawn ENOENT') },
      { kind: 'spawn-error' as const, error: errnoError('ENOENT', 'spawn ENOENT') },
    ]) {
      const harness = await createManagerHarness(context);
      harness.port.nextFailure = failure;
      await harness.spawnInitial();
      await waitFor(() => harness.manager.state() === 'backoff');
      expect(harness.markers()).toEqual([]);
      expect(lsofNames(process.pid).filter((name) => name.startsWith(harness.paths.markers.daemons))).toEqual([]);
    }
  });
});

describe('daemon markers at child exit', () => {
  it('reap failure at child exit is a warning and the role still restarts', async (context) => {
    const rejections = trackUnhandled(context);
    for (const error of [new Error('lsof failed with status 2'), errnoError('ENOENT', 'spawn /usr/sbin/lsof ENOENT')]) {
      const harness = await createManagerHarness(context);
      harness.reapResult = () => Promise.reject(error);
      await harness.spawnInitial();
      const marker = markerPath(harness);
      harness.port.last().exit(1);
      await waitFor(() => harness.manager.state() === 'backoff');
      expect(harness.events('orphans.warning')).toEqual([expect.objectContaining({ level: 'warn', marker })]);
      expect(String(harness.events('orphans.warning')[0]?.['detail'])).toContain(error.message);
      expect(harness.manager.unreapedMarkers()).toEqual([marker]);
      harness.timers.advance(250);
      await waitFor(() => harness.spawnCount() === 2, { description: 'the role to be spawned again' });
    }
    await afterMicrotasks();
    expect(rejections).toEqual([]);
  });

  it('child exit removes the marker', async (context) => {
    const harness = await createManagerHarness(context, { realReap: true });
    await harness.spawnInitial();
    const marker = markerPath(harness);
    harness.port.last().exit(1);
    await untilReapEnds(() => harness.manager.state() === 'backoff');
    expect(fs.existsSync(marker)).toBe(false);
    expect(harness.manager.unreapedMarkers()).toEqual([]);
  });

  it('a leaked holder is killed at child exit', async (context) => {
    const port = trackedSpawnPort(context);
    const harness = await createManagerHarness(context, {
      port,
      realReap: true,
      launcher: () => ({ command: process.execPath, args: [CHILD_FIXTURE, '--p2-grandchild=mapped', '--p2-exit-after-grandchild'] }),
    });
    await harness.spawnInitial();
    const marker = markerPath(harness);
    await pollUntil(() => reportedPid(harness, 'grandchild') !== undefined, 5000, 'grandchild reported');
    const grandchild = reportedPid(harness, 'grandchild') as number;
    port.trackGroup(grandchild);
    await untilReapEnds(() => !isProcessAlive(grandchild) && !fs.existsSync(marker));
  });

  it('a grandchild spawned without explicit mapping does not hold the marker', async (context) => {
    const port = trackedSpawnPort(context);
    const harness = await createManagerHarness(context, { port, launcher: () => ({ command: process.execPath, args: [CHILD_FIXTURE, '--p2-grandchild=default'] }) });
    await harness.spawnInitial();
    const marker = markerPath(harness);
    await pollUntil(() => reportedPid(harness, 'grandchild') !== undefined, 5000, 'grandchild reported');
    const grandchild = reportedPid(harness, 'grandchild') as number;
    port.trackGroup(grandchild);
    const childPid = port.spawned[0]?.pid as number;
    await pollUntil(() => lsofHolders(marker).includes(childPid), 5000, 'child holds the marker');
    expect(isProcessAlive(grandchild)).toBe(true);
    expect(lsofHolders(marker)).toEqual([childPid]);
  });
});
