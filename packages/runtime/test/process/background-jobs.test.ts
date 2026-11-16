import { sleep, systemWaitTiming } from '@momonga/foundation';
import { toJobView } from '../../src/service/views.ts';
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
import { JOB_END_PROBE_MS } from '../../src/process/constants.ts';
import { createJobOutput } from '../../src/process/job-output.ts';
import { createLineFilter, createMarkerOwners, unsettledKeys } from '@momonga/tools';
import { jobGenerationOptions } from './job-fixture.ts';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';

const START_MS = 1_800_000_000_000;
const DRAIN_IDLE_MS = 1000;
const CHUNK_GAP_MS = 400;

type FakeStream = AsyncIterable<Uint8Array> & { write(text: string): Promise<void>; end(): void };

const fakeStream = (): FakeStream => {
  const queue: { chunk: Uint8Array; consumed: () => void }[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const poke = (): void => {
    const woken = wake;
    wake = undefined;
    woken?.();
  };
  let handedOut: (() => void) | undefined;
  const releaseHandedOut = (): void => {
    const consumed = handedOut;
    handedOut = undefined;
    consumed?.();
  };
  const next = async (): Promise<IteratorResult<Uint8Array>> => {
    releaseHandedOut();
    for (;;) {
      const item = queue.shift();
      if (item !== undefined) {
        handedOut = item.consumed;
        return { done: false, value: item.chunk };
      }
      if (ended) return { done: true, value: undefined };
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  return {
    [Symbol.asyncIterator]: () => ({
      next,
      return: async () => {
        releaseHandedOut();
        ended = true;
        poke();
        return { done: true, value: undefined };
      },
    }),
    write: (text) =>
      new Promise<void>((resolve) => {
        queue.push({ chunk: Buffer.from(text), consumed: resolve });
        poke();
      }),
    end: () => {
      ended = true;
      poke();
    },
  };
};

type FakeProcess = SandboxedProcess & { stdoutStream: FakeStream; stderrStream: FakeStream; exit(result: SandboxExit): void; exitLeavingStreams(result: SandboxExit): void; signal: AbortSignal };

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
  signal.addEventListener('abort', () => exit({ code: null, signal: 'SIGTERM', killedBy: 'abort', stop: 'confirmed' }), { once: true });
  return { pid: pgid, pgid, rebind: () => undefined, stdout: stdoutStream, stderr: stderrStream, exited, stdoutStream, stderrStream, exit, exitLeavingStreams: (result) => finish(result), signal };
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
      drainIdleMs: DRAIN_IDLE_MS,
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

describe('the job output window', () => {
  it('keeps everything under the cap and reports absolute offsets', async () => {
    const output = createJobOutput(100);
    output.push(Buffer.from('hello '));
    output.push(Buffer.from('world'));
    const window = output.window();
    expect(window.start).toBe(0);
    expect(window.total).toBe(11);
    expect(window.bytes.toString()).toBe('hello world');
  });

  it('drops the oldest bytes beyond the cap without splitting a character', async () => {
    const output = createJobOutput(5);
    output.push(Buffer.from('aaaa'));
    output.push(Buffer.from('é€'));
    const window = output.window();
    expect(window.total).toBe(9);
    expect(window.start + window.bytes.length).toBe(9);
    expect(window.bytes.toString('utf8')).not.toContain('�');
    expect(window.bytes.length).toBeLessThanOrEqual(5);
  });
});

describe('background jobs', () => {
  it('starts a job once per call, records its process and keeps its marker while it runs', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1');
    expect(jobId).toMatch(/^bash_[0-9a-f]{12}$/);
    expect((await t.start('call-1')).jobId).toBe(jobId);
    expect(t.spawned).toHaveLength(1);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'running', pgid: 4000, command: 'sleep 30', sessionId: t.run.sessionId });
    const key = t.store.jobs.get(jobId)?.idemKey ?? '';
    expect(t.store.idempotency.get(key)).toMatchObject({ s: 'PENDING', rec: { pgid: 4000 } });
    expect(fs.existsSync(path.join(t.markerDir, key))).toBe(true);
    expect(t.jobs.liveKeys().has(key)).toBe(true);
    expect(t.jobs.byCall('call-1')).toMatchObject({ id: jobId, status: 'running' });
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
  });

  it('reads new output incrementally while the job runs and from the stored blob afterwards', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1');
    const process = t.spawned[0] as FakeProcess;
    await Promise.all([process.stdoutStream.write('first\n'), process.stderrStream.write('oops\n')]);
    const first = await t.jobs.read(t.run.id, jobId, { call: 'read-1' });
    expect(first.job.status).toBe('running');
    expect(first.output.split('\n').sort()).toEqual(['first', 'oops']);
    await process.stdoutStream.write('second\n');
    expect((await t.jobs.read(t.run.id, jobId, { call: 'read-2' })).output).toBe('second');
    expect((await t.jobs.read(t.run.id, jobId, { call: 'read-3' })).output).toBe('');

    await process.stdoutStream.write('third\nlast\n');
    process.exit({ code: 3, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    const done = await t.jobs.read(t.run.id, jobId, { call: 'read-4' });
    expect(done.job).toMatchObject({ status: 'exited', exitCode: 3 });
    expect(done.output).toBe('third\nlast');
    expect(t.store.jobs.get(jobId)?.outputHandle).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(t.markerDir, t.store.jobs.get(jobId)?.idemKey ?? ''))).toBe(false);
    expect(t.store.idempotency.get(t.store.jobs.get(jobId)?.idemKey ?? '')).toMatchObject({ s: 'COMPLETED' });
    expect(t.jobs.liveKeys().size).toBe(0);
  });

  it('returns the same bytes when a read is replayed by its call after a crash, and new bytes for the next call', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1');
    const process = t.spawned[0] as FakeProcess;
    await process.stdoutStream.write('first\n');
    expect((await t.jobs.read(t.run.id, jobId, { call: 'crashed-call' })).output).toBe('first');
    await process.stdoutStream.write('second\n');

    expect((await t.jobs.read(t.run.id, jobId, { call: 'crashed-call' })).output).toBe('first\nsecond');
    expect((await t.jobs.read(t.run.id, jobId, { call: 'next-call' })).output).toBe('');
    await t.jobs.stopAll();
  });

  it('filters new output by line and discards the lines it drops', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1');
    const process = t.spawned[0] as FakeProcess;
    await process.stdoutStream.write('ok 1\nERROR a\nok 2\nERROR b\n');
    expect((await t.jobs.read(t.run.id, jobId, { call: 'read-5', keep: createLineFilter('ERROR', {}) })).output).toBe('ERROR a\nERROR b');
    expect((await t.jobs.read(t.run.id, jobId, { call: 'read-6' })).output).toBe('');
    process.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
  });

  it('leaves the new output unread when the line filter refuses it', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1');
    const process = t.spawned[0] as FakeProcess;
    await process.stdoutStream.write('ok 1\nERROR a\n');
    const refusing = async (): Promise<readonly string[]> => {
      throw new Error('the pattern is too costly to match');
    };
    await expect(t.jobs.read(t.run.id, jobId, { call: 'read-5', keep: refusing })).rejects.toThrow('the pattern is too costly to match');
    expect((await t.jobs.read(t.run.id, jobId, { call: 'read-6' })).output).toBe('ok 1\nERROR a');
    process.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
  });

  it('kills a running job, records it as stopped and reports how it ended', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1');
    const killed = await t.jobs.kill(t.run.id, jobId);
    expect(killed).toMatchObject({ kill: 'stopped', view: { id: jobId, status: 'killed', signal: 'SIGTERM' } });
    expect(t.spawned[0]?.signal.aborted).toBe(true);
    expect(await t.jobs.kill(t.run.id, jobId)).toMatchObject({ kill: 'stopped', view: { status: 'killed' } });
  });

  it('stops a job at its time limit', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1', 'sleep 30', 5000);
    t.timers.advance(4999);
    expect(t.spawned[0]?.signal.aborted).toBe(false);
    t.timers.advance(1);
    await t.settled(jobId);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'killed', signal: 'SIGTERM' });
  });

  it('stops every live job at shutdown', async () => {
    const t = await setup();
    const first = await t.start('call-1');
    const second = await t.start('call-2');
    await t.jobs.stopAll();
    expect(t.store.jobs.get(first.jobId)?.status).toBe('killed');
    expect(t.store.jobs.get(second.jobId)?.status).toBe('killed');
  });

  it('terminates processes that outlive the job and says so in the output', async () => {
    const t = await setup();
    t.holders.push(777);
    const { jobId } = await t.start('call-1');
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    expect(t.reconciled).toEqual([{ pgid: 4000 }]);
    expect((await t.jobs.read(t.run.id, jobId, { call: 'read-7' })).output).toContain('Terminated 1 process(es) that outlived the job.');
  });

  it('counts only the holders the reap proved and signalled, and names the ones it left alone', async () => {
    const t = await setup({
      reconcileProcessGroup: async () => ({ outcome: 'unknown', output: '', stopped: false, stoppedHolders: [], leftAlonePids: [777], unsignalledPids: [] }),
    });
    t.holders.push(777);
    const { jobId } = await t.start('call-1');
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    const { output } = await t.jobs.read(t.run.id, jobId, { call: 'read-7' });
    expect(output).not.toContain('Terminated');
    expect(output).toContain('Still running but no longer verified as belonging to this call, so left alone: process 777.');
  });

  const reportingSshd = {
    findHolders: async (_marker: string, options: { onUninspectable?: (process: { pid: number; command: string; startedAt: bigint }) => void }): Promise<number[]> => {
      options.onUninspectable?.({ pid: 31_338, command: 'sshd', startedAt: 515151n });
      return [];
    },
  };

  it('names a process that could not be inspected through the warning path, once for each job', async () => {
    const t = await setup(reportingSshd);
    const jobIds: string[] = [];
    for (const key of ['call-1', 'call-2']) {
      const { jobId } = await t.start(key);
      jobIds.push(jobId);
      t.spawned.at(-1)?.exit({ code: 0, signal: null, stop: 'confirmed' });
      await t.settled(jobId);
    }
    expect(t.warnings.filter((message) => message.includes('could not be inspected'))).toEqual(
      jobIds.map((jobId) => `background job ${jobId}: process 31338 (sshd) could not be inspected, so it was left alone`),
    );
  });

  it('finishes a job as unknown, never as exited, when a process could not be inspected, and does not count it as terminated', async () => {
    const t = await setup(reportingSshd);
    const { jobId } = await t.start('call-1');
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'unknown', exitCode: 0 });
    expect(t.reconciled).toEqual([]);
    expect((await t.jobs.read(t.run.id, jobId, { call: 'read-1' })).output).not.toContain('Terminated');
    expect(t.reports).toEqual([]);
  });

  it.each([
    ['looking up the holders of the marker', { findHolders: async () => { throw new Error('lsof is unavailable'); } }, 'lsof is unavailable'],
    ['storing the output', {}, 'the blob store is full'],
  ])('finishes the job as unknown, reports the error and frees its slot when %s fails', async (_label, probes, message) => {
    const t = await setup(probes);
    if (message === 'the blob store is full') {
      t.store.blobs.put = () => {
        throw new Error(message);
      };
    }
    const { jobId } = await t.start('call-1');
    const key = t.store.jobs.get(jobId)?.idemKey ?? '';
    const finalized = t.settled(jobId);
    await t.spawned[0]?.stdoutStream.write('some output\n');
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });

    await expect(finalized).rejects.toThrow(message);

    expect(t.reports).toHaveLength(1);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'unknown' });
    expect(t.store.idempotency.get(key)).toMatchObject({ s: 'COMPLETED' });
    expect(t.store.readRunEvents(t.run.id, 0, 100).filter((event) => event.type === 'job.finished')).toMatchObject([{ jobId, status: 'unknown' }]);
    expect(t.store.jobs.listForSession(t.run.sessionId).filter((job) => job.status === 'running')).toEqual([]);
    expect(t.jobs.liveKeys().size).toBe(0);
    expect(fs.existsSync(path.join(t.markerDir, key))).toBe(message === 'lsof is unavailable');
  });

  it('refuses a job id that belongs to another session tree', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1');
    const other = t.store.createSession({ cwd: t.root, env: {}, permissionMode: 'manual', model: 'fm' });
    const created = await t.store.createRunAndEnqueue(other.id, { input: 'x', timeoutMs: 1000, limits: {}, pins: {} });
    if (created.kind !== 'created') throw new Error('expected a run');
    expect(() => t.jobs.status(created.run.id, jobId)).toThrow(`Unknown job ${jobId}`);
    await expect(t.jobs.kill(created.run.id, jobId)).rejects.toThrow('Unknown job');
    await t.jobs.stopAll();
  });

  it('limits the running jobs of one session', async () => {
    const t = await setup();
    for (let index = 0; index < 8; index += 1) await t.start(`call-${index}`);
    await expect(t.start('call-8')).rejects.toThrow('already has 8 running background jobs');
    await t.jobs.stopAll();
  });

  it('records a job whose process could not be spawned as unknown and passes the error on', async () => {
    const t = await setup();
    await expect(
      t.jobs.start({
        runId: t.run.id,
        callKey: 'call-1',
        callId: 'call-1',
        command: 'x',
        timeoutMs: 1000,
        drainIdleMs: DRAIN_IDLE_MS,
        spawn: () => {
          throw new Error('no such shell');
        },
      }),
    ).rejects.toThrow('no such shell');
    expect(t.store.jobs.byIdemKey(t.store.jobs.listForSession(t.run.sessionId)[0]?.idemKey ?? '')?.status).toBe('unknown');
    expect(fs.readdirSync(t.markerDir)).toEqual([]);
  });

  it('wakes a run that waits on the job when the job ends', async () => {
    const t = await setup();
    const claim = t.store.claim('w1');
    if (claim === null) throw new Error('expected a claim');
    const { jobId } = await t.start('call-1');
    await t.store.release(claim, 'WAITING_TOOL', START_MS + 100_000, { awaits: { runIds: [], jobIds: [jobId] } });
    expect(t.store.getRun(t.run.id)?.status).toBe('WAITING_TOOL');
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    expect(t.store.getRun(t.run.id)?.status).toBe('QUEUED');
  });

  it('reconciles the jobs a dead runtime left running as unknown, once, without guessing an outcome', async () => {
    const t = await setup();
    const { jobs: store } = t.store;
    const started = store.start({ id: 'bash_orphan000000', idemKey: 'k'.repeat(64), sessionId: t.run.sessionId, runId: t.run.id, callId: 'c', command: 'sleep 99' });
    store.attachProcess(started.job.id, 5151);
    t.store.idempotency.begin('k'.repeat(64), { expiresAt: START_MS + 1000, meta: { job: true } });
    expect(store.listForSession(t.run.sessionId).some((job) => job.status === 'running')).toBe(true);
    await t.jobs.reconcileOrphans();
    expect(store.listForSession(t.run.sessionId).some((job) => job.status === 'running')).toBe(false);
    expect(t.reaped).toEqual([{ marker: path.join(t.markerDir, 'k'.repeat(64)), pgid: 5151 }]);
    expect(store.get('bash_orphan000000')).toMatchObject({ status: 'unknown' });
    expect(store.get('bash_orphan000000')?.exitCode).toBeUndefined();
    expect(t.store.idempotency.get('k'.repeat(64))).toMatchObject({ s: 'COMPLETED' });
    const events = t.store.readRunEvents(t.run.id, 0, 50).filter((event) => event.type === 'job.finished');
    expect(events).toMatchObject([{ jobId: 'bash_orphan000000', status: 'unknown' }]);
    await t.jobs.reconcileOrphans();
    expect(t.reaped).toHaveLength(1);
  });
});

describe('a job that is still starting is owned by its starter', () => {
  it('a reconcile that runs between the row insert and the end of the start leaves the job alone, and the start completes', async () => {
    const nodeMarkerFiles = createNodeJobMarkerFiles();
    const hook: { duringStart: () => Promise<void> } = { duringStart: async () => undefined };
    const t = await setup(
      {},
      {
        markerFiles: {
          create: async <T>(marker: string, use: Parameters<typeof nodeMarkerFiles.create<T>>[1]): Promise<T> => {
            await hook.duringStart();
            return nodeMarkerFiles.create(marker, use);
          },
          remove: nodeMarkerFiles.remove,
        },
      },
    );
    const seenDuringStart: (string | undefined)[] = [];
    hook.duringStart = async () => {
      seenDuringStart.push(t.store.jobs.listRunning()[0]?.status);
      await t.jobs.reconcileOrphans();
    };

    const { jobId } = await t.start('call-1');

    expect(seenDuringStart).toEqual(['running']);
    expect(t.reaped).toEqual([]);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'running', pgid: 4000 });
    expect(t.jobs.liveCount()).toBe(1);
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it('a reconcile that runs after the spawn and before the process is attached and registered leaves the job alone, and the job ends with its own result', async () => {
    const nodeMarkerFiles = createNodeJobMarkerFiles();
    const hook: { afterSpawn: () => Promise<void> } = { afterSpawn: async () => undefined };
    const t = await setup(
      {},
      {
        markerFiles: {
          create: async <T>(marker: string, use: Parameters<typeof nodeMarkerFiles.create<T>>[1]): Promise<T> => {
            const spawned = await nodeMarkerFiles.create(marker, use);
            await hook.afterSpawn();
            return spawned;
          },
          remove: nodeMarkerFiles.remove,
        },
      },
    );
    const seenAfterSpawn: { spawned: number; status: string | undefined; live: number }[] = [];
    hook.afterSpawn = async () => {
      await t.jobs.reconcileOrphans();
      seenAfterSpawn.push({ spawned: t.spawned.length, status: t.store.jobs.listRunning()[0]?.status, live: t.jobs.liveCount() });
    };

    const { jobId } = await t.start('call-1');

    expect(seenAfterSpawn).toEqual([{ spawned: 1, status: 'running', live: 0 }]);
    expect(t.reaped).toEqual([]);
    expect(t.reconciled).toEqual([]);
    expect(t.reports).toEqual([]);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'running', pgid: 4000 });
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'exited', exitCode: 0 });
  });
});

describe('the output file of a job follows its row', () => {
  it('a file a crash left with no row does not stop the same call from starting after a restart, and the job does not show the old bytes', async () => {
    const t = await setup();
    const jobId = `bash_${sha256Hex(canonicalJson(['call-1', 'background'])).slice(0, 12)}`;
    const leftover = path.join(t.root, 'jobs', `${jobId}.out`);
    fs.writeFileSync(leftover, 'bytes of the start that crashed\n', { mode: 0o600 });
    expect(t.store.jobs.get(jobId)).toBeUndefined();

    const started = await t.start('call-1');

    expect(started.jobId).toBe(jobId);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'running', outputPath: leftover });
    expect(fs.readFileSync(leftover, 'utf8')).toBe('');
    await t.jobs.stopAll();
  });

  it('a file that a row names is not removed: the start is refused and the file keeps its bytes', async () => {
    const t = await setup();
    const jobId = `bash_${sha256Hex(canonicalJson(['call-1', 'background'])).slice(0, 12)}`;
    const named = path.join(t.root, 'jobs', `${jobId}.out`);
    fs.writeFileSync(named, 'bytes of another job\n', { mode: 0o600 });
    t.store.jobs.start({ id: jobId, idemKey: 'n'.repeat(64), sessionId: t.run.sessionId, runId: t.run.id, callId: 'other', command: 'sleep 99', ownerGeneration: 1, outputPath: named });

    await expect(t.start('call-1')).rejects.toThrow('could not start the background job: its output file could not be created (EEXIST)');

    expect(fs.readFileSync(named, 'utf8')).toBe('bytes of another job\n');
    expect(t.spawned).toEqual([]);
  });
});

describe('the check of the processes at the end of a job has its own bound', () => {
  it('a listing that never answers is ended at the bound: the job ends as unknown with its exit code and output, the marker is kept and nothing is reported as an error', async () => {
    let asked: () => void = () => undefined;
    const listingAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const probeSignals: AbortSignal[] = [];
    const t = await setup({
      findHolders: (_marker, { signal }) => {
        probeSignals.push(signal);
        asked();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const { jobId } = await t.start('call-1');
    const key = t.store.jobs.get(jobId)?.idemKey ?? '';
    await t.spawned[0]?.stdoutStream.write('some output\n');
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await listingAsked;
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'running' });

    t.timers.advance(JOB_END_PROBE_MS - 1);
    expect(probeSignals[0]?.aborted).toBe(false);
    t.timers.advance(1);
    await t.settled(jobId);

    expect(probeSignals[0]?.aborted).toBe(true);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'unknown', exitCode: 0 });
    const read = await t.jobs.read(t.run.id, jobId, { call: 'read-1' });
    expect(read.output).toContain('some output');
    expect(read.output).toContain(`the check of the processes of this job did not end within ${JOB_END_PROBE_MS} ms, so whether one still runs is unknown`);
    expect(fs.existsSync(path.join(t.markerDir, key))).toBe(true);
    expect(t.reports).toEqual([]);
    expect(t.jobs.liveCount()).toBe(0);
  });

  it('the bound is the decided 120 s and no timer of it stays after a job that ended in time', async () => {
    expect(JOB_END_PROBE_MS).toBe(120_000);
    const t = await setup();
    const { jobId } = await t.start('call-1');
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    expect(t.store.jobs.get(jobId)).toMatchObject({ status: 'exited' });
    expect(t.timers.pending().filter((timer) => timer.delayMs === JOB_END_PROBE_MS)).toEqual([]);
  });
});

describe('T16 (a) a live background job owns its marker (PT 3H rule 4: "A marker is owned while a live owner holds it")', () => {
  it('while the job runs its marker is not unsettled and nothing signals it; at its end a held marker becomes unsettled', async () => {
    const owners = createMarkerOwners();
    const t = await setup({}, { owners });
    const { jobId } = await t.start('call-1');
    const key = t.store.jobs.get(jobId)?.idemKey ?? '';
    expect(fs.existsSync(path.join(t.markerDir, key))).toBe(true);
    expect(await unsettledKeys(t.markerDir, owners)).toEqual([]);
    expect(t.reconciled).toEqual([]);
    t.holders.push(5000);
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    expect(await unsettledKeys(t.markerDir, owners)).toEqual([key]);
  });
});


describe('a finished job removes its marker only once the marker reads free', () => {
  const readingState = (state: 'held' | 'free') => {
    const read: string[] = [];
    const probes = {
      findHolders: async () => [],
      markerState: async (marker: string) => {
        read.push(marker);
        return state;
      },
    };
    return { probes, read };
  };

  it('keeps the marker of a job whose marker is still held with nobody named, and leaves it to the next occasion', async () => {
    const owners = createMarkerOwners();
    const { probes, read } = readingState('held');
    const t = await setup(probes, { owners });
    const { jobId } = await t.start('call-1');
    const key = t.store.jobs.get(jobId)?.idemKey ?? '';
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    expect(fs.existsSync(path.join(t.markerDir, key))).toBe(true);
    expect(read).toEqual([path.join(t.markerDir, key)]);
    expect(await unsettledKeys(t.markerDir, owners)).toEqual([key]);
  });

  it('removes the marker of a finished job whose marker reads free', async () => {
    const { probes, read } = readingState('free');
    const t = await setup(probes);
    const { jobId } = await t.start('call-1');
    const key = t.store.jobs.get(jobId)?.idemKey ?? '';
    t.spawned[0]?.exit({ code: 0, signal: null, stop: 'confirmed' });
    await t.settled(jobId);
    expect(read).toEqual([path.join(t.markerDir, key)]);
    expect(fs.existsSync(path.join(t.markerDir, key))).toBe(false);
  });
});

describe('the output of a background job after its command ended is read by the one reader of tools', () => {
  const drainArmed = async (t: Awaited<ReturnType<typeof setup>>): Promise<void> => {
    for (let turn = 0; !t.timers.pending().some((timer) => timer.delayMs === DRAIN_IDLE_MS); turn += 1) {
      if (turn > 10_000) throw new Error('the drain after the exit was never armed');
      await sleep(systemWaitTiming, 0);
    }
  };

  it('keeps reading a writer that outlives the command while a chunk comes within each idle gap', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1');
    const process = t.spawned[0] as FakeProcess;
    process.exitLeavingStreams({ code: 0, signal: null, stop: 'confirmed' });
    await drainArmed(t);
    for (const line of ['one', 'two', 'three', 'four']) {
      t.timers.advance(CHUNK_GAP_MS);
      await process.stdoutStream.write(`${line}\n`);
    }
    process.stdoutStream.end();
    process.stderrStream.end();
    await t.settled(jobId);
    const done = await t.jobs.read(t.run.id, jobId, { call: 'read-1' });
    expect(done.output).toBe('one\ntwo\nthree\nfour');
    const key = t.store.jobs.get(jobId)?.idemKey ?? '';
    expect(t.store.idempotency.get(key)).toMatchObject({ s: 'COMPLETED', result: { job: jobId, status: 'exited' } });
    expect(t.store.idempotency.get(key)).not.toHaveProperty('result.output');
  });

  it('stops reading at the time of the job while a steady writer keeps every idle gap filled, and marks the record incomplete', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1', 'sleep 30', 2000);
    const process = t.spawned[0] as FakeProcess;
    process.exitLeavingStreams({ code: 0, signal: null, stop: 'confirmed' });
    await drainArmed(t);
    for (let line = 0; line < 4; line += 1) {
      t.timers.advance(CHUNK_GAP_MS);
      await process.stdoutStream.write(`line ${line}\n`);
    }
    t.timers.advance(CHUNK_GAP_MS);
    await t.settled(jobId);
    const done = await t.jobs.read(t.run.id, jobId, { call: 'read-1' });
    expect(done.output).toContain('Stopped reading output when the time of the command ran out; output may be incomplete.');
    const key = t.store.jobs.get(jobId)?.idemKey ?? '';
    expect(t.store.idempotency.get(key)).toMatchObject({ s: 'COMPLETED', result: { job: jobId, status: 'exited', output: { incomplete: true } } });
    expect(toJobView(t.store.jobs.get(jobId) ?? expect.fail('the job is recorded'))).toMatchObject({ status: 'exited', outputIncomplete: true });
  });

  it('stops reading after the idle gap, writes the note into the output and marks the record incomplete', async () => {
    const t = await setup();
    const { jobId } = await t.start('call-1');
    const process = t.spawned[0] as FakeProcess;
    await process.stdoutStream.write('started\n');
    process.exitLeavingStreams({ code: 0, signal: null, stop: 'confirmed' });
    await drainArmed(t);
    t.timers.advance(DRAIN_IDLE_MS);
    await t.settled(jobId);
    const done = await t.jobs.read(t.run.id, jobId, { call: 'read-1' });
    expect(done.output).toContain('started');
    expect(done.output).toContain(`Stopped reading output after ${DRAIN_IDLE_MS} ms without data; output may be incomplete.`);
    const key = t.store.jobs.get(jobId)?.idemKey ?? '';
    expect(t.store.idempotency.get(key)).toMatchObject({ s: 'COMPLETED', result: { job: jobId, status: 'exited', output: { incomplete: true } } });
  });
});
