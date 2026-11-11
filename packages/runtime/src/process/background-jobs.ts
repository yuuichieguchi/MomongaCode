import path from 'node:path';
import { POLL_INTERVAL_MS, sleep, canonicalJson, claimRetry, commandMayStillRun, findHolders, groupAlive, groupPortOf, groupRecordOutcome, markerReapClockBoundMs, outlivedNotes, reapMarkedProcesses, recordMarkerGroup, reconcileProcessGroup, reportUninspectableOnce, sha256Hex } from '@momonga/foundation';
import type { Clock, FileSystem, MarkerMode, MarkerState, ProcessGroupPort, Timing, RolePort, UninspectableProcess, UninspectableRegistry, ProcessInspector } from '@momonga/foundation';
import type { SandboxedProcess } from '@momonga/sandbox';
import type { Job, JobResult, RuntimeStore } from '@momonga/store';
import { RetiringYield, ToolExecutionError, createMarkerOwners, unnamedLivenessNotes } from '@momonga/tools';
import type { BackgroundJobs, LineFilter, MarkerOwners } from '@momonga/tools';
import { toJobView as viewOf } from '../service/views.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { asError } from './as-error.ts';
import { JOB_END_PROBE_MS, JOB_ID_HEX_CHARS, JOB_IDEMPOTENCY_TTL_MS, JOB_KILL_OWNER_WAKE_MS, JOB_OUTPUT_FILE_MAX_BYTES, JOB_OUTPUT_WINDOW_BYTES, JOB_RECONCILE_BATCH_JOBS, JOB_STREAM_DRAIN_MS, MAX_RUNNING_JOBS_PER_SESSION } from './constants.ts';
import { jobOutputFileErrorCode, jobOutputPathOf, openJobOutputFile, readJobFileWindow, removeJobOutputFile, removeLeftoverJobOutputFile } from './job-output-file.ts';
import type { JobOutputFile } from './job-output-file.ts';
import { createJobOutput } from './job-output.ts';
import type { JobMarkerFiles } from './job-marker-files.ts';
import type { JobOutput } from './job-output.ts';

export type BackgroundJobsOptions = {
  store: Pick<RuntimeStore, 'jobs' | 'idempotency' | 'blobs' | 'getRun' | 'rootSessionId'>;
  clock: Clock;
  timers: ServiceTimers;
  markerDir: string;
  generation: number;
  jobsDir: string;
  role: Pick<RolePort, 'current'>;
  markerDirOf(ownerGeneration: number): string;
  ownerAlive(ownerGeneration: number): Promise<boolean>;
  onSettled?: () => void;
  markerFiles: JobMarkerFiles;
  files: FileSystem;
  inspector: ProcessInspector;
  owners?: MarkerOwners;
  killGraceMs: number;
  reapTiming: Timing;
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
  liveCount(): number;
  stopKillRequested(): void;
  reconcileOrphans(options?: { batch: number }): Promise<void>;
  stopAll(): Promise<void>;
};

export const jobKillWaitMs = (killGraceMs: number): number => markerReapClockBoundMs(killGraceMs) + JOB_KILL_OWNER_WAKE_MS;

export { JOB_RECONCILE_BATCH_JOBS };

type StopReason = 'killed' | 'timeout' | 'shutdown';

type EndProbe = { uninspectable: UninspectableProcess[]; remaining: number[]; refused: UninspectableProcess[]; liveness: ReturnType<typeof commandMayStillRun> };

const END_PROBE_EXPIRED_NOTE = `the check of the processes of this job did not end within ${JOB_END_PROBE_MS} ms, so whether one still runs is unknown`;

type LiveJob = {
  job: Job;
  controller: AbortController;
  output: JobOutput;
  file: JobOutputFile;
  stopReason: StopReason | undefined;
  finalized: Promise<void>;
};

const jobKeyOf = (callKey: string): string => sha256Hex(canonicalJson([callKey, 'background']));

const matching = async (text: string, keep: LineFilter): Promise<string> => (await keep(text.split('\n'))).join('\n');

export const createBackgroundJobs = (options: BackgroundJobsOptions): BackgroundJobRegistry => {
  const { store, clock, timers, markerDir, markerFiles, inspector, killGraceMs, reapTiming, onWarning, report } = options;
  const probes: ProcessProbes = {
    findHolders,
    markerState: (marker, { signal, mode }) => inspector.markerState(marker, { signal, mode }),
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

  const discardOutputFile = async (file: JobOutputFile, jobId: string): Promise<void> => {
    try {
      await file.close();
      await removeJobOutputFile(options.files, file.path);
    } catch (error) {
      onWarning(`the output file of background job ${jobId} could not be removed: ${asError(error).message}`);
    }
  };

  const endProbeBound = (): { signal: AbortSignal; expired(): boolean; dispose(): void } => {
    const bound = new AbortController();
    const handle = timers.setTimeout(() => bound.abort(new Error(`the check of the processes of a background job did not end within ${JOB_END_PROBE_MS} ms`)), JOB_END_PROBE_MS);
    return { signal: AbortSignal.any([lifecycle, bound.signal]), expired: () => bound.signal.aborted, dispose: () => timers.clearTimeout(handle) };
  };

  const probeEnd = async (entry: LiveJob, process: SandboxedProcess, marker: string, signal: AbortSignal): Promise<EndProbe> => {
    const { job } = entry;
    const uninspectable: UninspectableProcess[] = [];
    const reportOnce = reportUninspectableOnce(onWarning, `background job ${job.id}`, options.uninspectable);
    const holders = await probes.findHolders(marker, {
      signal,
      inspector,
      onUninspectable: (unreadable) => {
        uninspectable.push(unreadable);
        reportOnce(unreadable);
      },
    });
    if (holders.length > 0) {
      const reaped = await probes.reconcileProcessGroup({ pgid: process.pgid, marker }, { killGraceMs, timing: reapTiming, signal, inspector });
      const notes = outlivedNotes(reaped, 'job');
      if (notes.length > 0) entry.output.push(Buffer.from(`\n${notes.join('\n')}\n`));
    }
    const refused: UninspectableProcess[] = [];
    const remaining = holders.length === 0 && uninspectable.length === 0 ? [] : await probes.findHolders(marker, { signal, inspector, onUninspectable: (unreadable) => void refused.push(unreadable) });
    const markerState = await probes.markerState(marker, { signal, mode: owners.modeOf(job.idemKey) ?? 'listed' });
    const unnamed = markerState === 'held' && remaining.length === 0;
    const runnable = unnamed ? await groupAlive(process.pgid, groupPort, signal) : undefined;
    const liveness = commandMayStillRun({ marker: markerState, listing: { kind: 'listed', holders: remaining, refused }, ...(runnable === undefined ? {} : { group: { kind: 'read', runnable } }) });
    return { uninspectable, remaining, refused, liveness };
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
      const probe = endProbeBound();
      let ended: EndProbe | undefined;
      try {
        ended = await probeEnd(entry, process, marker, probe.signal);
      } catch (error) {
        if (!probe.expired()) throw error;
      } finally {
        probe.dispose();
      }
      if (ended === undefined) entry.output.push(Buffer.from(`\n${END_PROBE_EXPIRED_NOTE}\n`));
      else {
        markerSettled = ended.liveness.answer === 'no';
        if (ended.remaining.length === 0) {
          const notes = unnamedLivenessNotes(exit, ended.liveness, ended.refused);
          if (notes.length > 0) entry.output.push(Buffer.from(`\n${notes.join('\n')}\n`));
        }
      }
      const inspected = ended !== undefined && ended.uninspectable.length === 0 && exit.stop === 'confirmed';
      await drain(pumps);
      const window = entry.output.window();
      const stored = window.bytes.length === 0 ? undefined : await store.blobs.put(window.bytes, { mediaType: 'text/plain', runId: job.runId });
      const result: JobResult = {
        status: !inspected ? 'unknown' : entry.stopReason === undefined ? 'exited' : 'killed',
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
      await discardOutputFile(entry.file, job.id);
      timers.clearTimeout(timer);
      if (markerSettled) await markerFiles.remove(marker, onWarning);
      ownedKeys.delete(job.idemKey);
      live.delete(job.id);
      options.onSettled?.();
    }
  };

  const stop = (entry: LiveJob, reason: StopReason): Promise<void> => {
    if (entry.stopReason === undefined) {
      entry.stopReason = reason;
      entry.controller.abort();
    }
    return entry.finalized;
  };

  const pump = async (stream: AsyncIterable<Uint8Array>, output: JobOutput, file: JobOutputFile): Promise<void> => {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      output.push(bytes);
      file.append(bytes);
    }
  };

  const ownerLives = async (job: Job): Promise<boolean> => {
    if (job.ownerGeneration === undefined || job.ownerGeneration === options.generation) return false;
    return options.ownerAlive(job.ownerGeneration);
  };

  const markerOf = (job: Job): string => path.join(job.ownerGeneration === undefined ? markerDir : options.markerDirOf(job.ownerGeneration), job.idemKey);

  const reconcileOrphan = async (job: Job): Promise<void> => {
    const orphanMarker = markerOf(job);
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
          inspector,
        });
      }
    } catch (error) {
      onWarning(`background job ${job.id} could not be reaped: ${asError(error).message}`);
    }
    let output: JobResult['output'];
    if (job.outputPath !== undefined) {
      try {
        const window = await readJobFileWindow(options.files, job.outputPath, 0, JOB_OUTPUT_WINDOW_BYTES);
        if (window !== undefined && window.bytes.length > 0) {
          output = { handle: (await store.blobs.put(window.bytes, { mediaType: 'text/plain', runId: job.runId })).handle, start: window.start, total: window.total };
        }
      } catch (error) {
        onWarning(`the output file of background job ${job.id} could not be read: ${asError(error).message}`);
      }
    }
    store.jobs.finish(job.id, { status: 'unknown', ...(output === undefined ? {} : { output }) });
    settleRecord(job, { job: job.id, status: 'unknown' });
    if (job.outputPath !== undefined) {
      await removeJobOutputFile(options.files, job.outputPath).catch((error: unknown) => onWarning(`the output file of background job ${job.id} could not be removed: ${asError(error).message}`));
    }
  };

  const waitUntilEnded = async (jobId: string): Promise<Job> => {
    const deadline = reapTiming.now() + jobKillWaitMs(killGraceMs);
    for (;;) {
      const current = store.jobs.get(jobId);
      if (current === undefined) throw new Error(`job ${jobId} vanished`);
      if (current.status !== 'running' || reapTiming.now() >= deadline || lifecycle.aborted) return current;
      await sleep(reapTiming, Math.min(POLL_INTERVAL_MS, deadline - reapTiming.now()));
    }
  };

  let reconcileCursor: string | undefined;

  const start: BackgroundJobs['start'] = async (request) => {
    const run = store.getRun(request.runId);
    if (run === undefined) throw new Error(`run ${request.runId} does not exist`);
    const idemKey = jobKeyOf(request.callKey);
    const existing = store.jobs.byIdemKey(idemKey);
    if (existing !== undefined) return { jobId: existing.id };
    if (options.role.current() === 'retiring') throw new RetiringYield();
    const running = store.jobs.listForSession(run.sessionId).filter((job) => job.status === 'running').length;
    if (running >= MAX_RUNNING_JOBS_PER_SESSION) {
      throw new ToolExecutionError(`This session already has ${running} running background jobs; stop one with KillBash before starting another`);
    }
    const jobId = `bash_${idemKey.slice(0, JOB_ID_HEX_CHARS)}`;
    const outputPath = jobOutputPathOf(options.jobsDir, jobId);
    let fileFailure: ((code: string) => void) | undefined;
    let file: JobOutputFile;
    try {
      if (store.jobs.get(jobId) === undefined) await removeLeftoverJobOutputFile(options.files, outputPath);
      file = await openJobOutputFile(options.files, { path: outputPath, maxBytes: JOB_OUTPUT_FILE_MAX_BYTES, onFailure: (code) => fileFailure?.(code) });
    } catch (error) {
      throw new ToolExecutionError(`could not start the background job: its output file could not be created (${jobOutputFileErrorCode(error)})`);
    }
    fileFailure = () => {
      try {
        store.jobs.clearOutputPath(jobId);
      } catch (error) {
        report(error);
      }
    };
    const discardFile = (): Promise<void> => discardOutputFile(file, jobId);
    let job: Job;
    try {
      store.idempotency.begin(idemKey, { expiresAt: clock.now() + JOB_IDEMPOTENCY_TTL_MS, meta: { tool: 'Bash', runId: request.runId, job: true } });
      job = store.jobs.start({
        id: jobId,
        idemKey,
        sessionId: run.sessionId,
        runId: request.runId,
        callId: request.callId,
        command: request.command,
        ownerGeneration: options.generation,
        outputPath,
      }).job;
    } catch (error) {
      await discardFile();
      throw error;
    }
    ownedKeys.add(idemKey);
    owners.register(idemKey, { alive: () => ownedKeys.has(idemKey) });
    const marker = path.join(markerDir, idemKey);
    const controller = new AbortController();
    let process: SandboxedProcess;
    let created = false;
    try {
      process = await markerFiles.create(marker, (markerFd, mode) => {
        created = true;
        owners.remember(idemKey, mode);
        return request.spawn(marker, controller.signal, markerFd);
      });
    } catch (error) {
      if (created) await markerFiles.remove(marker, onWarning);
      ownedKeys.delete(idemKey);
      await discardFile();
      store.jobs.finish(job.id, { status: 'unknown' });
      settleRecord(job, { job: job.id, status: 'unknown' });
      throw error;
    }
    store.jobs.attachProcess(job.id, process.pgid);
    store.idempotency.attachProcess(idemKey, { pgid: process.pgid, startedAt: clock.now() });
    const output = createJobOutput(JOB_OUTPUT_WINDOW_BYTES);
    const pumps = Promise.all([pump(process.stdout, output, file), pump(process.stderr, output, file)]).then(() => undefined);
    const entry: LiveJob = { job, controller, output, file, stopReason: undefined, finalized: Promise.resolve() };
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
    if (job.status === 'running' && job.outputPath !== undefined) {
      const window = await readJobFileWindow(options.files, job.outputPath, from, JOB_OUTPUT_WINDOW_BYTES);
      if (window !== undefined) return { text: window.bytes.toString('utf8'), omitted: Math.max(0, window.start - from), total: window.total };
      const reread = store.jobs.get(job.id);
      if (reread === undefined || reread.status === 'running') return { text: '', omitted: 0, total: job.readOffset };
      return readStored(reread, from);
    }
    return readStored(job, from);
  };

  const readStored = async (job: Job, from: number): Promise<{ text: string; omitted: number; total: number }> => {
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
    read: async (runId, jobId, { keep, call }) => {
      const job = authorize(runId, jobId);
      const { text, omitted, total } = await readWindow(job, call);
      const kept = keep === undefined ? text : await matching(text, keep);
      store.jobs.advanceRead(job.id, total, call);
      const note = omitted > 0 ? `[… ${omitted} bytes omitted …]\n` : '';
      const current = store.jobs.get(job.id) ?? job;
      const shown = kept === '' ? note.trimEnd() : `${note}${kept}`.replace(/\n+$/, '');
      const fileFailure = live.get(job.id)?.file.failure();
      const unavailable = fileFailure === undefined ? '' : `[output file unavailable: ${fileFailure}]`;
      return { job: viewOf(current), output: unavailable === '' ? shown : shown === '' ? unavailable : `${shown}\n${unavailable}` };
    },
    kill: async (runId, jobId) => {
      const job = authorize(runId, jobId);
      const entry = live.get(job.id);
      if (entry !== undefined) await stop(entry, 'killed');
      else if (job.status === 'running') {
        if (await ownerLives(job)) {
          store.jobs.requestKill(job.id);
          const waited = await waitUntilEnded(job.id);
          return { view: viewOf(waited), kill: waited.status === 'running' ? 'requested' : 'stopped' };
        }
        await reconcileOrphan(job);
      }
      const current = store.jobs.get(job.id);
      if (current === undefined) throw new Error(`job ${job.id} vanished`);
      return { view: viewOf(current), kill: 'stopped' };
    },
    finalized: (jobId) => live.get(jobId)?.finalized ?? Promise.resolve(),
    liveKeys: () => new Set([...live.values()].map((entry) => entry.job.idemKey)),
    stopAll: async () => {
      await Promise.allSettled([...live.values()].map((entry) => stop(entry, 'shutdown')));
    },
    liveCount: () => live.size,
    stopKillRequested: () => {
      for (const entry of live.values()) {
        if (entry.stopReason === undefined && store.jobs.get(entry.job.id)?.killRequestedAt !== undefined) void stop(entry, 'killed');
      }
    },
    reconcileOrphans: async (batchOptions) => {
      const running = store.jobs.listRunning();
      const after = reconcileCursor === undefined ? -1 : running.findIndex((job) => job.id === reconcileCursor);
      const ordered = [...running.slice(after + 1), ...running.slice(0, after + 1)];
      const batch = batchOptions === undefined ? ordered : ordered.slice(0, batchOptions.batch);
      for (const job of batch) {
        reconcileCursor = job.id;
        if (ownedKeys.has(job.idemKey)) continue;
        if (await ownerLives(job)) continue;
        await reconcileOrphan(job);
      }
    },
  };
};
