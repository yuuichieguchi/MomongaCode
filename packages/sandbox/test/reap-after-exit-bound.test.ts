import { TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ProcessGroupPort } from '@momonga/foundation';
import { launch } from '../src/process.ts';
import type { LaunchOptions } from '../src/process.ts';
import { virtualTiming, settlementOf, driveUntil, driveUntilSettled } from '../../foundation/test/support/probe-fakes.ts';

const FAKE_PID = 9_999_992;
const KILL_GRACE_MS = 300;

describe('the reap after the leader exits is bounded by its own stop bound, not by the call signal', () => {
  it('a call aborted while the reap still waits on a follower does not cut the reap: the follower is killed and exited resolves', async () => {
    const timing = virtualTiming();
    const signals: string[] = [];
    let followerAlive = true;
    const groupPort: ProcessGroupPort = {
      signal: async (_pgid, signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') followerAlive = false;
        return 'sent' as const;
      },
      alive: async () => followerAlive,
    };
    const child = Object.assign(new EventEmitter(), { pid: FAKE_PID, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
    const controller = new AbortController();
    const launched = await launch({ protection: TEST_CHILD_UNPROTECTED,
      file: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      signal: controller.signal,
      killGraceMs: KILL_GRACE_MS,
      afterExit: () => undefined,
      spawnProcess: (() => child) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
      groupPort,
      timing,
    } as LaunchOptions);
    const exited = settlementOf(launched.exited);
    child.emit('exit', 0, null);
    await driveUntil(timing, () => signals.includes('SIGTERM'), KILL_GRACE_MS - 1, 'the reap to signal the follower');
    controller.abort();
    await driveUntilSettled(timing, exited, 2 * KILL_GRACE_MS + 100);
    expect(exited.current()).toEqual({ state: 'resolved', value: { code: 0, signal: null, stop: 'confirmed' } });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
