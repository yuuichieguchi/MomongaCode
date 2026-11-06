import { LOWEST_REASONING_EFFORT, imageCapability } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';
import type { OllamaEndpointRecord } from './endpoint-record.ts';
import { resolveDialectId } from '../dialect/resolve-id.ts';
import { layerOf, mergeCapabilities, withImageDefault } from './decide.ts';
import { jsonModeCapabilityOf } from './json-mode.ts';
import type { DeclaredCapabilities } from './decide.ts';
import { memoizedVerification } from './endpoint-target.ts';
import { needsProbeOf, preconditionOf, remedyOf } from './remedy.ts';

export type ProbedOllamaTargetOptions = {
  targetName: string;
  endpoint: string;
  model: string;
  declared: DeclaredCapabilities;
  record: OllamaEndpointRecord | null;
  readDigest: (signal: AbortSignal) => Promise<string | undefined>;
};

export type ProbedOllamaTarget = {
  capabilities: () => Promise<Capabilities>;
  verify: (signal: AbortSignal) => Promise<void>;
};

export const createProbedOllamaTarget = (options: ProbedOllamaTargetOptions): ProbedOllamaTarget => {
  const { targetName, endpoint, model, declared, record } = options;
  const declaredParts = layerOf(declared);
  const needsProbe = needsProbeOf(
    targetName,
    `the ollama target "${targetName}" has no probe record`,
    `no record for ${endpoint} and model ${model}`,
  );

  const verifyOnce = async (signal: AbortSignal): Promise<void> => {
    if (record === null) throw preconditionOf(needsProbe);
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
      if (record === null) return { ...withImageDefault(declared), toolCalling: needsProbe, source: 'unprobed' };
      const { report } = record;
      return mergeCapabilities({
        defaults: { ...declaredParts.core, schemaDialect: resolveDialectId(declared.schemaDialect, report) },
        declared: declaredParts.layer,
        probed: {
          toolCalling: report.nativeTools.accepted ? 'native' : 'none',
          image: report.imageInputAccepted && report.imageTokens !== undefined ? imageCapability(true, report.imageTokens) : imageCapability(false, undefined),
          reasoning: report.thinkingSupported ? { control: 'reasoning_effort', lowest: LOWEST_REASONING_EFFORT } : { control: 'none' },
          ...(report.promptCache === undefined ? {} : { promptCache: report.promptCache }),
          ...jsonModeCapabilityOf(report.jsonMode),
        },
        probedAt: report.probedAt,
      });
    },
  };
};
