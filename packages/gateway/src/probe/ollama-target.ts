import { LOWEST_REASONING_EFFORT, imageCapability } from '@momonga/protocol';
import type { Capabilities, Probing } from '@momonga/protocol';
import { targetProbingError } from './auto-probe.ts';
import type { OllamaEndpointRecord } from './endpoint-record.ts';
import { resolveDialectId } from '../dialect/resolve-id.ts';
import { layerOf, mergeCapabilities, withImageDefault } from './decide.ts';
import { jsonModeCapabilityOf } from './json-mode.ts';
import type { DeclaredCapabilities } from './decide.ts';
import { memoizedVerification } from './endpoint-target.ts';
import { recordForIdentity } from './record.ts';
import type { MeasuringAsk } from './auto-probe.ts';
import { measuringAskOf, sourcedCapabilities, unknownFieldsOf } from './sources.ts';
import type { ReportedFields, ToolCallingDeclaration } from './sources.ts';

export type ProbedOllamaTargetOptions = {
  targetName: string;
  endpoint: string;
  model: string;
  declared: DeclaredCapabilities;
  toolCalling: ToolCallingDeclaration;
  record: OllamaEndpointRecord | null;
  readRecord: () => Promise<OllamaEndpointRecord | null>;
  readReported: () => Promise<ReportedFields>;
  startProbe: (ask: MeasuringAsk) => Promise<Probing>;
  readDigest: (signal: AbortSignal) => Promise<string | undefined>;
};

export type ProbedOllamaTarget = {
  capabilities: () => Promise<Capabilities>;
  verify: (signal: AbortSignal) => Promise<void>;
};

export const createProbedOllamaTarget = (options: ProbedOllamaTargetOptions): ProbedOllamaTarget => {
  const { declared } = options;
  let { record } = options;
  const declaredParts = layerOf(declared);
  let currentDigest: { known: false } | { known: true; digest: string | undefined } = { known: false };

  const usable = (found: OllamaEndpointRecord | null): OllamaEndpointRecord | null =>
    found === null || !currentDigest.known ? found : recordForIdentity(found, { identity: found.identity }, { identity: currentDigest.digest });

  let reportedOnce: ReportedFields | undefined;
  const fromSources = async (): Promise<Capabilities> => {
    reportedOnce ??= await options.readReported();
    const reported = reportedOnce;
    const served = sourcedCapabilities(declared, options.toolCalling, reported);
    if (served !== undefined) return served;
    throw targetProbingError(await options.startProbe(measuringAskOf(options.targetName, unknownFieldsOf({ toolCalling: options.toolCalling }, reported))));
  };

  const verifyOnce = async (signal: AbortSignal): Promise<void> => {
    const found = await options.readRecord();
    currentDigest = { known: false };
    if (found !== null) currentDigest = { known: true, digest: await options.readDigest(signal) };
    record = usable(found);
    if (record === null) await fromSources();
  };

  return {
    verify: memoizedVerification(verifyOnce),
    capabilities: async () => {
      record = usable(await options.readRecord());
      if (record === null) return fromSources();
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
