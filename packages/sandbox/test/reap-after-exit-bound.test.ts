import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ProcessGroupPort } from '@momonga/foundation';
import { launch } from '../src/process.ts';
import type { LaunchOptions } from '../src/process.ts';
import { pendingOrSettled, virtualTiming } from '../../foundation/test/support/probe-fakes.ts';

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
      },
      alive: async () => followerAlive,
    };
    const child = Object.assign(new EventEmitter(), { pid: FAKE_PID, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
    const controller = new AbortController();
    const launched = launch({
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
    child.emit('exit', 0, null);
    await timing.advanceTo(50);
    controller.abort();
    await timing.advanceTo(2 * KILL_GRACE_MS + 100);
    const settled = await pendingOrSettled(launched.exited);
    expect(settled).toEqual({ state: 'resolved', value: { code: 0, signal: null } });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
