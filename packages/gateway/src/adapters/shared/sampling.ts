import { SAMPLING_FIELDS } from '@momonga/protocol';
import type { AdapterRequest, AdapterSampling, SamplingField } from '@momonga/protocol';

export const RENDERS_EVERY_SAMPLING_FIELD: AdapterSampling = { renders: SAMPLING_FIELDS };

export const carriedSamplingOf = (request: AdapterRequest): Partial<Record<SamplingField, number>> =>
  Object.fromEntries(SAMPLING_FIELDS.flatMap((field) => (request[field] === undefined || request[field] === null ? [] : [[field, request[field]]])));
