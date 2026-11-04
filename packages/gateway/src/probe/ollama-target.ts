import type { Capabilities } from '@momonga/protocol';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';
import type { OllamaEndpointRecord } from './endpoint-record.ts';
import { memoizedVerification, remedyOf } from './endpoint-target.ts';

export type ProbedOllamaTargetOptions = {
  targetName: string;
  endpoint: string;
  model: string;
  declared: Capabilities;
  record: OllamaEndpointRecord | null;
  readDigest: (signal: AbortSignal) => Promise<string | undefined>;
};

export type ProbedOllamaTarget = {
  capabilities: () => Promise<Capabilities>;
  verify: (signal: AbortSignal) => Promise<void>;
};

export const createProbedOllamaTarget = (options: ProbedOllamaTargetOptions): ProbedOllamaTarget => {
  const { targetName, endpoint, model, declared, record } = options;

  const verifyOnce = async (signal: AbortSignal): Promise<void> => {
    if (record === null) {
      throw new PreconditionFailedError(
        `the ollama target "${targetName}" has no probe record`,
        `no record for ${endpoint} and model ${model}`,
        remedyOf(targetName),
      );
    }
    const digest = await options.readDigest(signal);
    if (digest !== record.identity) {
      throw new PreconditionFailedError(
        `the probe record of the target "${targetName}" is stale`,
        `the server at ${endpoint} now reports ${digest === undefined ? 'no digest' : 'a different digest'} for model ${model} than when it was probed`,
        remedyOf(targetName),
      );
    }
  };

  return {
    verify: memoizedVerification(verifyOnce),
    capabilities: async () => {
      if (record === null) return { ...declared, source: 'unprobed' };
      return {
        ...declared,
        toolCalling: record.report.nativeTools.accepted ? 'native' : 'none',
        source: 'probed',
        probedAt: record.report.probedAt,
      };
    },
  };
};
