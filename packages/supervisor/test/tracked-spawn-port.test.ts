import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, createUdsClient, generationLayout, isProcessAlive, momongaPaths, fixedSocket } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, killPidsForCleanup, registerCleanup, spawnTracked, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { trackSupervisorChildren } from './support/track-supervisor-children.ts';
import { trackedSpawnPort } from './support/tracked-spawn-port.ts';
import { pollUntil, processGroupOf } from './support/p2-poll.ts';
import { readOnlyScratchFd } from './support/p2-real-children.ts';

const CHILD_FIXTURE = fileURLToPath(new URL('./fixtures/p2-child.ts', import.meta.url));
const SUPERVISOR_FIXTURE = fileURLToPath(new URL('./fixtures/p2-supervisor-fixture.ts', import.meta.url));

type Captured = { context: CleanupContext; run(): Promise<void> };

const capturedContext = (): Captured => {
  const cleanups: (() => unknown)[] = [];
  return {
    context: { onTestFinished: ((cleanup: () => unknown) => void cleanups.push(cleanup)) as CleanupContext['onTestFinished'] },
    run: async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
    },
  };
};

const backstop = (context: CleanupContext, groups: () => number[], pids: () => number[]): void => {
  registerCleanup(context, async () => {
    killPidsForCleanup(pids().filter((pid) => isProcessAlive(pid)));
    await killGroupsForCleanup(groups().filter((pgid) => isProcessAlive(pgid)));
  });
};

const firstGrandchild = (output: () => string): number | undefined => {
  const match = /"grandchild":(\d+)/.exec(output());
  return match === null ? undefined : Number(match[1]);
};

describe('trackedSpawnPort', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('cleanup kills an unfinished child, its group and a registered grandchild', async (context) => {
    const markerFd = readOnlyScratchFd(context);
    const tracked: number[] = [];
    backstop(context, () => tracked, () => tracked);
    const captured = capturedContext();
    const port = trackedSpawnPort(captured.context);
    const inGroup = port(process.execPath, [CHILD_FIXTURE, '--p2-grandchild=group'], {
      cwd: process.cwd(),
      env: { PATH: '/usr/bin:/bin' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', markerFd],
    });
    const ownGroup = port(process.execPath, [CHILD_FIXTURE, '--p2-grandchild=default'], {
      cwd: process.cwd(),
      env: { PATH: '/usr/bin:/bin' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', markerFd],
    });
    let inGroupOutput = '';
    let ownGroupOutput = '';
    inGroup.stdout.on('data', (chunk: Buffer) => {
      inGroupOutput += chunk.toString();
    });
    ownGroup.stdout.on('data', (chunk: Buffer) => {
      ownGroupOutput += chunk.toString();
    });
    await pollUntil(() => firstGrandchild(() => inGroupOutput) !== undefined && firstGrandchild(() => ownGroupOutput) !== undefined, 5000, 'grandchildren reported');
    const groupGrandchild = firstGrandchild(() => inGroupOutput) as number;
    const detachedGrandchild = firstGrandchild(() => ownGroupOutput) as number;
    tracked.push(inGroup.pid as number, ownGroup.pid as number, groupGrandchild, detachedGrandchild);
    expect(port.spawned).toEqual([inGroup, ownGroup]);
    expect(processGroupOf(groupGrandchild)).toBe(inGroup.pid);
    port.trackGroup(detachedGrandchild);
    for (const pid of tracked) expect(isProcessAlive(pid)).toBe(true);
    await captured.run();
    for (const pid of tracked) expect(isProcessAlive(pid), `pid ${pid}`).toBe(false);
  });

  it('cleanup of a child that already exited passes', async (context) => {
    const markerFd = readOnlyScratchFd(context);
    const captured = capturedContext();
    const port = trackedSpawnPort(captured.context);
    const child = port('/bin/sh', ['-c', 'exit 0'], { cwd: process.cwd(), env: {}, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', markerFd] });
    backstop(context, () => [], () => (child.pid === undefined ? [] : [child.pid]));
    const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
    child.stdout.resume();
    child.stderr.resume();
    await exited;
    await expect(captured.run()).resolves.toBeUndefined();
  });
});

describe('trackSupervisorChildren', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('cleanup kills the children of a fixture supervisor that is left running', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const socketPath = generationLayout(home, FIRST_GENERATION).sockets.supervisor;
    const supervisor = spawnTracked(context, process.execPath, [SUPERVISOR_FIXTURE, `--home=${home}`, `--child=${CHILD_FIXTURE}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const captured = capturedContext();
    const tracker = trackSupervisorChildren(captured.context, socketPath);
    const childPids: number[] = [];
    backstop(context, () => childPids, () => childPids);
    let errors = '';
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    supervisor.stdout?.resume();
    let exited = false;
    supervisor.once('exit', () => {
      exited = true;
    });
    const client = createUdsClient(fixedSocket(socketPath));
    registerCleanup(context, () => client.destroy());
    const health = async (): Promise<SupervisorHealth | undefined> => {
      try {
        const response = await client.request({ method: 'GET', path: '/v1/health' });
        return response.status === 200 ? ((await response.json()) as SupervisorHealth) : undefined;
      } catch {
        return undefined;
      }
    };
    let last: SupervisorHealth | undefined;
    await pollUntil(
      async () => {
        if (exited) return true;
        last = await health();
        return last !== undefined && last.children.every((child) => child.pid !== undefined);
      },
      10_000,
      'fixture supervisor reports both child pids',
    );
    expect(exited, errors).toBe(false);
    for (const child of last?.children ?? []) childPids.push(child.pid as number);
    expect(childPids).toHaveLength(2);
    const extra = spawnTracked(context, '/bin/sleep', ['30']);
    childPids.push(extra.pid);
    tracker.record({ ...(last as SupervisorHealth), children: [{ role: 'runtime', state: 'ready', pid: extra.pid, restarts: 0, consecutiveFailures: 0 }] });
    await captured.run();
    for (const pid of childPids) expect(isProcessAlive(pid), `pid ${pid}`).toBe(false);
    expect(isProcessAlive(supervisor.pid)).toBe(true);
  });
});
