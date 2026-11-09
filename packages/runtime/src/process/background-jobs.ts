import path from 'node:path';
import { canonicalJson, claimRetry, commandMayStillRun, defaultProcessInspector, findHolders, groupAlive, groupPortOf, groupRecordOutcome, outlivedNotes, reapMarkedProcesses, recordMarkerGroup, reconcileProcessGroup, reportUninspectableOnce, sha256Hex } from '@momonga/foundation';
import type { Clock, MarkerMode, MarkerState, ProcessGroupPort, ReapTiming, UninspectableProcess, UninspectableRegistry } from '@momonga/foundation';
import type { SandboxedProcess } from '@momonga/sandbox';
import type { Job, JobResult, RuntimeStore } from '@momonga/store';
import { ToolExecutionError, createMarkerOwners, unnamedLivenessNotes } from '@momonga/tools';
import type { BackgroundJobs, MarkerOwners } from '@momonga/tools';
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
  owners?: MarkerOwners;
  killGraceMs: number;
  reapTiming: ReapTiming;
  onWarning(message: string): void;
  report(error: unknown): void;
  probes?: Partial<ProcessProbes>;
  uninspectable?: UninspectableRegistry;
  groupPort?: ProcessGroupPort;
  signal?: AbortSignal;
};

export type ProcessProbes = {
  findHolders: typeof findHolders;
  markerState(marker: string, options: { signal: AbortSignal; mode: MarkerMode }): Promise<MarkerState>;
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
  const probes: ProcessProbes = {
    findHolders,
    markerState: (marker, { signal, mode }) => defaultProcessInspector().markerState(marker, { signal, mode }),
    reconcileProcessGroup,
    reapMarkedProcesses,
    ...options.probes,
  };
  const groupPort = groupPortOf(options.groupPort, undefined);
  const live = new Map<string, LiveJob>();
  const owners = options.owners ?? createMarkerOwners();
  const ownedKeys = new Set<string>();
  const lifecycleStop = new AbortController();
  options.signal?.addEventListener('abort', () => lifecycleStop.abort(), { once: true });
  const lifecycle = lifecycleStop.signal;

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
    let markerSettled = false;
    const recordUnknown = (): void => {
      if (store.jobs.get(job.id)?.status !== 'running') return;
      store.jobs.finish(job.id, { status: 'unknown' });
      settleRecord(job, { job: job.id, status: 'unknown' });
    };
    try {
      const [exit, groupNotice] = await Promise.all([process.exited, groupRecordOutcome(recordMarkerGroup(marker, process.pgid), marker)]);
      if (groupNotice !== undefined) entry.output.push(Buffer.from(`\n${groupNotice}\n`));
      timers.clearTimeout(timer);
      const uninspectable: UninspectableProcess[] = [];
      const reportOnce = reportUninspectableOnce(onWarning, `background job ${job.id}`, options.uninspectable);
      const holders = await probes.findHolders(marker, {
        signal: lifecycle,
        onUninspectable: (unreadable) => {
          uninspectable.push(unreadable);
          reportOnce(unreadable);
        },
      });
      if (holders.length > 0) {
        const reaped = await probes.reconcileProcessGroup({ pgid: process.pgid, marker }, { killGraceMs, timing: reapTiming, signal: lifecycle });
        const notes = outlivedNotes(reaped, 'job');
        if (notes.length > 0) entry.output.push(Buffer.from(`\n${notes.join('\n')}\n`));
      }
      const refused: UninspectableProcess[] = [];
      const remaining = holders.length === 0 && uninspectable.length === 0 ? [] : await probes.findHolders(marker, { signal: lifecycle, onUninspectable: (process) => void refused.push(process) });
      const markerState = await probes.markerState(marker, { signal: lifecycle, mode: owners.modeOf(job.idemKey) ?? 'listed' });
      const unnamed = markerState === 'held' && remaining.length === 0;
      const runnable = unnamed ? await groupAlive(process.pgid, groupPort, lifecycle) : undefined;
      const liveness = commandMayStillRun({ marker: markerState, listing: { kind: 'listed', holders: remaining, refused }, ...(runnable === undefined ? {} : { group: { kind: 'read', runnable } }) });
      markerSettled = liveness.answer === 'no';
      if (remaining.length === 0) {
        const notes = unnamedLivenessNotes(exit, liveness, refused);
        if (notes.length > 0) entry.output.push(Buffer.from(`\n${notes.join('\n')}\n`));
      }
      await drain(pumps);
      const window = entry.output.window();
      const stored = window.bytes.length === 0 ? undefined : store.blobs.put(window.bytes, { mediaType: 'text/plain', runId: job.runId });
      const result: JobResult = {
        status: uninspectable.length > 0 ? 'unknown' : entry.stopReason === undefined ? 'exited' : 'killed',
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
      if (markerSettled) await markerFiles.remove(marker, onWarning);
      ownedKeys.delete(job.idemKey);
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
    const controller = new AbortController();
    let process: SandboxedProcess;
    let created = false;
    ownedKeys.add(idemKey);
    owners.register(idemKey, { alive: () => ownedKeys.has(idemKey) });
    try {
      process = await markerFiles.create(marker, (markerFd, mode) => {
        created = true;
        owners.remember(idemKey, mode);
        return request.spawn(marker, controller.signal, markerFd);
      });
    } catch (error) {
      if (created) await markerFiles.remove(marker, onWarning);
      ownedKeys.delete(idemKey);
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
        const orphanMarker = path.join(markerDir, job.idemKey);
        try {
          const claim = await claimRetry(orphanMarker, 'startup', { signal: lifecycle });
          if (claim === 'absent' || claim === 'claimed') {
            await probes.reapMarkedProcesses({
              marker: orphanMarker,
              ...(job.pgid === undefined ? {} : { pgid: job.pgid }),
              killGraceMs,
              label: 'job',
              onWarning,
              timing: reapTiming,
              signal: lifecycle,
            });
          }
        } catch (error) {
          onWarning(`background job ${job.id} could not be reaped: ${asError(error).message}`);
        }
        store.jobs.finish(job.id, { status: 'unknown' });
        settleRecord(job, { job: job.id, status: 'unknown' });
      }
    },
  };
};
