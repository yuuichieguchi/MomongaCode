import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ProcessLockHeldError, acquireProcessLock } from '@momonga/foundation';
import type { ProcessLock } from '@momonga/foundation';
import { TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { ProbeReport } from '@momonga/protocol';
import type { DialectCurrency } from '../dialect/candidates.ts';
import { GatewayError } from '../core/errors.ts';
import { probeTargetName, saveProbeRecord } from './record.ts';
import type { ProbeRecordKey } from './record.ts';
import { DEFAULT_STEP_TIMEOUT_MS } from './run-probe.ts';

const MS_PER_SECOND = 1000;
const LOCK_DIGEST_CHARS = 16;
const PRIVATE_DIRECTORY_MODE = 0o700;

export const PROBE_RETRY_AFTER_SECONDS = Math.ceil(DEFAULT_STEP_TIMEOUT_MS / MS_PER_SECOND);

export class ProbeInProgressError extends Error {
  constructor(key: ProbeRecordKey) {
    super(`the target "${key.target}" is already being measured (once per model and OS build); run the command again when it finishes`);
    this.name = 'ProbeInProgressError';
  }
}

export class ProbeKeyChangedError extends Error {
  constructor(before: ProbeRecordKey, after: ProbeRecordKey) {
    super(
      `the fm binary or the OS build changed while the target "${before.target}" was measured (from ${before.binarySha256} on ${before.osBuild} to ${after.binarySha256} on ${after.osBuild}), so the measurement was not recorded`,
    );
    this.name = 'ProbeKeyChangedError';
  }
}

const sameKey = (left: ProbeRecordKey, right: ProbeRecordKey): boolean =>
  left.target === right.target && left.binarySha256 === right.binarySha256 && left.osBuild === right.osBuild;

const keyDigest = (key: ProbeRecordKey): string =>
  createHash('sha256').update(`${key.binarySha256}\0${key.osBuild}`).digest('hex').slice(0, LOCK_DIGEST_CHARS);

export const probeLockPath = (dir: string, key: ProbeRecordKey): string => path.join(dir, `${probeTargetName(key.target)}.${keyDigest(key)}.lock`);

export const acquireProbeLock = async (dir: string, key: ProbeRecordKey): Promise<ProcessLock> => {
  await fs.promises.mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  try {
    return await acquireProcessLock(probeLockPath(dir, key));
  } catch (error) {
    if (error instanceof ProcessLockHeldError) throw new ProbeInProgressError(key);
    throw error;
  }
};

export type MeasureProbe = (request: { key: ProbeRecordKey; signal: AbortSignal }) => Promise<ProbeReport>;

export type RecordProbeOptions = {
  dir: string;
  readKey: () => Promise<ProbeRecordKey>;
  measure: MeasureProbe;
  currency: DialectCurrency;
  signal: AbortSignal;
};

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

type HeldProbe = { dir: string; key: ProbeRecordKey; lock: ProcessLock; readKey: () => Promise<ProbeRecordKey>; measure: MeasureProbe; currency: DialectCurrency; signal: AbortSignal };

const measureAndRecord = async (held: HeldProbe): Promise<ProbeReport> => {
  try {
    const report = await untilAborted(held.measure({ key: held.key, signal: held.signal }), held.signal);
    const after = await held.readKey();
    if (!sameKey(held.key, after)) throw new ProbeKeyChangedError(held.key, after);
    await saveProbeRecord(held.dir, held.key, report, held.currency);
    return report;
  } finally {
    held.lock.release();
  }
};

export const recordProbe = async (options: RecordProbeOptions): Promise<{ key: ProbeRecordKey; report: ProbeReport }> => {
  const key = await options.readKey();
  const lock = await acquireProbeLock(options.dir, key);
  return { key, report: await measureAndRecord({ ...options, key, lock }) };
};

export const targetProbingError = (): GatewayError =>
  new GatewayError({
    status: 503,
    type: 'server_error',
    code: TARGET_PROBING,
    message: TARGET_PROBING_MESSAGE,
    headers: { 'retry-after': String(PROBE_RETRY_AFTER_SECONDS) },
  });

export const isTargetProbing = (error: unknown): error is GatewayError => error instanceof GatewayError && error.body.code === TARGET_PROBING;

export type AutoProbe = { start(key: ProbeRecordKey): Promise<void>; close(): Promise<void> };

export type AutoProbeOptions = {
  dir: string;
  readKey: (target: string) => Promise<ProbeRecordKey>;
  measure: MeasureProbe;
  currencyOf: (target: string) => DialectCurrency;
  onFailure: (key: ProbeRecordKey, error: Error) => void;
};

const flightOf = (key: ProbeRecordKey): string => `${key.target}\0${key.binarySha256}\0${key.osBuild}`;

export const createAutoProbe = (options: AutoProbeOptions): AutoProbe => {
  const inFlight = new Map<string, Promise<void>>();
  const stop = new AbortController();
  const { signal } = stop;
  const startFlight = async (key: ProbeRecordKey): Promise<void> => {
    const lock = await acquireProbeLock(options.dir, key);
    const recorded = measureAndRecord({
      dir: options.dir,
      key,
      lock,
      readKey: () => options.readKey(key.target),
      measure: options.measure,
      currency: options.currencyOf(key.target),
      signal,
    });
    inFlight.set(
      flightOf(key),
      recorded.then(
        () => undefined,
        (error: unknown) => {
          options.onFailure(key, error instanceof Error ? error : new Error(String(error)));
        },
      ).finally(() => {
        inFlight.delete(flightOf(key));
      }),
    );
  };
  const starting = new Map<string, Promise<void>>();
  return {
    start: async (key) => {
      const flight = flightOf(key);
      if (inFlight.has(flight) || signal.aborted) return;
      const pending = starting.get(flight);
      if (pending !== undefined) return pending;
      const begun = startFlight(key)
        .catch((error: unknown) => {
          if (!(error instanceof ProbeInProgressError)) throw error;
        })
        .finally(() => {
          starting.delete(flight);
        });
      starting.set(flight, begun);
      return begun;
    },
    close: async () => {
      stop.abort();
      await Promise.all([...starting.values(), ...inFlight.values()]);
    },
  };
};
