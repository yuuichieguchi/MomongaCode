import path from 'node:path';
import { canonicalJson, findHolders, reapMarkedProcesses, reconcileProcessGroup, sha256Hex } from '@momonga/foundation';
import type { Clock, ReapTiming } from '@momonga/foundation';
import type { SandboxedProcess } from '@momonga/sandbox';
import type { Job, JobResult, RuntimeStore } from '@momonga/store';
import { ToolExecutionError } from '@momonga/tools';
import type { BackgroundJobs } from '@momonga/tools';
import { toJobView as viewOf } from '../service/views.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { asError } from './as-error.ts';
import { JOB_ID_HEX_CHARS, JOB_IDEMPOTENCY_TTL_MS, JOB_OUTPUT_WINDOW_BYTES, JOB_STREAM_DRAIN_MS, MAX_RUNNING_JOBS_PER_SESSION } from './constants.ts';
import { createJobOutput } from './job-output.ts';
import type { JobMarkerFiles } from './job-marker-files.ts';
import type { JobOutput } from './job-output.ts';

export type BackgroundJobsOptions = {
  store: Pick<RuntimeStore, 'jobs' | 'idempotency' | 'blobs' | 'getRun' | 'rootSessionId'>;
  clock: Clock;
  timers: ServiceTimers;
  markerDir: string;
  markerFiles: JobMarkerFiles;
  killGraceMs: number;
  reapTiming: ReapTiming;
  onWarning(message: string): void;
  report(error: unknown): void;
  probes?: Partial<ProcessProbes>;
};

export type ProcessProbes = {
  findHolders: typeof findHolders;
  reconcileProcessGroup: typeof reconcileProcessGroup;
  reapMarkedProcesses: typeof reapMarkedProcesses;
};

export type BackgroundJobRegistry = BackgroundJobs & {
  liveKeys(): ReadonlySet<string>;
  finalized(jobId: string): Promise<void>;
  reconcileOrphans(): Promise<void>;
  stopAll(): Promise<void>;
};

type StopReason = 'killed' | 'timeout' | 'shutdown';

type LiveJob = {
  job: Job;
  controller: AbortController;
  output: JobOutput;
  stopReason: StopReason | undefined;
  finalized: Promise<void>;
};

const jobKeyOf = (callKey: string): string => sha256Hex(canonicalJson([callKey, 'background']));

const matching = (text: string, filter: RegExp): string =>
  text
    .split('\n')
    .filter((line) => filter.test(line))
    .join('\n');

export const createBackgroundJobs = (options: BackgroundJobsOptions): BackgroundJobRegistry => {
  const { store, clock, timers, markerDir, markerFiles, killGraceMs, reapTiming, onWarning, report } = options;
  const probes: ProcessProbes = { findHolders, reconcileProcessGroup, reapMarkedProcesses, ...options.probes };
  const live = new Map<string, LiveJob>();

  const authorize = (runId: string, jobId: string): Job => {
    const run = store.getRun(runId);
    if (run === undefined) throw new Error(`run ${runId} does not exist`);
    const job = store.jobs.get(jobId);
    if (job === undefined || job.sessionId !== store.rootSessionId(run.sessionId)) throw new ToolExecutionError(`Unknown job ${jobId}`);
    return job;
  };

  const settleRecord = (job: Job, result: unknown): void => {
    const lookup = store.idempotency.get(job.idemKey);
    if (lookup !== undefined && lookup.s !== 'COMPLETED') store.idempotency.complete(job.idemKey, result);
  };

  const drain = async (pumps: Promise<void>): Promise<void> => {
    let handle: unknown;
    const expired = new Promise<void>((resolve) => {
      handle = timers.setTimeout(resolve, JOB_STREAM_DRAIN_MS);
    });
    try {
      await Promise.race([pumps, expired]);
    } finally {
      timers.clearTimeout(handle);
    }
  };

  const finalize = async (entry: LiveJob, process: SandboxedProcess, pumps: Promise<void>, timer: unknown): Promise<void> => {
    const { job } = entry;
    const marker = path.join(markerDir, job.idemKey);
    const recordUnknown = (): void => {
      if (store.jobs.get(job.id)?.status !== 'running') return;
      store.jobs.finish(job.id, { status: 'unknown' });
      settleRecord(job, { job: job.id, status: 'unknown' });
    };
    try {
      const exit = await process.exited;
      timers.clearTimeout(timer);
      const holders = await probes.findHolders(marker);
      if (holders.length > 0) {
        await probes.reconcileProcessGroup({ pgid: process.pgid, marker }, { killGraceMs, timing: reapTiming });
        entry.output.push(Buffer.from(`\nTerminated ${holders.length} process(es) that outlived the job.\n`));
      }
      await drain(pumps);
      const window = entry.output.window();
      const stored = window.bytes.length === 0 ? undefined : store.blobs.put(window.bytes, { mediaType: 'text/plain' });
      const result: JobResult = {
        status: entry.stopReason === undefined ? 'exited' : 'killed',
        ...(exit.code === null ? {} : { exitCode: exit.code }),
        ...(exit.signal === null ? {} : { signal: exit.signal }),
        ...(stored === undefined ? {} : { output: { handle: stored.handle, start: window.start, total: window.total } }),
      };
      store.jobs.finish(job.id, result);
      settleRecord(job, { job: job.id, status: result.status });
    } catch (error) {
      recordUnknown();
      throw error;
    } finally {
      timers.clearTimeout(timer);
      markerFiles.remove(marker);
      live.delete(job.id);
    }
  };

  const stop = (entry: LiveJob, reason: StopReason): Promise<void> => {
    if (entry.stopReason === undefined) {
      entry.stopReason = reason;
      entry.controller.abort();
    }
    return entry.finalized;
  };

  const pump = async (stream: AsyncIterable<Uint8Array>, output: JobOutput): Promise<void> => {
    for await (const chunk of stream) output.push(Buffer.from(chunk));
  };

  const start: BackgroundJobs['start'] = async (request) => {
    const run = store.getRun(request.runId);
    if (run === undefined) throw new Error(`run ${request.runId} does not exist`);
    const idemKey = jobKeyOf(request.callKey);
    const existing = store.jobs.byIdemKey(idemKey);
    if (existing !== undefined) return { jobId: existing.id };
    const running = store.jobs.listForSession(run.sessionId).filter((job) => job.status === 'running').length;
    if (running >= MAX_RUNNING_JOBS_PER_SESSION) {
      throw new ToolExecutionError(`This session already has ${running} running background jobs; stop one with KillBash before starting another`);
    }
    store.idempotency.begin(idemKey, { expiresAt: clock.now() + JOB_IDEMPOTENCY_TTL_MS, meta: { tool: 'Bash', runId: request.runId, job: true } });
    const { job } = store.jobs.start({
      id: `bash_${idemKey.slice(0, JOB_ID_HEX_CHARS)}`,
      idemKey,
      sessionId: run.sessionId,
      runId: request.runId,
      callId: request.callId,
      command: request.command,
    });
    const marker = path.join(markerDir, idemKey);
    markerFiles.create(marker);
    const controller = new AbortController();
    let process: SandboxedProcess;
    try {
      process = request.spawn(marker, controller.signal);
    } catch (error) {
      markerFiles.remove(marker);
      store.jobs.finish(job.id, { status: 'unknown' });
      settleRecord(job, { job: job.id, status: 'unknown' });
      throw error;
    }
    store.jobs.attachProcess(job.id, process.pgid);
    store.idempotency.attachProcess(idemKey, { pgid: process.pgid, startedAt: clock.now() });
    const output = createJobOutput(JOB_OUTPUT_WINDOW_BYTES);
    const pumps = Promise.all([pump(process.stdout, output), pump(process.stderr, output)]).then(() => undefined);
    const entry: LiveJob = { job, controller, output, stopReason: undefined, finalized: Promise.resolve() };
    const timer = timers.setTimeout(() => void stop(entry, 'timeout'), request.timeoutMs);
    entry.finalized = finalize(entry, process, pumps, timer);
    entry.finalized.catch(report);
    live.set(job.id, entry);
    return { jobId: job.id };
  };

  const readWindow = async (job: Job, call: string): Promise<{ text: string; omitted: number; total: number }> => {
    const entry = live.get(job.id);
    const from = job.lastRead?.call === call ? job.lastRead.from : job.readOffset;
    if (entry !== undefined) {
      const window = entry.output.window();
      const begin = Math.max(from, window.start);
      return { text: window.bytes.subarray(begin - window.start).toString('utf8'), omitted: Math.max(0, window.start - from), total: window.total };
    }
    if (job.outputHandle === undefined) return { text: '', omitted: 0, total: job.readOffset };
    const begin = Math.max(from, job.outputStart);
    const length = job.outputTotal - begin;
    const text = length <= 0 ? '' : (await store.blobs.read(job.outputHandle, { offset: begin - job.outputStart, length })).text;
    return { text, omitted: Math.max(0, job.outputStart - from), total: job.outputTotal };
  };

  return {
    start,
    byCall: (callKey) => {
      const job = store.jobs.byIdemKey(jobKeyOf(callKey));
      return job === undefined ? undefined : viewOf(job);
    },
    status: (runId, jobId) => viewOf(authorize(runId, jobId)),
    read: async (runId, jobId, { filter, call }) => {
      const job = authorize(runId, jobId);
      const { text, omitted, total } = await readWindow(job, call);
      store.jobs.advanceRead(job.id, total, call);
      const kept = filter === undefined ? text : matching(text, filter);
      const note = omitted > 0 ? `[… ${omitted} bytes omitted …]\n` : '';
      const current = store.jobs.get(job.id) ?? job;
      return { job: viewOf(current), output: kept === '' ? note.trimEnd() : `${note}${kept}`.replace(/\n+$/, '') };
    },
    kill: async (runId, jobId) => {
      const job = authorize(runId, jobId);
      const entry = live.get(job.id);
      if (entry !== undefined) await stop(entry, 'killed');
      const current = store.jobs.get(job.id);
      if (current === undefined) throw new Error(`job ${job.id} vanished`);
      return viewOf(current);
    },
    finalized: (jobId) => live.get(jobId)?.finalized ?? Promise.resolve(),
    liveKeys: () => new Set([...live.values()].map((entry) => entry.job.idemKey)),
    stopAll: async () => {
      await Promise.allSettled([...live.values()].map((entry) => stop(entry, 'shutdown')));
    },
    reconcileOrphans: async () => {
      for (const job of store.jobs.listRunning()) {
        if (live.has(job.id)) continue;
        try {
          await probes.reapMarkedProcesses({
            marker: path.join(markerDir, job.idemKey),
            ...(job.pgid === undefined ? {} : { pgid: job.pgid }),
            killGraceMs,
            label: 'job',
            onWarning,
            timing: reapTiming,
          });
        } catch (error) {
          onWarning(`background job ${job.id} could not be reaped: ${asError(error).message}`);
        }
        store.jobs.finish(job.id, { status: 'unknown' });
        settleRecord(job, { job: job.id, status: 'unknown' });
      }
    },
  };
};
