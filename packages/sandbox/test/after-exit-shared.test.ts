import { TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ProcessGroupPort } from '@momonga/foundation';
import { launch } from '../src/process.ts';
import type { LaunchOptions } from '../src/process.ts';
import { virtualTiming, settlementOf, driveUntil, driveUntilSettled } from '../../foundation/test/support/probe-fakes.ts';

const FAKE_PID = 9_999_993;
const KILL_GRACE_MS = 300;
const MACROTASK_TURNS = 20;

describe('every end of a launched child waits for the one cleanup after it', () => {
  it('a child that reports an asynchronous error and then exits settles exited only after the cleanup the error began has finished', async () => {
    const timing = virtualTiming();
    const groupPort: ProcessGroupPort = { signal: async () => 'sent' as const, alive: async () => false };
    const cleanup = Promise.withResolvers<void>();
    let cleanups = 0;
    const child = Object.assign(new EventEmitter(), { pid: FAKE_PID, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
    const launched = await launch({
      protection: TEST_CHILD_UNPROTECTED,
      file: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      signal: new AbortController().signal,
      killGraceMs: KILL_GRACE_MS,
      afterExit: () => {
        cleanups += 1;
        return cleanup.promise;
      },
      spawnProcess: (() => child) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
      groupPort,
      timing,
    } as LaunchOptions);
    const exited = settlementOf(launched.exited);
    const failure = new Error('child could not be signalled');
    child.emit('error', failure);
    await driveUntil(timing, () => cleanups === 1, KILL_GRACE_MS, 'the cleanup to begin');
    child.emit('exit', null, 'SIGKILL');
    for (let turn = 0; turn < MACROTASK_TURNS; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exited.current()).toEqual({ state: 'pending' });
    cleanup.resolve();
    await driveUntilSettled(timing, exited, 2 * KILL_GRACE_MS);
    expect(exited.current()).toEqual({ state: 'rejected', reason: failure });
    expect(cleanups).toBe(1);
  });
});
