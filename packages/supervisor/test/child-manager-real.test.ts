import { describe, expect, it, vi } from 'vitest';
import { isProcessAlive } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, afterMicrotasks, registerCleanup } from '@momonga/testkit';
import { errnoError } from './support/p2-fake-spawn-port.ts';
import { createManagerHarness } from './support/p2-manager-harness.ts';
import { pollUntil } from './support/p2-poll.ts';
import { CHILD_FIXTURE, portOptions, readOnlyScratchFd, watch } from './support/p2-real-children.ts';
import { trackedSpawnPort } from './support/tracked-spawn-port.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('child manager with the real SpawnPort', () => {
  it('error event after spawn does not become an uncaught exception', async (context) => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);
    registerCleanup(context, () => {
      process.off('uncaughtException', onUncaught);
    });
    const port = trackedSpawnPort(context);
    const harness = createManagerHarness(context, { port, launcher: () => ({ command: process.execPath, args: [CHILD_FIXTURE, '--p2-watch-lifeline'] }) });
    await harness.spawnInitial();
    await pollUntil(() => harness.events('child.stdout').some((line) => String(line['raw']).includes('started')), 5000, 'fixture started');
    const handle = port.spawned[0];
    const lifeline = handle?.lifeline;
    expect(lifeline).not.toBeNull();
    expect(lifeline?.destroyed).toBe(false);
    lifeline?.destroy(errnoError('EPIPE', 'write EPIPE'));
    await pollUntil(() => harness.events('child.error').length > 0, 5000, 'child.error logged');
    expect(harness.events('child.error')).toEqual([expect.objectContaining({ level: 'warn', child: 'runtime', childPid: handle?.pid })]);
    expect(harness.events('child.error')[0]?.['err']).toMatchObject({ message: 'write EPIPE' });
    await pollUntil(() => harness.manager.state() === 'backoff', 5000, 'exit handled');
    expect(harness.manager.health().lastExit).toMatchObject({ code: 0, signal: null, reason: 'unexpected-clean' });
    await afterMicrotasks();
    expect(uncaught).toEqual([]);
  });

  it('lifelines are not shared between children', async (context) => {
    const markerFd = readOnlyScratchFd(context);
    const port = trackedSpawnPort(context);
    const a = watch(await port(process.execPath, [CHILD_FIXTURE, '--p2-watch-lifeline'], portOptions(markerFd)));
    const b = watch(await port(process.execPath, [CHILD_FIXTURE, '--p2-watch-lifeline'], portOptions(markerFd)));
    await pollUntil(() => a.output().includes('started') && b.output().includes('started'), 5000, 'both watching');
    a.handle.lifeline?.destroy();
    await expect(a.exit).resolves.toEqual({ code: 0, signal: null });
    expect(b.exited()).toBe(false);
    expect(isProcessAlive(b.handle.pid as number)).toBe(true);
    b.handle.lifeline?.destroy();
    await expect(b.exit).resolves.toEqual({ code: 0, signal: null });
  });

  it('a process the supervisor spawns for other purposes holds no lifeline write end', async (context) => {
    const markerFd = readOnlyScratchFd(context);
    const port = trackedSpawnPort(context);
    const watcher = watch(await port(process.execPath, [CHILD_FIXTURE, '--p2-watch-lifeline'], portOptions(markerFd)));
    await pollUntil(() => watcher.output().includes('started'), 5000, 'watcher started');
    const sleeper = watch(await port('/bin/sleep', ['30'], portOptions(markerFd)));
    expect(typeof sleeper.handle.pid).toBe('number');
    watcher.handle.lifeline?.destroy();
    await expect(watcher.exit).resolves.toEqual({ code: 0, signal: null });
    expect(isProcessAlive(sleeper.handle.pid as number)).toBe(true);
  });
});
