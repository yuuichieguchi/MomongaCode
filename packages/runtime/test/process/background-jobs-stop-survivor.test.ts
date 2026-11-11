import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createUninspectableRegistry, systemRandom, nodeFileSystem, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { MarkerState, ProcessGroupPort } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock, createFakeTimers, sleepDrivenTiming, testKernelLock, testProcessInspector } from '@momonga/testkit';
import { createBackgroundJobs, createNodeJobMarkerFiles } from '@momonga/runtime';
import { launch } from '../../../sandbox/src/process.ts';
import type { LaunchOptions } from '../../../sandbox/src/process.ts';
import { virtualTiming } from '../../../foundation/test/support/probe-fakes.ts';
import { jobGenerationOptions } from './job-fixture.ts';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';

const START_MS = 1_800_000_000_000;
const KILL_GRACE_MS = 300;
const GROUP = 999_996;
const STILL_RUNNING = 'At least one process started by it is still running';
const FOUR_OCCASIONS = 'at most once at each of: before the next command that runs a process or changes files, the periodic check, start-up and shutdown';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const runJob = async (survives: boolean) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-jobs-survivor-')));
  roots.push(root);
  const markerDir = path.join(root, 'markers');
  fs.mkdirSync(markerDir);
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const store: RuntimeStore = openRuntimeStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), fileSystem: nodeFileSystem, random: systemRandom, unaskedCommands: UNASKED_COMMANDS, path: path.join(root, 'runtime.db'), home: root, clock, leaseMs: 1000, maxAttempts: 5, maxTotalAttempts: 50 });
  const session = store.createSession({ cwd: root, env: {}, permissionMode: 'manual', model: 'fm' });
  const created = await store.createRunAndEnqueue(session.id, { input: 'go', timeoutMs: 3_600_000, limits: {}, pins: {} });
  if (created.kind !== 'created') throw new Error('expected a run');
  const timing = virtualTiming();
  let alive = true;
  const groupPort: ProcessGroupPort = {
    signal: async () => {
      if (!survives) alive = false;
    },
    alive: async () => alive,
  };
  const markerState: MarkerState = survives ? 'held' : 'free';
  const jobs = createBackgroundJobs({
    inspector: testProcessInspector(),
    store,
    clock,
    timers,
    markerDir,
    ...jobGenerationOptions(root),
    markerFiles: createNodeJobMarkerFiles(),
    files: nodeFileSystem,
    killGraceMs: 10,
    reapTiming: sleepDrivenTiming({ now: () => clock.now(), sleep: async () => undefined }),
    onWarning: () => undefined,
    report: () => undefined,
    uninspectable: createUninspectableRegistry({ isAlive: () => true }),
    groupPort,
    probes: {
      findHolders: async () => [],
      markerState: async () => markerState,
      reapMarkedProcesses: async () => ({ removed: false }),
    },
  } as Parameters<typeof createBackgroundJobs>[0]);
  const { jobId } = await jobs.start({
    runId: created.run.id,
    callKey: 'call-1',
    callId: 'call-1',
    command: 'echo job-output',
    timeoutMs: 60_000,
    spawn: (_marker, signal) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { pid: GROUP, stdout, stderr, stdin: null });
      const launched = launch({
        file: '/bin/bash',
        args: [],
        cwd: '/',
        env: {},
        signal,
        killGraceMs: KILL_GRACE_MS,
        afterExit: () => undefined,
        spawnProcess: (() => child) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
        groupPort,
        timing,
      } as LaunchOptions);
      setImmediate(() => {
        stdout.end('job-output\n');
        stderr.end();
        child.emit('exit', 0, null);
      });
      return launched;
    },
  });
  const finalized = Promise.resolve(jobs.finalized(jobId));
  let done = false;
  void finalized.then(
    () => (done = true),
    () => (done = true),
  );
  for (let step = 1; !done && step <= 1000; step += 1) await timing.advanceTo(step * KILL_GRACE_MS);
  await finalized.catch(() => undefined);
  const read = await jobs.read(created.run.id, jobId, { call: 'read-1' });
  const idemKey = store.jobs.get(jobId)?.idemKey ?? '';
  return { read, markerKept: fs.existsSync(path.join(markerDir, idemKey)) };
};

describe('a background job whose process group keeps a member that survives the stop', () => {
  it('finishes as exited with its exit code and output, tells the reader a process it started is still running, and keeps the marker', async () => {
    const { read, markerKept } = await runJob(true);
    expect(read.job).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(read.output).toContain('job-output');
    expect(read.output).toContain(STILL_RUNNING);
    expect(read.output).toContain(FOUR_OCCASIONS);
    expect(markerKept).toBe(true);
  });

  it('finishes as exited with no note and removes the marker when the members stop', async () => {
    const { read, markerKept } = await runJob(false);
    expect(read.job).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(read.output).toBe('job-output');
    expect(markerKept).toBe(false);
  });
});
