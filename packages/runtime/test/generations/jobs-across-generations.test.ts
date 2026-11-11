import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, createUninspectableRegistry, fixedRolePort, markerReapClockBoundMs, sha256Hex, systemRandom, nodeFileSystem, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { GenerationRole } from '@momonga/foundation';
import type { SandboxExit, SandboxedProcess } from '@momonga/sandbox';
import { openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock, createFakeTimers, pacedReapTiming, testKernelLock, testProcessInspector } from '@momonga/testkit';
import type { FakeClock, PacedReapTiming } from '@momonga/testkit';
import { RetiringYield, ToolExecutionError } from '@momonga/tools';
import { createBackgroundJobs, createNodeJobMarkerFiles } from '@momonga/runtime';
import type { BackgroundJobRegistry } from '@momonga/runtime';
import { JOB_OUTPUT_FILE_MAX_BYTES, JOB_OUTPUT_WINDOW_BYTES } from '../../src/process/constants.ts';
import { jobKillWaitMs } from '../../src/process/background-jobs.ts';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';

const START_MS = 1_800_000_000_000;
const KILL_GRACE_MS = 1000;

type FakeStream = AsyncIterable<Uint8Array> & { write(chunk: string | Buffer): Promise<void>; end(): void };

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
    write: (chunk) =>
      new Promise<void>((resolve) => {
        queue.push({ chunk: Buffer.from(chunk), consumed: resolve });
        wake?.();
      }),
    end: () => {
      ended = true;
      wake?.();
    },
  };
};

type FakeProcess = SandboxedProcess & { out: FakeStream; exit(result: SandboxExit): void; signal: AbortSignal };

const fakeProcess = (pgid: number, signal: AbortSignal): FakeProcess => {
  const out = fakeStream();
  const err = fakeStream();
  let finish: (exit: SandboxExit) => void = () => undefined;
  const exited = new Promise<SandboxExit>((resolve) => {
    finish = resolve;
  });
  const exit = (result: SandboxExit): void => {
    out.end();
    err.end();
    finish(result);
  };
  signal.addEventListener('abort', () => exit({ code: null, signal: 'SIGTERM', killedBy: 'abort' }), { once: true });
  return { pid: pgid, pgid, stdout: out, stderr: err, exited, out, exit, signal };
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type World = { root: string; clock: FakeClock; reapTiming: PacedReapTiming; store: RuntimeStore; runId: string; sessionId: string; liveOwners: Set<number> };

const world = async (): Promise<World> => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-jobs-gen-')));
  roots.push(root);
  const clock = createFakeClock(START_MS);
  const store = openRuntimeStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), fileSystem: nodeFileSystem, random: systemRandom, unaskedCommands: UNASKED_COMMANDS, path: path.join(root, 'runtime.db'), home: root, clock, leaseMs: 1000, maxAttempts: 5, maxTotalAttempts: 50 });
  const session = store.createSession({ cwd: root, env: {}, permissionMode: 'manual', model: 'fm' });
  const created = await store.createRunAndEnqueue(session.id, { input: 'go', timeoutMs: 3_600_000, limits: {}, pins: {} });
  if (created.kind !== 'created') throw new Error('expected a run');
  return { root, clock, reapTiming: pacedReapTiming(clock), store, runId: created.run.id, sessionId: session.id, liveOwners: new Set() };
};

const jobsDirOf = (root: string, generation: number): string => path.join(root, 'run', `g${generation}`, 'jobs');

const markerDirOf = (root: string, generation: number): string => path.join(root, 'markers', `g${generation}`, 'tools');

type Generation = { jobs: BackgroundJobRegistry; spawned: FakeProcess[]; reaped: { marker: string; pgid?: number | undefined }[]; start(callKey: string): Promise<{ jobId: string }>; settled: { count: number } };

const generationOf = (w: World, generation: number, role: GenerationRole = 'serving'): Generation => {
  fs.mkdirSync(jobsDirOf(w.root, generation), { recursive: true, mode: 0o700 });
  fs.mkdirSync(markerDirOf(w.root, generation), { recursive: true, mode: 0o700 });
  const reaped: Generation['reaped'] = [];
  const settled = { count: 0 };
  const jobs = createBackgroundJobs({
    inspector: testProcessInspector(),
    store: w.store,
    clock: w.clock,
    timers: createFakeTimers(w.clock),
    markerDir: markerDirOf(w.root, generation),
    generation,
    jobsDir: jobsDirOf(w.root, generation),
    role: fixedRolePort(role),
    markerDirOf: (owner) => markerDirOf(w.root, owner),
    ownerAlive: async (owner) => w.liveOwners.has(owner),
    onSettled: () => {
      settled.count += 1;
    },
    markerFiles: createNodeJobMarkerFiles(),
    files: nodeFileSystem,
    killGraceMs: KILL_GRACE_MS,
    reapTiming: w.reapTiming,
    onWarning: () => undefined,
    report: (error) => {
      throw error;
    },
    uninspectable: createUninspectableRegistry({ isAlive: () => true }),
    probes: {
      findHolders: async () => [],
      markerState: async () => 'free',
      reconcileProcessGroup: async () => ({ outcome: 'unknown', output: '', stopped: false, stoppedHolders: [], leftAlonePids: [], unsignalledPids: [] }),
      reapMarkedProcesses: async ({ marker, pgid }) => {
        reaped.push({ marker, pgid });
        return { removed: true };
      },
    },
    groupPort: { signal: async () => undefined, alive: async () => false },
  });
  const spawned: FakeProcess[] = [];
  const start = (callKey: string): Promise<{ jobId: string }> =>
    jobs.start({
      runId: w.runId,
      callKey,
      callId: callKey,
      command: 'sleep 30',
      timeoutMs: 60_000,
      spawn: (_marker, signal) => {
        const created = fakeProcess(4000 + spawned.length, signal);
        spawned.push(created);
        return created;
      },
    });
  return { jobs, spawned, reaped, start, settled };
};

const fileOf = (w: World, generation: number, jobId: string): string => path.join(jobsDirOf(w.root, generation), `${jobId}.out`);

const flushed = async (file: string, bytes: number): Promise<void> => {
  await expect.poll(() => fs.statSync(file).size).toBe(bytes);
};

describe('the owner of a background job (17.3, 20.38)', () => {
  it('records the owner generation, the absolute output path and no kill request, and opens the output file with mode 0600 inside run/g<N>/jobs before the process runs', async () => {
    const w = await world();
    const owner = generationOf(w, 2);

    const { jobId } = await owner.start('call-1');

    const job = w.store.jobs.get(jobId);
    expect(job).toMatchObject({ ownerGeneration: 2, outputPath: fileOf(w, 2, jobId), status: 'running' });
    expect(job).not.toHaveProperty('killRequestedAt');
    expect(path.isAbsolute(job?.outputPath ?? '')).toBe(true);
    expect(fs.statSync(fileOf(w, 2, jobId)).mode & 0o777).toBe(0o600);
    expect(owner.jobs.liveCount()).toBe(1);
    owner.spawned[0]?.exit({ code: 0, signal: null });
    await owner.jobs.finalized(jobId);
    expect(owner.jobs.liveCount()).toBe(0);
    expect(owner.settled.count).toBe(1);
  });

  it('refuses a symbolic link at the output path: the link target is unchanged, no row is written and no process is spawned', async () => {
    const w = await world();
    const owner = generationOf(w, 3);
    const victim = path.join(w.root, 'victim.txt');
    fs.writeFileSync(victim, 'untouched');
    const jobId = `bash_${sha256Hex(canonicalJson(['call-2', 'background'])).slice(0, 12)}`;
    fs.symlinkSync(victim, fileOf(w, 3, jobId));

    const failure = await owner.start('call-2').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ToolExecutionError);
    expect((failure as Error).message).toMatch(/^could not start the background job: its output file could not be created \((ELOOP|EEXIST)\)$/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    expect(w.store.jobs.listForSession(w.sessionId)).toEqual([]);
    expect(owner.spawned).toEqual([]);
  });

  it('a retiring runtime starts no job: the start raises RetiringYield before any row, file or process (20.50)', async () => {
    const w = await world();
    const retiring = generationOf(w, 1, 'retiring');

    await expect(retiring.start('call-1')).rejects.toBeInstanceOf(RetiringYield);

    expect(w.store.jobs.listForSession(w.sessionId)).toEqual([]);
    expect(fs.readdirSync(jobsDirOf(w.root, 1))).toEqual([]);
    expect(retiring.spawned).toEqual([]);
  });

  it('appends every byte of both streams to the file in order, puts the last window in the blob at finish and unlinks the file', async () => {
    const w = await world();
    const owner = generationOf(w, 1);
    const { jobId } = await owner.start('call-1');
    const process = owner.spawned[0] as FakeProcess;

    await process.out.write('one\n');
    await process.out.write('two\n');
    await process.out.write('three\n');
    await flushed(fileOf(w, 1, jobId), 14);
    expect(fs.readFileSync(fileOf(w, 1, jobId), 'utf8')).toBe('one\ntwo\nthree\n');
    process.exit({ code: 0, signal: null });
    await owner.jobs.finalized(jobId);

    expect(fs.existsSync(fileOf(w, 1, jobId))).toBe(false);
    const finished = w.store.jobs.get(jobId);
    expect(finished).toMatchObject({ status: 'exited', outputTotal: 14 });
    const blob = await w.store.blobs.read(finished?.outputHandle ?? '', { offset: 0, length: 14 }, { runId: w.runId });
    expect(blob.text).toBe('one\ntwo\nthree\n');
  });

  it('the file takes at most 64 MiB, a product choice that keeps the disk use of one job finite', () => {
    expect(JOB_OUTPUT_FILE_MAX_BYTES).toBe(8 * JOB_OUTPUT_WINDOW_BYTES);
    expect(JOB_OUTPUT_FILE_MAX_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('BashOutput from another generation (17.3 "Read from any generation")', () => {
  it('returns the same text, omitted count and total as the owner for the same read offset', async () => {
    const w = await world();
    const owner = generationOf(w, 1);
    const reader = generationOf(w, 2);
    w.liveOwners.add(1);
    const { jobId } = await owner.start('call-1');
    const process = owner.spawned[0] as FakeProcess;
    await process.out.write('alpha\n');
    await process.out.write('beta\n');
    await flushed(fileOf(w, 1, jobId), 11);

    const fromOwner = await owner.jobs.read(w.runId, jobId, { call: 'read-owner' });
    w.store.jobs.advanceRead(jobId, 0, 'reset');
    w.store.jobs.advanceRead(jobId, 0, 'reset');
    const fromOther = await reader.jobs.read(w.runId, jobId, { call: 'read-owner' });

    expect(fromOwner.output).toBe('alpha\nbeta');
    expect(fromOther.output).toBe(fromOwner.output);
    await process.out.write('gamma\n');
    await flushed(fileOf(w, 1, jobId), 17);
    expect((await reader.jobs.read(w.runId, jobId, { call: 'read-2' })).output).toBe('gamma');
    expect(w.store.jobs.get(jobId)?.readOffset).toBe(17);
    process.exit({ code: 0, signal: null });
    await owner.jobs.finalized(jobId);
  });

  it('reads the blob of a job whose owner finished between the row read and the file read, and the empty text when the file is gone and the job still runs', async () => {
    const w = await world();
    const owner = generationOf(w, 1);
    const reader = generationOf(w, 2);
    w.liveOwners.add(1);
    const { jobId } = await owner.start('call-1');
    const process = owner.spawned[0] as FakeProcess;
    await process.out.write('kept\n');
    await flushed(fileOf(w, 1, jobId), 5);
    fs.rmSync(fileOf(w, 1, jobId));

    expect((await reader.jobs.read(w.runId, jobId, { call: 'read-1' })).output).toBe('');

    process.exit({ code: 0, signal: null });
    await owner.jobs.finalized(jobId);
    expect((await reader.jobs.read(w.runId, jobId, { call: 'read-2' })).output).toBe('kept');
  });
});

describe('KillBash from another generation (17.3 "Kill", 17.9, 20.39)', () => {
  it('sets the flag once; the owner stops the job at its wake, and the caller reads stopped', async () => {
    const w = await world();
    const owner = generationOf(w, 1);
    const other = generationOf(w, 2);
    w.liveOwners.add(1);
    const { jobId } = await owner.start('call-1');
    const untouched = await owner.start('call-2');
    const originalRequest = w.store.jobs.requestKill;
    w.store.jobs.requestKill = (id) => {
      const set = originalRequest(id);
      owner.jobs.stopKillRequested();
      void w.reapTiming.pairedWith(() => owner.jobs.finalized(id));
      return set;
    };

    const killed = await other.jobs.kill(w.runId, jobId);

    expect(killed).toMatchObject({ kill: 'stopped', view: { id: jobId, status: 'killed' } });
    expect(w.store.jobs.get(jobId)?.killRequestedAt).toBe(START_MS);
    expect(owner.spawned[0]?.signal.aborted).toBe(true);
    expect(owner.spawned[1]?.signal.aborted).toBe(false);
    expect(w.store.jobs.get(untouched.jobId)?.status).toBe('running');
    owner.spawned[1]?.exit({ code: 0, signal: null });
    await owner.jobs.finalized(untouched.jobId);
  });

  it('returns requested with the stored running view when the owner has not stopped the job within the bound of 17.9', async () => {
    const w = await world();
    const owner = generationOf(w, 1);
    const other = generationOf(w, 2);
    w.liveOwners.add(1);
    const { jobId } = await owner.start('call-1');

    const killed = await other.jobs.kill(w.runId, jobId);

    expect(jobKillWaitMs(KILL_GRACE_MS)).toBe(markerReapClockBoundMs(KILL_GRACE_MS) + 1000);
    expect(killed).toMatchObject({ kill: 'requested', view: { id: jobId, status: 'running' } });
    expect(w.clock.now() - START_MS).toBeGreaterThanOrEqual(jobKillWaitMs(KILL_GRACE_MS));
    expect(w.clock.now() - START_MS).toBeLessThan(jobKillWaitMs(KILL_GRACE_MS) + 1000);
    const firstRequest = w.store.jobs.get(jobId)?.killRequestedAt;
    await other.jobs.kill(w.runId, jobId);
    expect(w.store.jobs.get(jobId)?.killRequestedAt).toBe(firstRequest);
    owner.spawned[0]?.exit({ code: 0, signal: null });
    await owner.jobs.finalized(jobId);
  });

  it('on a job whose owner is not alive runs the owner-dead reconcile: status unknown, the bytes of the file in the blob, the marker of the owner generation reaped, the file unlinked', async () => {
    const w = await world();
    generationOf(w, 1);
    const other = generationOf(w, 2);
    const jobId = 'bash_dead00000001';
    const file = fileOf(w, 1, jobId);
    fs.writeFileSync(file, '0123456789', { mode: 0o600 });
    w.store.idempotency.begin('k'.repeat(64), { expiresAt: START_MS + 1000, meta: { job: true } });
    w.store.jobs.start({ id: jobId, idemKey: 'k'.repeat(64), sessionId: w.sessionId, runId: w.runId, callId: 'c', command: 'sleep 99', ownerGeneration: 1, outputPath: file });
    w.store.jobs.attachProcess(jobId, 5151);
    w.store.claim('holder');

    const killed = await other.jobs.kill(w.runId, jobId);

    expect(killed).toMatchObject({ kill: 'stopped', view: { status: 'unknown' } });
    const finished = w.store.jobs.get(jobId);
    expect((await w.store.blobs.read(finished?.outputHandle ?? '', { offset: 0, length: 10 }, { runId: w.runId })).text).toBe('0123456789');
    expect(other.reaped).toEqual([{ marker: path.join(markerDirOf(w.root, 1), 'k'.repeat(64)), pgid: 5151 }]);
    expect(fs.existsSync(file)).toBe(false);
    expect(w.store.readRunEvents(w.runId, 0, 50).filter((event) => event.type === 'job.finished')).toMatchObject([{ jobId, status: 'unknown' }]);
  });
});

describe('the owner-dead reconcile (17.3, 20.36, 20.40)', () => {
  const seed = (w: World, id: string, owner: number | undefined): void => {
    const idemKey = id.padEnd(64, 'x');
    w.store.jobs.start({ id, idemKey, sessionId: w.sessionId, runId: w.runId, callId: id, command: 'sleep 99', ...(owner === undefined ? {} : { ownerGeneration: owner }) });
  };

  it('marks unknown a job of its own generation that is not live here and a job without an owner, leaves a job whose owner runtime lock is held, and takes it once that lock is free', async () => {
    const w = await world();
    const reconciler = generationOf(w, 2);
    generationOf(w, 1);
    seed(w, 'bash_own', 2);
    seed(w, 'bash_none', undefined);
    seed(w, 'bash_other', 1);
    w.liveOwners.add(1);

    await reconciler.jobs.reconcileOrphans();

    expect(w.store.jobs.get('bash_own')?.status).toBe('unknown');
    expect(w.store.jobs.get('bash_none')?.status).toBe('unknown');
    expect(w.store.jobs.get('bash_other')?.status).toBe('running');
    expect(reconciler.reaped.map((entry) => entry.marker)).toEqual([
      path.join(markerDirOf(w.root, 2), 'bash_own'.padEnd(64, 'x')),
      path.join(markerDirOf(w.root, 2), 'bash_none'.padEnd(64, 'x')),
    ]);

    w.liveOwners.delete(1);
    await reconciler.jobs.reconcileOrphans();
    expect(w.store.jobs.get('bash_other')?.status).toBe('unknown');
    expect(reconciler.reaped.at(-1)?.marker).toBe(path.join(markerDirOf(w.root, 1), 'bash_other'.padEnd(64, 'x')));
  });

  it('examines at most the batch of running jobs per call and goes on from where it stopped', async () => {
    const w = await world();
    const reconciler = generationOf(w, 2);
    for (let index = 0; index < 5; index += 1) seed(w, `bash_${index}`, undefined);

    await reconciler.jobs.reconcileOrphans({ batch: 2 });
    expect(w.store.jobs.listRunning()).toHaveLength(3);
    await reconciler.jobs.reconcileOrphans({ batch: 2 });
    await reconciler.jobs.reconcileOrphans({ batch: 2 });
    expect(w.store.jobs.listRunning()).toEqual([]);
  });

  it('the owner checks only its live jobs for a set flag: the flagged one stops as killed, the other runs on', async () => {
    const w = await world();
    const owner = generationOf(w, 1);
    const flagged = await owner.start('call-1');
    const other = await owner.start('call-2');
    w.store.jobs.requestKill(flagged.jobId);

    owner.jobs.stopKillRequested();
    await owner.jobs.finalized(flagged.jobId);

    expect(w.store.jobs.get(flagged.jobId)?.status).toBe('killed');
    expect(w.store.jobs.get(other.jobId)?.status).toBe('running');
    owner.spawned[1]?.exit({ code: 0, signal: null });
    await owner.jobs.finalized(other.jobId);
  });
});
