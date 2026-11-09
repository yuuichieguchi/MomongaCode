import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createProcessGroupPort, groupTerminationBoundMs } from '@momonga/foundation';
import { launch } from '../src/process.ts';
import type { LaunchOptions } from '../src/process.ts';
import { pendingOrSettled, silentRunner, virtualTiming } from '../../foundation/test/support/probe-fakes.ts';
import type { RecordedCommand } from '../../foundation/test/support/probe-fakes.ts';

const FAKE_PID = 9_999_991;
const KILL_GRACE_MS = 300;

const neverExitingChild = () => {
  const child = Object.assign(new EventEmitter(), { pid: FAKE_PID, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
  return child;
};

describe('T9 the sandbox abort handler with a Windows group port that never answers', () => {
  it('rejects at the stop bound of the launch, in virtual time, and the PowerShell child is killed', async () => {
    const timing = virtualTiming();
    const calls: RecordedCommand[] = [];
    const groupPort = createProcessGroupPort('win32', { run: silentRunner(calls), env: { SystemRoot: 'C:\\Windows' } } as never);
    const controller = new AbortController();
    const child = neverExitingChild();
    const launched = launch({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: [],
      cwd: 'C:\\work',
      env: {},
      signal: controller.signal,
      killGraceMs: KILL_GRACE_MS,
      afterExit: () => undefined,
      spawnProcess: (() => child) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
      groupPort,
      timing,
    } as LaunchOptions);
    const exited = launched.exited;
    controller.abort();
    const bound = groupTerminationBoundMs(KILL_GRACE_MS);
    await timing.advanceTo(bound - 1);
    expect((await pendingOrSettled(exited)).state).toBe('pending');
    expect(calls.length).toBeGreaterThan(0);
    await timing.advanceTo(bound);
    expect((await pendingOrSettled(exited)).state).toBe('rejected');
    expect(calls.every((call) => call.killed)).toBe(true);
  });
});
