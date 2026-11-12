import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createUninspectableRegistry, systemRandom, nodeFileSystem, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { MarkerState, ProcessGroupPort } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock, createFakeTimers, createTempDir, sleepDrivenTiming, TEST_CHILD_UNPROTECTED, testKernelLock, testProcessInspector } from '@momonga/testkit';
import { createBackgroundJobs, createNodeJobMarkerFiles } from '@momonga/runtime';
import { launch } from '../../../sandbox/src/process.ts';
import type { LaunchOptions } from '../../../sandbox/src/process.ts';
import { virtualTiming, driveUntil } from '../../../foundation/test/support/probe-fakes.ts';
import { jobGenerationOptions } from './job-fixture.ts';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';

const START_MS = 1_800_000_000_000;
const KILL_GRACE_MS = 300;
const GROUP = 999_996;
const STILL_RUNNING = 'At least one process started by it is still running';
const NOT_AN_ATTEMPT_RECORD = 'not an attempt record\n';
const FOUR_OCCASIONS = 'at most once at each of: before the next command that runs a process or changes files, the periodic check, start-up and shutdown';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const runJob = async (survives: boolean) => {
  const root = createTempDir();
  roots.push(root);
  const markerDir = path.join(root, 'markers');
  fs.mkdirSync(markerDir);
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const store: RuntimeStore = openRuntimeStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), fileSystem: nodeFileSystem, random: systemRandom, unaskedCommands: UNASKED_COMMANDS, path: path.join(root, 'runtime.db'), home: root, clock, leaseMs: 1000, maxAttempts: 5, maxTotalAttempts: 50 });
  const session = store.createSession({ cwd: root, env: {}, permissionMode: 'manual', model: 'fm' });
  const created = await store.createRunAndEnqueue(session.id, { input: 'go', timeoutMs: 3_600_000, limits: {}, pins: {} });
  if (created.kind !== 'created') throw new Error('expected a run');
  const warnings: string[] = [];
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
    onWarning: (message: string) => void warnings.push(message),
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
    spawn: (marker, signal) => {
      fs.writeFileSync(marker, NOT_AN_ATTEMPT_RECORD);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { pid: GROUP, stdout, stderr, stdin: null });
      const launched = launch({ protection: TEST_CHILD_UNPROTECTED,
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
  await driveUntil(timing, () => done, 1000 * KILL_GRACE_MS, 'the stop to end');
  await finalized.catch(() => undefined);
  const read = await jobs.read(created.run.id, jobId, { call: 'read-1' });
  const idemKey = store.jobs.get(jobId)?.idemKey ?? '';
  const marker = path.join(markerDir, idemKey);
  return { read, warnings, marker, markerKept: fs.existsSync(marker) };
};

describe('a background job whose process group cannot be recorded into its marker', () => {
  it('finishes unknown with its real exit code, since its group was not confirmed stopped, settles the marker with the group held in memory as decision 12 says, and reports the failed record once', async () => {
    const { read, warnings, marker, markerKept } = await runJob(true);
    expect(read.job).toMatchObject({ status: 'unknown', exitCode: 0 });
    expect(read.output).toContain('job-output');
    expect(read.output).toContain(STILL_RUNNING);
    expect(read.output).toContain(FOUR_OCCASIONS);
    expect(markerKept).toBe(true);
    const reports = [read.output, ...warnings].filter((text) => text.includes('holds no attempt record the group can follow'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(marker);
  });

  it('removes the marker and adds no survivor note when the members stop, still reporting the failed record once', async () => {
    const { read, warnings, marker, markerKept } = await runJob(false);
    expect(read.job).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(read.output).toContain('job-output');
    expect(read.output).not.toContain(STILL_RUNNING);
    expect(markerKept).toBe(false);
    const reports = [read.output, ...warnings].filter((text) => text.includes('holds no attempt record the group can follow'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(marker);
  });
});
