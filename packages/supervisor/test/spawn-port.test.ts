import { describe, expect, it, vi } from 'vitest';
import { isProcessAlive } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, afterMicrotasks } from '@momonga/testkit';
import { pollUntil, processGroupOf } from './support/p2-poll.ts';
import { CHILD_FIXTURE, portOptions, readOnlyScratchFd, watch } from './support/p2-real-children.ts';
import { trackedSpawnPort } from './support/tracked-spawn-port.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('real SpawnPort', () => {
  it('spawns a detached child with piped output and a lifeline', async (context) => {
    const markerFd = readOnlyScratchFd(context);
    const port = trackedSpawnPort(context);
    const child = watch(await port(process.execPath, [CHILD_FIXTURE], portOptions(markerFd)));
    const pid = child.handle.pid as number;
    expect(Number.isInteger(pid)).toBe(true);
    expect(child.handle.lifeline).not.toBeNull();
    await pollUntil(() => child.output().includes(`"started":${pid}`), 5000, 'child output');
    expect(processGroupOf(pid)).toBe(pid);
    child.handle.kill('SIGTERM');
    await expect(child.exit).resolves.toEqual({ code: null, signal: 'SIGTERM' });
  });

  it('a missing executable is reported through onSpawnError and never through onExit', async (context) => {
    const markerFd = readOnlyScratchFd(context);
    const port = trackedSpawnPort(context);
    const handle = await port('/nonexistent/momonga-p2-binary', [], portOptions(markerFd));
    expect(handle.pid).toBeUndefined();
    const exits: unknown[] = [];
    handle.onExit((exit) => exits.push(exit));
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => handle.onSpawnError(resolve));
    expect(error.code).toBe('ENOENT');
    await afterMicrotasks();
    expect(exits).toEqual([]);
  });

  it('killGroup kills the child and a grandchild in its group', async (context) => {
    const markerFd = readOnlyScratchFd(context);
    const port = trackedSpawnPort(context);
    const child = watch(await port(process.execPath, [CHILD_FIXTURE, '--p2-ignore-term', '--p2-grandchild=group'], portOptions(markerFd)));
    await pollUntil(() => /"grandchild":\d+/.test(child.output()), 5000, 'grandchild reported');
    const grandchild = Number(/"grandchild":(\d+)/.exec(child.output())?.[1]);
    child.handle.kill('SIGTERM');
    await child.handle.killGroup();
    await expect(child.exit).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    await pollUntil(() => !isProcessAlive(grandchild), 5000, 'grandchild gone');
  });
});
