import { createHash } from 'node:crypto';
import path from 'node:path';
import { ProcessLockHeldError, acquireProcessLock, canonicalJson } from '@momonga/foundation';
import type { ProcessLock } from '@momonga/foundation';
import { TARGET_NOT_READY, TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { Probing } from '@momonga/protocol';
import { GatewayError } from '../core/errors.ts';
import { ensurePrivateProbeDirectory, probeTargetName } from './record.ts';
import { DEFAULT_STEP_TIMEOUT_MS } from './run-probe.ts';

const MS_PER_SECOND = 1000;
const LOCK_DIGEST_CHARS = 16;

export const PROBE_RETRY_AFTER_MS = Math.ceil(DEFAULT_STEP_TIMEOUT_MS / MS_PER_SECOND) * MS_PER_SECOND;

export const PROBE_RETRY_AFTER_SECONDS = PROBE_RETRY_AFTER_MS / MS_PER_SECOND;

export type ProbeLockKey = { readonly target: string } & Readonly<Record<string, string>>;

export class ProbeInProgressError extends Error {
  constructor(key: ProbeLockKey) {
    super(`the target "${key.target}" is already being measured (once per model and OS build); run the command again when it finishes`);
    this.name = 'ProbeInProgressError';
  }
}

export class ProbeKeyChangedError extends Error {
  constructor(before: ProbeLockKey, after: ProbeLockKey) {
    super(`the identity of the target "${before.target}" changed while it was measured (from ${canonicalJson(before)} to ${canonicalJson(after)}), so the measurement was not recorded`);
    this.name = 'ProbeKeyChangedError';
  }
}

const identityOf = (key: ProbeLockKey): string => canonicalJson(key);

const keyDigest = (key: ProbeLockKey): string => createHash('sha256').update(identityOf(key)).digest('hex').slice(0, LOCK_DIGEST_CHARS);

export const probeLockPath = (dir: string, key: ProbeLockKey): string => path.join(dir, `${probeTargetName(key.target)}.${keyDigest(key)}.lock`);

export const acquireProbeLock = async (dir: string, key: ProbeLockKey): Promise<ProcessLock> => {
  const lockPath = probeLockPath(dir, key);
  await ensurePrivateProbeDirectory(dir);
  try {
    return await acquireProcessLock(lockPath);
  } catch (error) {
    if (error instanceof ProcessLockHeldError) throw new ProbeInProgressError(key);
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

const measureAndRecord = async <Key extends ProbeLockKey, Report>(subject: ProbeSubject<Key, Report>, key: Key, lock: ProcessLock, signal: AbortSignal): Promise<Report> => {
  try {
    const report = await untilAborted(subject.measure({ key, signal }), signal);
    const after = await subject.readKey();
    if (!sameKey(key, after)) throw new ProbeKeyChangedError(key, after);
    await subject.save(key, report);
    return report;
  } finally {
    lock.release();
  }
};

export const recordProbe = async <Key extends ProbeLockKey, Report>(subject: ProbeSubject<Key, Report>, dir: string, signal: AbortSignal): Promise<{ key: Key; report: Report }> => {
  const key = await subject.readKey();
  const lock = await acquireProbeLock(dir, key);
  return { key, report: await measureAndRecord(subject, key, lock, signal) };
};

export const targetProbingError = (probing: Probing): GatewayError =>
  new GatewayError({
    status: 503,
    type: 'server_error',
    code: TARGET_PROBING,
    message: probing.message,
    headers: { 'retry-after': String(probing.retryAfterSeconds) },
  });

export const isTargetProbing = (error: unknown): error is GatewayError => error instanceof GatewayError && error.body.code === TARGET_PROBING;

export const probingOf = (error: GatewayError): Probing => ({ state: 'probing', message: error.body.message, retryAfterSeconds: Number(error.headers['retry-after']) });

export const targetNotReadyError = (target: string, refusal: Extract<PreconditionVerdict, { kind: 'refused' }>): GatewayError =>
  new GatewayError({
    status: 412,
    type: 'invalid_request',
    code: TARGET_NOT_READY,
    message: [`the target "${target}" is not ready: ${refusal.message} (${refusal.detail})`, ...(refusal.remedy === undefined ? [] : [`remedy: ${refusal.remedy}`])].join('; '),
  });

export type ProbeEvent = { kind: 'failed' | 'stopped'; target: string; error: Error };

export type AutoProbeOptions = {
  dir: string;
  clock: { now(): number };
  retryAfterMs: number;
  onEvent(event: ProbeEvent): void;
};

export type AutoProbe = {
  ensure<Key extends ProbeLockKey, Report>(subject: ProbeSubject<Key, Report>, key: Key): Promise<Probing>;
  close(): Promise<void>;
};

const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const BOUND_EXPIRED = Symbol('bound expired');

export const createAutoProbe = (options: AutoProbeOptions): AutoProbe => {
  const inFlight = new Map<string, Promise<void>>();
  const starting = new Map<string, Promise<void>>();
  const backoffUntil = new Map<string, number>();
  const stop = new AbortController();
  const probing = (retryAfterMs: number): Probing => ({ state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: Math.ceil(retryAfterMs / MS_PER_SECOND) });

  const verdictWithin = async (precondition: ProbePrecondition): Promise<PreconditionVerdict | typeof BOUND_EXPIRED> => {
    const bound = AbortSignal.timeout(precondition.boundMs);
    const signal = AbortSignal.any([bound, stop.signal]);
    try {
      return await untilAborted(precondition.check(signal), signal);
    } catch (error) {
      if (bound.aborted && !stop.signal.aborted) return BOUND_EXPIRED;
      throw error;
    }
  };

  const startFlight = async <Key extends ProbeLockKey, Report>(subject: ProbeSubject<Key, Report>, key: Key, flight: string): Promise<void> => {
    const lock = await acquireProbeLock(options.dir, key);
    const recorded = measureAndRecord(subject, key, lock, stop.signal).then(
      () => undefined,
      (error: unknown) => {
        if (stop.signal.aborted) {
          options.onEvent({ kind: 'stopped', target: subject.target, error: errorOf(error) });
          return;
        }
        backoffUntil.set(flight, options.clock.now() + options.retryAfterMs);
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
      const until = backoffUntil.get(flight);
      if (until !== undefined) {
        const remaining = until - options.clock.now();
        if (remaining > 0) return probing(remaining);
        backoffUntil.delete(flight);
      }
      if (inFlight.has(flight) || stop.signal.aborted) return probing(options.retryAfterMs);
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
      const begun = startFlight(subject, key, flight)
        .catch((error: unknown) => {
          if (!(error instanceof ProbeInProgressError)) throw error;
        })
        .finally(() => {
          starting.delete(flight);
        });
      starting.set(flight, begun);
      await begun;
      return probing(options.retryAfterMs);
    },
    close: async () => {
      stop.abort();
      await Promise.all([...starting.values(), ...inFlight.values()]);
    },
  };
};
