import { createHash } from 'node:crypto';
import path from 'node:path';
import { POLL_INTERVAL_MS, ProcessLockHeldError, acquireProcessLock, canonicalJson, cleanFailureMessage, settledOrAborted, waitUntil } from '@momonga/foundation';
import type { GenerationRole, ProcessLock, KernelLockMechanism, Redactor, Timing } from '@momonga/foundation';
import { SERVICE_UNAVAILABLE_STATUS, TARGET_NOT_READY, TARGET_PROBE_FAILED, TARGET_PROBING, TARGET_PROBING_MESSAGE, isTargetProbing, measuringOfWire, measuringWireOf } from '@momonga/protocol';
import type { Measuring, Probing } from '@momonga/protocol';
import { GatewayError } from '../core/errors.ts';
import type { GatewayTimers } from '../types.ts';
import type { MeasurementProgress } from './client.ts';
import { ensurePrivateProbeDirectory } from './record.ts';
import { measurementCauseOf, measurementFailedText } from './remedy.ts';

const LOCK_DIGEST_CHARS = 16;

const MS_PER_SECOND = 1000;

export const NO_PROGRESS_LISTENER: MeasurementProgress = { step: () => undefined };

export type ProbeLockKey = Readonly<Record<string, string | null>>;

export class ProbeInProgressError extends Error {
  constructor(target: string) {
    super(`the model "${target}" is already being measured (once per probe key); run the command again when it finishes`);
    this.name = 'ProbeInProgressError';
  }
}

export class ProbeKeyChangedError extends Error {
  constructor(target: string, before: ProbeLockKey, after: ProbeLockKey) {
    super(`the identity of the model "${target}" changed while it was measured (from ${canonicalJson(before)} to ${canonicalJson(after)}), so the measurement was not recorded`);
    this.name = 'ProbeKeyChangedError';
  }
}

const identityOf = (key: ProbeLockKey): string => canonicalJson(key);

const keyDigest = (key: ProbeLockKey): string => createHash('sha256').update(identityOf(key)).digest('hex').slice(0, LOCK_DIGEST_CHARS);

export const probeLockPath = (dir: string, key: ProbeLockKey): string => path.join(dir, `${keyDigest(key)}.lock`);

export const acquireProbeLock = async (dir: string, key: ProbeLockKey, target: string, lock: KernelLockMechanism): Promise<ProcessLock> => {
  const lockPath = probeLockPath(dir, key);
  await ensurePrivateProbeDirectory(dir);
  try {
    return await acquireProcessLock(lockPath, undefined, { mechanism: lock });
  } catch (error) {
    if (error instanceof ProcessLockHeldError) throw new ProbeInProgressError(target);
    throw error;
  }
};

export type PreconditionVerdict = { kind: 'met' } | { kind: 'refused'; message: string; detail: string; remedy: string | undefined };

export type ProbePrecondition = { boundMs: number; check(signal: AbortSignal): Promise<PreconditionVerdict> };

export type MeasuringAsk = { readonly fields: readonly string[]; readonly declaration: string };

export type MeasureRequest<Key> = { key: Key; signal: AbortSignal; progress: MeasurementProgress };

export type ProbeSubject<Key extends ProbeLockKey, Report> = {
  target: string;
  unknown: MeasuringAsk;
  readKey(): Promise<Key>;
  precondition: ProbePrecondition;
  measure(request: MeasureRequest<Key>): Promise<Report>;
  save(key: Key, report: Report): Promise<void>;
};

export type MeasureProbe<Key extends ProbeLockKey, Report> = ProbeSubject<Key, Report>['measure'];

const sameKey = (left: ProbeLockKey, right: ProbeLockKey): boolean => identityOf(left) === identityOf(right);

const holdProbeLock = async (dir: string, key: ProbeLockKey, target: string, lock: KernelLockMechanism, timing: LockWaitTiming, signal: AbortSignal, waitMs: number): Promise<ProcessLock> => {
  const take = async (): Promise<ProcessLock | undefined> => {
    try {
      return await acquireProbeLock(dir, key, target, lock);
    } catch (error) {
      if (error instanceof ProbeInProgressError) return undefined;
      throw error;
    }
  };
  const outcome = await waitUntil(timing, take, { intervalMs: POLL_INTERVAL_MS, deadline: timing.monotonicMs() + waitMs, signal });
  if (outcome.kind === 'found') return outcome.value;
  signal.throwIfAborted();
  throw new ProbeInProgressError(target);
};

export type LockWaitTiming = Timing;

type Recording = { dir: string; lock: KernelLockMechanism; timing: LockWaitTiming; lockWaitMs: number };

const measureAndRecord = async <Key extends ProbeLockKey, Report>(subject: ProbeSubject<Key, Report>, recording: Recording, key: Key, signal: AbortSignal, progress: MeasurementProgress): Promise<Report> => {
  const report = await settledOrAborted(subject.measure({ key, signal, progress }), signal);
  const lock = await holdProbeLock(recording.dir, key, subject.target, recording.lock, recording.timing, signal, recording.lockWaitMs);
  try {
    const after = await subject.readKey();
    if (!sameKey(key, after)) throw new ProbeKeyChangedError(subject.target, key, after);
    await subject.save(key, report);
    return report;
  } finally {
    lock.release();
  }
};

export const recordProbe = async <Key extends ProbeLockKey, Report>(
  subject: ProbeSubject<Key, Report>,
  dir: string,
  lock: KernelLockMechanism,
  timing: LockWaitTiming,
  signal: AbortSignal,
  lockWaitMs: number,
): Promise<{ key: Key; report: Report }> => {
  const key = await subject.readKey();
  return { key, report: await measureAndRecord(subject, { dir, lock, timing, lockWaitMs }, key, signal, NO_PROGRESS_LISTENER) };
};

export const targetProbingError = (probing: Probing): GatewayError =>
  new GatewayError({
    status: SERVICE_UNAVAILABLE_STATUS,
    type: 'server_error',
    code: TARGET_PROBING,
    message: probing.message,
    headers: { 'retry-after': String(probing.retryAfterSeconds) },
    measuring: measuringWireOf(probing.measuring),
  });

export type ProbeFailure = { cause: string; target: string; declaration: string };

export const probeFailureOf = (error: unknown, target: string, ask: MeasuringAsk, redactor: Pick<Redactor, 'text'>): ProbeFailure => ({
  cause: redactor.text(cleanFailureMessage(measurementCauseOf(error))),
  target,
  declaration: ask.declaration,
});

export const targetProbeFailedError = (failure: ProbeFailure): GatewayError =>
  new GatewayError({
    status: SERVICE_UNAVAILABLE_STATUS,
    type: 'server_error',
    code: TARGET_PROBE_FAILED,
    message: measurementFailedText(failure.target, failure.cause, failure.declaration),
  });

export const isTargetProbingError = (error: unknown): error is GatewayError => error instanceof GatewayError && isTargetProbing({ status: error.status, code: error.body.code });

export const probingOf = (error: GatewayError): Probing => {
  const measuring = measuringOfWire(error.body.measuring);
  if (measuring === undefined) throw new Error(`the answer ${TARGET_PROBING} carries no measuring state`);
  return { state: 'probing', message: error.body.message, retryAfterSeconds: Number(error.headers['retry-after']), measuring };
};

export const targetNotReadyError = (target: string, refusal: Extract<PreconditionVerdict, { kind: 'refused' }>): GatewayError =>
  new GatewayError({
    status: 412,
    type: 'invalid_request',
    code: TARGET_NOT_READY,
    message: [`the model "${target}" is not ready: ${refusal.message} (${refusal.detail})`, ...(refusal.remedy === undefined ? [] : [`remedy: ${refusal.remedy}`])].join('; '),
  });

export type ProbeEvent = { kind: 'failed' | 'stopped'; target: string; error: Error };

export type AutoProbeOptions = {
  redactor: Pick<Redactor, 'text'>;
  dir: string;
  lock: KernelLockMechanism;
  clock: Pick<Timing, 'now' | 'monotonicMs'>;
  timers: GatewayTimers;
  retryAfterMs: number;
  onEvent(event: ProbeEvent): void;
  role?: { current(): GenerationRole };
};

export type AutoProbe = {
  ensure<Key extends ProbeLockKey, Report>(subject: ProbeSubject<Key, Report>, key: Key): Promise<Probing>;
  openFlights(): number;
  close(): Promise<void>;
};

const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const NO_VERDICT = Symbol('no verdict');

type Flight = { done: Promise<void>; startedMs: number; ask: MeasuringAsk; step: { name: string; boundMs: number } | null };

export const createAutoProbe = (options: AutoProbeOptions): AutoProbe => {
  const flights = new Map<string, Flight>();
  const starting = new Map<string, Promise<void>>();
  const failures = new Map<string, ProbeFailure>();
  const stop = new AbortController();

  const measuringOf = (flight: Flight | undefined, ask: MeasuringAsk): Measuring => ({
    fields: [...ask.fields],
    step: flight?.step?.name ?? null,
    elapsedSeconds: flight === undefined ? 0 : Math.floor((options.clock.monotonicMs() - flight.startedMs) / MS_PER_SECOND),
    declaration: ask.declaration,
  });

  const probingFor = (flightName: string, ask: MeasuringAsk): Probing => {
    const flight = flights.get(flightName);
    const boundMs = flight?.step?.boundMs ?? options.retryAfterMs;
    return { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: Math.ceil(boundMs / MS_PER_SECOND), measuring: measuringOf(flight, ask) };
  };

  const admitsFlight = (name: string): boolean => !flights.has(name) && !stop.signal.aborted && options.role?.current() !== 'retiring';

  const verdictWithin = async (precondition: ProbePrecondition): Promise<PreconditionVerdict | typeof NO_VERDICT> => {
    const bound = options.timers.timeoutSignal(precondition.boundMs);
    const signal = AbortSignal.any([bound, stop.signal]);
    try {
      return await settledOrAborted(precondition.check(signal), signal);
    } catch (error) {
      if (bound.aborted || stop.signal.aborted) return NO_VERDICT;
      throw error;
    }
  };

  const startFlight = async <Key extends ProbeLockKey, Report>(subject: ProbeSubject<Key, Report>, key: Key, name: string): Promise<void> => {
    await ensurePrivateProbeDirectory(options.dir);
    if (!admitsFlight(name)) return;
    const flight: Flight = { done: Promise.resolve(), startedMs: options.clock.monotonicMs(), ask: subject.unknown, step: null };
    const progress: MeasurementProgress = {
      step: (stepName, boundMs) => {
        flight.step = { name: stepName, boundMs };
      },
    };
    const timing: LockWaitTiming = { now: () => options.clock.now(), monotonicMs: () => options.clock.monotonicMs(), setTimeout: options.timers.setTimeout, clearTimeout: options.timers.clearTimeout };
    const recorded = measureAndRecord(subject, { dir: options.dir, lock: options.lock, timing, lockWaitMs: options.retryAfterMs }, key, stop.signal, progress).then(
      () => undefined,
      (error: unknown) => {
        if (stop.signal.aborted) {
          options.onEvent({ kind: 'stopped', target: subject.target, error: errorOf(error) });
          return;
        }
        failures.set(name, probeFailureOf(error, subject.target, subject.unknown, options.redactor));
        options.onEvent({ kind: 'failed', target: subject.target, error: errorOf(error) });
      },
    );
    flight.done = recorded.finally(() => {
      flights.delete(name);
    });
    flights.set(name, flight);
  };

  return {
    ensure: async (subject, key) => {
      const name = identityOf(key);
      if (!admitsFlight(name)) return probingFor(name, subject.unknown);
      const pending = starting.get(name);
      if (pending !== undefined) {
        await pending;
        return probingFor(name, subject.unknown);
      }
      const verdict = await verdictWithin(subject.precondition);
      if (!admitsFlight(name)) return probingFor(name, subject.unknown);
      if (verdict !== NO_VERDICT && verdict.kind === 'refused') throw targetNotReadyError(subject.target, verdict);
      const failure = failures.get(name);
      if (failure !== undefined) throw targetProbeFailedError(failure);
      const already = starting.get(name);
      if (already !== undefined) {
        await already;
        return probingFor(name, subject.unknown);
      }
      const begun = startFlight(subject, key, name).finally(() => {
        starting.delete(name);
      });
      starting.set(name, begun);
      await begun;
      return probingFor(name, subject.unknown);
    },
    openFlights: () => new Set([...starting.keys(), ...flights.keys()]).size,
    close: async () => {
      stop.abort();
      await Promise.all([...starting.values(), ...[...flights.values()].map((flight) => flight.done)]);
    },
  };
};
