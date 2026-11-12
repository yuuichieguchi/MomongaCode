import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, createUninspectableRegistry, nodeFileSystem, nodeFileSystemSync, sha256Hex, systemRandom, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { SandboxExit, SandboxedProcess } from '@momonga/sandbox';
import { openRuntimeStore } from '@momonga/store';
import type { Run, RuntimeStore } from '@momonga/store';
import { createFakeClock, createFakeTimers, createTempDir, sleepDrivenTiming, testKernelLock, testProcessInspector } from '@momonga/testkit';
import { createBackgroundJobs, createNodeJobMarkerFiles } from '@momonga/runtime';
import type { BackgroundJobRegistry } from '@momonga/runtime';
import { MAX_RUNNING_JOBS_PER_SESSION } from '../../src/process/constants.ts';
import { jobGenerationOptions } from './job-fixture.ts';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';

const START_MS = 1_800_000_000_000;

type FakeStream = AsyncIterable<Uint8Array> & { write(text: string): Promise<void>; end(): void };

const fakeStream = (): FakeStream => {
  const queue: { chunk: Uint8Array; consumed: () => void }[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* iterate(): AsyncGenerator<Uint8Array> {
    for (;;) {
      while (queue.length === 0) {
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const item = queue.shift() as (typeof queue)[number];
      yield item.chunk;
      item.consumed();
    }
  }
  return {
    [Symbol.asyncIterator]: iterate,
    write: (text) =>
      new Promise<void>((resolve) => {
        queue.push({ chunk: Buffer.from(text), consumed: resolve });
        wake?.();
      }),
    end: () => {
      ended = true;
      wake?.();
    },
  };
};

type FakeProcess = SandboxedProcess & { stdoutStream: FakeStream; stderrStream: FakeStream; exit(result: SandboxExit): void; signal: AbortSignal };

const fakeProcess = (pgid: number, signal: AbortSignal): FakeProcess => {
  const stdoutStream = fakeStream();
  const stderrStream = fakeStream();
  let finish: (exit: SandboxExit) => void = () => undefined;
  const exited = new Promise<SandboxExit>((resolve) => {
    finish = resolve;
  });
  const exit = (result: SandboxExit): void => {
    stdoutStream.end();
    stderrStream.end();
    finish(result);
  };
  let bound = signal;
  const onAbort = (): void => exit({ code: null, signal: 'SIGTERM', killedBy: 'abort', stop: 'confirmed' });
  signal.addEventListener('abort', onAbort, { once: true });
  const rebind = (next: AbortSignal): void => {
    bound.removeEventListener('abort', onAbort);
    bound = next;
    next.addEventListener('abort', onAbort, { once: true });
    if (next.aborted) onAbort();
  };
  return { pid: pgid, pgid, stdout: stdoutStream, stderr: stderrStream, exited, rebind, stdoutStream, stderrStream, exit, signal };
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const setup = async (probes: Parameters<typeof createBackgroundJobs>[0]['probes'] = {}, extra: Record<string, unknown> = {}) => {
  const root = createTempDir();
  roots.push(root);
  const markerDir = path.join(root, 'markers');
  fs.mkdirSync(markerDir);
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const store: RuntimeStore = openRuntimeStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), fileSystem: nodeFileSystem, fileSystemSync: nodeFileSystemSync, random: systemRandom, unaskedCommands: UNASKED_COMMANDS, path: path.join(root, 'runtime.db'), home: root, clock, leaseMs: 1000, maxAttempts: 5, maxTotalAttempts: 50 });
  const session = store.createSession({ cwd: root, env: {}, permissionMode: 'manual', model: 'fm' });
  const created = await store.createRunAndEnqueue(session.id, { input: 'go', timeoutMs: 3_600_000, limits: {}, pins: {} });
  if (created.kind !== 'created') throw new Error('expected a run');
  const run: Run = created.run;
  const warnings: string[] = [];
  const reports: unknown[] = [];
  const holders: number[] = [];
  const reconciled: { pgid: number }[] = [];
  const reaped: { marker: string; pgid?: number | undefined }[] = [];
  const jobs: BackgroundJobRegistry = createBackgroundJobs({
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
    onWarning: (message) => warnings.push(message),
    report: (error) => reports.push(error),
    uninspectable: createUninspectableRegistry({ isAlive: () => true }),
    probes: {
      findHolders: async () => holders,
      markerState: async () => 'free',
      reconcileProcessGroup: async ({ pgid }) => {
        reconciled.push({ pgid });
        return { outcome: 'unknown', output: '', stopped: holders.length > 0, stoppedHolders: [...holders], leftAlonePids: [], unsignalledPids: [] };
      },
      reapMarkedProcesses: async ({ marker, pgid }) => {
        reaped.push({ marker, pgid });
        return { removed: true };
      },
      ...probes,
    },
    groupPort: { signal: async () => undefined, alive: async () => false },
    ...extra,
  });
  const spawned: FakeProcess[] = [];
  const start = (callKey: string, command = 'sleep 30', timeoutMs = 60_000) =>
    jobs.start({
      runId: run.id,
      callKey,
      callId: callKey,
      command,
      timeoutMs,
      spawn: (marker, signal) => {
        expect(fs.existsSync(marker)).toBe(true);
        const process = fakeProcess(4000 + spawned.length, signal);
        spawned.push(process);
        return process;
      },
    });
  const settled = (jobId: string): Promise<void> => jobs.finalized(jobId);
  return { root, markerDir, clock, timers, store, run, jobs, spawned, start, settled, warnings, reports, holders, reconciled, reaped };
};


const jobKeyOf = (callKey: string): string => sha256Hex(canonicalJson([callKey, 'background']));

const followInto = (process: FakeProcess) => (sink: (chunk: Buffer) => void): Promise<void> =>
  Promise.all(
    [process.stdoutStream, process.stderrStream].map(async (stream) => {
      for await (const chunk of stream) sink(Buffer.from(chunk));
    }),
  ).then(() => undefined);

const promotedCall = async (t: Awaited<ReturnType<typeof setup>>, callKey: string, pgid: number) => {
  const callSignal = new AbortController();
  const process = fakeProcess(pgid, callSignal.signal);
  const marker = path.join(t.markerDir, callKey);
  fs.writeFileSync(marker, '');
  const adopted = await t.jobs.adopt({
    runId: t.run.id,
    callKey,
    callId: callKey,
    command: 'sleep 30',
    timeoutMs: 60_000,
    process,
    marker: { file: marker, mode: 'listed' },
    output: { seen: Buffer.from('first\n'), follow: followInto(process) },
  });
  return { ...adopted, process, callSignal, marker };
};

describe('a running foreground command adopted as a background job', () => {
  it('keeps running under the job, with its marker, its output so far and its output after', async () => {
    const t = await setup();
    const { jobId, process, callSignal, marker } = await promotedCall(t, 'call-1', 4100);
    const key = jobKeyOf('call-1');
    expect(jobId).toBe(`bash_${key.slice(0, 12)}`);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'running', pgid: 4100, command: 'sleep 30' });
    expect(fs.existsSync(path.join(t.markerDir, key))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    expect(t.jobs.liveKeys().has(key)).toBe(true);
    expect(t.jobs.byCall('call-1')).toMatchObject({ id: jobId, status: 'running' });
    callSignal.abort();
    await process.stdoutStream.write('second\n');
    const read = await t.jobs.read(t.run.id, jobId, { call: 'read-1' });
    expect(read.job.status).toBe('running');
    expect(read.output).toBe('first\nsecond');
    const killed = await t.jobs.kill(t.run.id, jobId);
    expect(killed).toMatchObject({ kill: 'stopped', view: { status: 'killed' } });
  });

  it('is refused, and leaves the command to its call, when the session has no free job slot', async () => {
    const t = await setup();
    const busy: string[] = [];
    for (let index = 0; index < MAX_RUNNING_JOBS_PER_SESSION; index += 1) busy.push((await t.start(`busy-${index}`)).jobId);
    const callSignal = new AbortController();
    const process = fakeProcess(4200, callSignal.signal);
    const marker = path.join(t.markerDir, 'call-full');
    fs.writeFileSync(marker, '');
    await expect(
      t.jobs.adopt({ runId: t.run.id, callKey: 'call-full', callId: 'call-full', command: 'sleep 30', timeoutMs: 60_000, process, marker: { file: marker, mode: 'listed' }, output: { seen: Buffer.from(''), follow: followInto(process) } }),
    ).rejects.toThrow(/already has 8 running background jobs/);
    expect(fs.existsSync(marker)).toBe(true);
    expect(t.jobs.byCall('call-full')).toBeUndefined();
    callSignal.abort();
    expect(await process.exited).toMatchObject({ killedBy: 'abort' });
    for (const spawned of t.spawned) spawned.exit({ code: 0, signal: null, stop: 'confirmed' });
    await Promise.all(busy.map((jobId) => t.settled(jobId)));
  });
});
