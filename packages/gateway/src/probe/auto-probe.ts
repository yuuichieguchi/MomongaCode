import { createHash } from 'node:crypto';
import path from 'node:path';
import { POLL_INTERVAL_MS, ProcessLockHeldError, acquireProcessLock, canonicalJson, cleanFailureMessage, sleep } from '@momonga/foundation';
import type { GenerationRole, ProcessLock, KernelLockMechanism } from '@momonga/foundation';
import { SERVICE_UNAVAILABLE_STATUS, TARGET_NOT_READY, TARGET_PROBE_FAILED, TARGET_PROBING, TARGET_PROBING_MESSAGE, isTargetProbing } from '@momonga/protocol';
import type { Probing } from '@momonga/protocol';
import { GatewayError } from '../core/errors.ts';
import type { GatewayTimers } from '../types.ts';
import type { ProbeTimers } from './client.ts';
import { ensurePrivateProbeDirectory } from './record.ts';
import { DEFAULT_STEP_TIMEOUT_MS } from './run-probe.ts';

const MS_PER_SECOND = 1000;
const KEY_LOCK_POLL_INTERVAL_MS = POLL_INTERVAL_MS;
const LOCK_DIGEST_CHARS = 16;

export const PROBE_RETRY_AFTER_MS = Math.ceil(DEFAULT_STEP_TIMEOUT_MS / MS_PER_SECOND) * MS_PER_SECOND;

export const PROBE_RETRY_AFTER_SECONDS = PROBE_RETRY_AFTER_MS / MS_PER_SECOND;

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

export type ProbeSubject<Key extends ProbeLockKey, Report> = {
  target: string;
  readKey(): Promise<Key>;
  precondition: ProbePrecondition;
  measure(request: { key: Key; signal: AbortSignal }): Promise<Report>;
  save(key: Key, report: Report): Promise<void>;
};

export type MeasureProbe<Key extends ProbeLockKey, Report> = ProbeSubject<Key, Report>['measure'];

const untilAborted = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });

const sameKey = (left: ProbeLockKey, right: ProbeLockKey): boolean => identityOf(left) === identityOf(right);

const holdProbeLock = async (dir: string, key: ProbeLockKey, target: string, lock: KernelLockMechanism, timers: ProbeTimers, signal: AbortSignal): Promise<ProcessLock> => {
  for (;;) {
    signal.throwIfAborted();
    try {
      return await acquireProbeLock(dir, key, target, lock);
    } catch (error) {
      if (!(error instanceof ProbeInProgressError)) throw error;
    }
    await sleep(timers, KEY_LOCK_POLL_INTERVAL_MS, signal);
  }
};

const measureAndRecord = async <Key extends ProbeLockKey, Report>(subject: ProbeSubject<Key, Report>, dir: string, kernelLock: KernelLockMechanism, timers: ProbeTimers, key: Key, signal: AbortSignal): Promise<Report> => {
  const report = await untilAborted(subject.measure({ key, signal }), signal);
  const lock = await holdProbeLock(dir, key, subject.target, kernelLock, timers, signal);
  try {
    const after = await subject.readKey();
    if (!sameKey(key, after)) throw new ProbeKeyChangedError(subject.target, key, after);
    await subject.save(key, report);
    return report;
  } finally {
    lock.release();
  }
};

export const recordProbe = async <Key extends ProbeLockKey, Report>(subject: ProbeSubject<Key, Report>, dir: string, lock: KernelLockMechanism, timers: ProbeTimers, signal: AbortSignal): Promise<{ key: Key; report: Report }> => {
  const key = await subject.readKey();
  return { key, report: await measureAndRecord(subject, dir, lock, timers, key, signal) };
};

export const targetProbingError = (probing: Probing): GatewayError =>
  new GatewayError({
    status: SERVICE_UNAVAILABLE_STATUS,
    type: 'server_error',
    code: TARGET_PROBING,
    message: probing.message,
    headers: { 'retry-after': String(probing.retryAfterSeconds) },
  });

export type ProbeBackoff = { until: number; cause: string };

export const probeBackoffOf = (error: unknown, until: number): ProbeBackoff => ({ until, cause: cleanFailureMessage(error instanceof Error ? error.message : String(error)) });

export const targetProbeFailedError = (backoff: ProbeBackoff, remainingMs: number): GatewayError =>
  new GatewayError({
    status: SERVICE_UNAVAILABLE_STATUS,
    type: 'server_error',
    code: TARGET_PROBE_FAILED,
    message: `measuring this model failed: ${backoff.cause}`,
    headers: { 'retry-after': String(Math.ceil(remainingMs / MS_PER_SECOND)) },
  });

export const isTargetProbingError = (error: unknown): error is GatewayError => error instanceof GatewayError && isTargetProbing({ status: error.status, code: error.body.code });

export const probingOf = (error: GatewayError): Probing => ({ state: 'probing', message: error.body.message, retryAfterSeconds: Number(error.headers['retry-after']) });

export const targetNotReadyError = (target: string, refusal: Extract<PreconditionVerdict, { kind: 'refused' }>): GatewayError =>
  new GatewayError({
    status: 412,
    type: 'invalid_request',
    code: TARGET_NOT_READY,
    message: [`the model "${target}" is not ready: ${refusal.message} (${refusal.detail})`, ...(refusal.remedy === undefined ? [] : [`remedy: ${refusal.remedy}`])].join('; '),
  });

export type ProbeEvent = { kind: 'failed' | 'stopped'; target: string; error: Error };

export type AutoProbeOptions = {
  dir: string;
  lock: KernelLockMechanism;
  clock: { now(): number };
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

const BOUND_EXPIRED = Symbol('bound expired');

export const createAutoProbe = (options: AutoProbeOptions): AutoProbe => {
  const inFlight = new Map<string, Promise<void>>();
  const starting = new Map<string, Promise<void>>();
  const backoffs = new Map<string, ProbeBackoff>();
  const stop = new AbortController();
  const probing = (retryAfterMs: number): Probing => ({ state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: Math.ceil(retryAfterMs / MS_PER_SECOND) });

  const verdictWithin = async (precondition: ProbePrecondition): Promise<PreconditionVerdict | typeof BOUND_EXPIRED> => {
    const bound = options.timers.timeoutSignal(precondition.boundMs);
    const signal = AbortSignal.any([bound, stop.signal]);
    try {
      return await untilAborted(precondition.check(signal), signal);
    } catch (error) {
      if (bound.aborted && !stop.signal.aborted) return BOUND_EXPIRED;
      throw error;
    }
  };

  const startFlight = async <Key extends ProbeLockKey, Report>(subject: ProbeSubject<Key, Report>, key: Key, flight: string): Promise<void> => {
    await ensurePrivateProbeDirectory(options.dir);
    const recorded = measureAndRecord(subject, options.dir, options.lock, options.timers, key, stop.signal).then(
      () => undefined,
      (error: unknown) => {
        if (stop.signal.aborted) {
          options.onEvent({ kind: 'stopped', target: subject.target, error: errorOf(error) });
          return;
        }
        backoffs.set(flight, probeBackoffOf(error, options.clock.now() + options.retryAfterMs));
        options.onEvent({ kind: 'failed', target: subject.target, error: errorOf(error) });
      },
    );
    inFlight.set(
      flight,
      recorded.finally(() => {
        inFlight.delete(flight);
      }),
    );
  };

  return {
    ensure: async (subject, key) => {
      const flight = identityOf(key);
      const backoff = backoffs.get(flight);
      if (backoff !== undefined) {
        const remaining = backoff.until - options.clock.now();
        if (remaining > 0) throw targetProbeFailedError(backoff, remaining);
        backoffs.delete(flight);
      }
      if (inFlight.has(flight) || stop.signal.aborted || options.role?.current() === 'retiring') return probing(options.retryAfterMs);
      const pending = starting.get(flight);
      if (pending !== undefined) {
        await pending;
        return probing(options.retryAfterMs);
      }
      const verdict = await verdictWithin(subject.precondition);
      if (verdict !== BOUND_EXPIRED && verdict.kind === 'refused') throw targetNotReadyError(subject.target, verdict);
      if (inFlight.has(flight)) return probing(options.retryAfterMs);
      const already = starting.get(flight);
      if (already !== undefined) {
        await already;
        return probing(options.retryAfterMs);
      }
      const begun = startFlight(subject, key, flight).finally(() => {
        starting.delete(flight);
      });
      starting.set(flight, begun);
      await begun;
      return probing(options.retryAfterMs);
    },
    openFlights: () => new Set([...starting.keys(), ...inFlight.keys()]).size,
    close: async () => {
      stop.abort();
      await Promise.all([...starting.values(), ...inFlight.values()]);
    },
  };
};
