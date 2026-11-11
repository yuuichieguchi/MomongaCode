import path from 'node:path';
import { isRecord, nodeFileSystem } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { WORDS } from '@momonga/protocol';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';
import { endpointRecordFileName } from './endpoint-record.ts';
import type { EndpointKey } from './endpoint-record.ts';
import { writePrivateRecord } from './record.ts';
import { probeCommandOf, unusableRecordError } from './remedy.ts';
import { measurementBoundOf } from './run-probe.ts';
import type { ProbePrecondition } from './auto-probe.ts';

export type MeasurementBound = { readonly requests: number; readonly inputTokens: number; readonly outputTokens: number };

export type MeteredMeasurement = { readonly display: string; readonly declaredContextWindow: number };

export const consentCommandOf = (display: string): string => `${probeCommandOf(display)} --yes`;

export class MeasurementConsentRequiredError extends PreconditionFailedError {
  constructor(display: string, bound: MeasurementBound) {
    super(
      `the ${WORDS.model} "${display}" is paid for by use, so it is measured only with your consent: the measurement sends at most ${bound.requests} requests, ${bound.inputTokens} input tokens and ${bound.outputTokens} output tokens; run \`${consentCommandOf(display)}\` to allow it`,
      'no consent to measure it is recorded for this bound',
      `run \`${consentCommandOf(display)}\``,
    );
    this.name = 'MeasurementConsentRequiredError';
  }
}

export class MeasurementBoundReachedError extends Error {
  constructor(display: string, bound: MeasurementBound) {
    super(`the measurement of the ${WORDS.model} "${display}" reached the bound it has consent for (${bound.requests} requests, ${bound.inputTokens} input tokens, ${bound.outputTokens} output tokens) and stopped`);
    this.name = 'MeasurementBoundReachedError';
  }
}

export const measurementConsentPath = (dir: string, key: EndpointKey): string => path.join(dir, `consent-${endpointRecordFileName(key)}`);

export const saveMeasurementConsent = async (dir: string, key: EndpointKey, bound: MeasurementBound, lock: KernelLockMechanism): Promise<void> => {
  await writePrivateRecord(dir, measurementConsentPath(dir, key), JSON.stringify({ endpoint: key.endpoint, model: key.model, ...bound }), lock);
};

export const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const loadMeasurementConsent = async (dir: string, key: EndpointKey): Promise<MeasurementBound | undefined> => {
  const file = measurementConsentPath(dir, key);
  const raw = await nodeFileSystem.readTextFile(file).catch((error: unknown) => {
    if (isRecord(error) && error['code'] === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw unusableRecordError(file, key.model, 'not valid JSON', error);
  }
  if (!isRecord(parsed) || parsed['endpoint'] !== key.endpoint || parsed['model'] !== key.model) throw unusableRecordError(file, key.model, 'it belongs to another server or model');
  const { requests, inputTokens, outputTokens } = parsed;
  if (!isCount(requests) || !isCount(inputTokens) || !isCount(outputTokens)) throw unusableRecordError(file, key.model, 'the consented bound is not three counts');
  return { requests, inputTokens, outputTokens };
};

export const consentCovers = (consent: MeasurementBound | undefined, bound: MeasurementBound): boolean =>
  consent !== undefined && consent.requests >= bound.requests && consent.inputTokens >= bound.inputTokens && consent.outputTokens >= bound.outputTokens;

export type BillingOfTarget = { readonly billing: string; readonly apiKeyEnv?: string; readonly apiKeySecret?: string };

export const isMeteredTarget = (target: BillingOfTarget): boolean => target.billing === 'metered' || target.apiKeyEnv !== undefined || target.apiKeySecret !== undefined;

export const meteredPrecondition = (precondition: ProbePrecondition, dir: string, key: EndpointKey, metered: MeteredMeasurement, samples: number): ProbePrecondition => ({
  boundMs: precondition.boundMs,
  check: async (signal) => {
    const verdict = await precondition.check(signal);
    if (verdict.kind === 'refused') return verdict;
    const bound = measurementBoundOf(metered.declaredContextWindow, samples);
    if (consentCovers(await loadMeasurementConsent(dir, key), bound)) return verdict;
    const refusal = new MeasurementConsentRequiredError(metered.display, bound);
    return { kind: 'refused', message: refusal.message, detail: refusal.detail ?? '', remedy: refusal.remediation };
  },
});

export const requireMeasurementConsent = async (dir: string, key: EndpointKey, metered: MeteredMeasurement, samples: number): Promise<MeasurementBound> => {
  const bound = measurementBoundOf(metered.declaredContextWindow, samples);
  if (!consentCovers(await loadMeasurementConsent(dir, key), bound)) throw new MeasurementConsentRequiredError(metered.display, bound);
  return bound;
};

