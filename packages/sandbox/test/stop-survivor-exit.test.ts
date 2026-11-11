import { TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { groupTerminationBoundMs } from '@momonga/foundation';
import type { ProcessGroupPort, ProcessInspector } from '@momonga/foundation';
import { launch } from '../src/process.ts';
import type { LaunchOptions } from '../src/process.ts';
import { virtualTiming, settlementOf, driveUntilSettled } from '../../foundation/test/support/probe-fakes.ts';

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
    const launched = launch({ protection: TEST_CHILD_UNPROTECTED,
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
    const exited = settlementOf(launched.exited);
    child.emit('exit', 0, null);
    await driveUntilSettled(timing, exited, 2 * groupTerminationBoundMs(KILL_GRACE_MS));
    expect(exited.current()).toEqual({ state: 'resolved', value: { code: 0, signal: null, groupNotStopped: true } });
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
    const launched = launch({ protection: TEST_CHILD_UNPROTECTED,
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
    const exited = settlementOf(launched.exited);
    child.emit('exit', 0, null);
    await driveUntilSettled(timing, exited, 10 * KILL_GRACE_MS);
    expect(exited.current()).toEqual({ state: 'resolved', value: { code: 0, signal: null } });
  });

  it('with a marker whose holder left the group, exited carries no groupNotStopped once the group ended, and the stop asks no holder listing', async () => {
    const timing = virtualTiming();
    let alive = true;
    const groupPort: ProcessGroupPort = {
      signal: async (_pgid, signal) => {
        if (signal === 'SIGTERM') alive = false;
      },
      alive: async () => alive,
    };
    const asked: string[] = [];
    const inspector: ProcessInspector = {
      startTimeOf: async () => {
        asked.push('startTimeOf');
        return { kind: 'value', value: 1n };
      },
      holdersOf: async () => {
        asked.push('holdersOf');
        return { kind: 'value', value: [FAKE_PID + 1] };
      },
      groupsOf: async () => {
        asked.push('groupsOf');
        return { kind: 'value', value: new Map([[FAKE_PID + 1, FAKE_PID + 1]]) };
      },
      markerState: async () => {
        asked.push('markerState');
        return 'held';
      },
    };
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sse-'));
    const markerFile = path.join(markerDir, 'marker');
    fs.writeFileSync(markerFile, `${FAKE_PID}\n`, { mode: 0o600 });
    try {
      const child = Object.assign(new EventEmitter(), { pid: FAKE_PID, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
      const launched = launch({ protection: TEST_CHILD_UNPROTECTED,
        file: '/bin/sh',
        args: [],
        cwd: '/',
        env: {},
        signal: new AbortController().signal,
        killGraceMs: KILL_GRACE_MS,
        afterExit: () => undefined,
        markerFile,
        spawnProcess: (() => child) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
        groupPort,
        timing,
        inspector,
      } as LaunchOptions);
      const exited = settlementOf(launched.exited);
      child.emit('exit', 0, null);
      await driveUntilSettled(timing, exited, 10 * KILL_GRACE_MS);
      expect(exited.current()).toEqual({ state: 'resolved', value: { code: 0, signal: null } });
      expect(asked).toEqual([]);
    } finally {
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  });
});
