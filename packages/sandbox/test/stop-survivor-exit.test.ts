import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ProcessGroupPort } from '@momonga/foundation';
import { launch } from '../src/process.ts';
import type { LaunchOptions } from '../src/process.ts';
import { pendingOrSettled, virtualTiming } from '../../foundation/test/support/probe-fakes.ts';

const FAKE_PID = 9_999_993;
const KILL_GRACE_MS = 300;

describe('a group member that survives the stop after the leader exits is reported in the exit, not thrown', () => {
  it('exited resolves with the leader exit and groupNotStopped when SIGTERM and SIGKILL leave a runnable member', async () => {
    const timing = virtualTiming();
    const signals: string[] = [];
    const groupPort: ProcessGroupPort = {
      signal: async (_pgid, signal) => void signals.push(signal),
      alive: async () => true,
    };
    const child = Object.assign(new EventEmitter(), { pid: FAKE_PID, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
    const launched = launch({
      file: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      signal: new AbortController().signal,
      killGraceMs: KILL_GRACE_MS,
      afterExit: () => undefined,
      spawnProcess: (() => child) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
      groupPort,
      timing,
    } as LaunchOptions);
    launched.exited.catch(() => undefined);
    child.emit('exit', 0, null);
    await timing.advanceTo(10 * KILL_GRACE_MS);
    const settled = await pendingOrSettled(launched.exited);
    expect(settled).toEqual({ state: 'resolved', value: { code: 0, signal: null, groupNotStopped: true } });
    expect(signals[0]).toBe('SIGTERM');
    expect(signals).toContain('SIGKILL');
  });

  it('exited carries no groupNotStopped when the members stop', async () => {
    const timing = virtualTiming();
    let alive = true;
    const groupPort: ProcessGroupPort = {
      signal: async (_pgid, signal) => {
        if (signal === 'SIGTERM') alive = false;
      },
      alive: async () => alive,
    };
    const child = Object.assign(new EventEmitter(), { pid: FAKE_PID, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
    const launched = launch({
      file: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      signal: new AbortController().signal,
      killGraceMs: KILL_GRACE_MS,
      afterExit: () => undefined,
      spawnProcess: (() => child) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
      groupPort,
      timing,
    } as LaunchOptions);
    launched.exited.catch(() => undefined);
    child.emit('exit', 0, null);
    await timing.advanceTo(10 * KILL_GRACE_MS);
    expect(await pendingOrSettled(launched.exited)).toEqual({ state: 'resolved', value: { code: 0, signal: null } });
  });
});
