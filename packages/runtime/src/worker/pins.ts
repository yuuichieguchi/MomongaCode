import type { Capabilities } from '@momonga/protocol';
import { isRecord } from './json.ts';

export type RunPins = {
  modelAlias: string;
  systemPromptDigest: string;
  toolSetDigest: string;
  capabilities: Capabilities;
  memoryShare?: number;
  guidelineVersion?: number;
};

const isCapabilities = (value: unknown): value is Capabilities =>
  isRecord(value) &&
  typeof value['contextWindow'] === 'number' &&
  typeof value['maxOutputTokens'] === 'number' &&
  typeof value['parallelToolCalls'] === 'boolean' &&
  typeof value['streaming'] === 'boolean' &&
  typeof value['tokenCounting'] === 'string' &&
  typeof value['toolCalling'] === 'string';

export const readPins = (value: Record<string, unknown>): RunPins => {
  const { modelAlias, systemPromptDigest, toolSetDigest, capabilities, memoryShare, guidelineVersion } = value;
  if (
    typeof modelAlias !== 'string' ||
    typeof systemPromptDigest !== 'string' ||
    typeof toolSetDigest !== 'string' ||
    !isCapabilities(capabilities) ||
    (memoryShare !== undefined && typeof memoryShare !== 'number') ||
    (guidelineVersion !== undefined && (typeof guidelineVersion !== 'number' || !Number.isInteger(guidelineVersion) || guidelineVersion < 1))
  ) {
    throw new Error('the pins recorded for this run are malformed');
  }
  return {
    modelAlias,
    systemPromptDigest,
    toolSetDigest,
    capabilities,
    ...(memoryShare === undefined ? {} : { memoryShare }),
    ...(guidelineVersion === undefined ? {} : { guidelineVersion }),
  };
};
