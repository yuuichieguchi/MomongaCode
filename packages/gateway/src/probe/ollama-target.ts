import { LOWEST_REASONING_EFFORT, imageCapability, maxOutputTokensFor } from '@momonga/protocol';
import type { Capabilities, ImageCapability, Probing } from '@momonga/protocol';
import { targetProbingError } from './auto-probe.ts';
import type { OllamaEndpointRecord } from './endpoint-record.ts';
import { resolveDialectId } from '../dialect/resolve-id.ts';
import { layerOf, mergeCapabilities } from './decide.ts';
import { jsonModeCapabilityOf } from './json-mode.ts';
import type { DeclaredCapabilities, DeclaredCore, WrittenCapabilities } from './decide.ts';
import { ReportedWindowMissingError } from './declared-window.ts';
import { memoizedVerification } from './endpoint-target.ts';
import { recordForIdentity } from './record.ts';
import type { MeasuringAsk } from './auto-probe.ts';
import { measuringAskOf, reportedLayerOf, sourcedCapabilities, unknownFieldsOf, writtenLayerFor } from './sources.ts';
import type { ReportedFields, ToolCallingDeclaration } from './sources.ts';

export type OllamaDeclaredCapabilities = Omit<DeclaredCore, 'contextWindow' | 'maxOutputTokens'> & (ImageCapability | { imageInput?: undefined; imageTokens?: undefined });

export const countedWindowOf = (statedWindow: number | undefined, reported: ReportedFields, recorded: number | undefined, display: string): number => {
  const contextWindow = statedWindow ?? reported.contextWindow ?? recorded;
  if (contextWindow === undefined) throw new ReportedWindowMissingError(display);
  return contextWindow;
};

export type ProbedOllamaTargetOptions = {
  displayOf: () => string;
  endpoint: string;
  model: string;
  declared: OllamaDeclaredCapabilities;
  written: WrittenCapabilities;
  toolCalling: ToolCallingDeclaration;
  record: OllamaEndpointRecord | null;
  readRecord: () => Promise<OllamaEndpointRecord | null>;
  readReported: () => Promise<ReportedFields>;
  startProbe: (ask: MeasuringAsk, contextWindow: number | undefined) => Promise<Probing>;
  readDigest: (signal: AbortSignal) => Promise<string | undefined>;
};

export type ProbedOllamaTarget = {
  capabilities: () => Promise<Capabilities>;
  verify: (signal: AbortSignal) => Promise<void>;
};

export const createProbedOllamaTarget = (options: ProbedOllamaTargetOptions): ProbedOllamaTarget => {
  const { written } = options;
  let { record } = options;
  let currentDigest: { known: false } | { known: true; digest: string | undefined } = { known: false };

  const usable = (found: OllamaEndpointRecord | null): OllamaEndpointRecord | null =>
    found === null || !currentDigest.known ? found : recordForIdentity(found, { identity: found.identity }, { identity: currentDigest.digest });

  let answered: ReportedFields | undefined;
  const readReported = async (): Promise<ReportedFields> => {
    if (answered !== undefined) return answered;
    const reported = await options.readReported();
    if (Object.keys(reported).length > 0) answered = reported;
    return reported;
  };

  const declaredFor = (reported: ReportedFields, recorded: number | undefined): DeclaredCapabilities => {
    const contextWindow = countedWindowOf(written.contextWindow, reported, recorded, options.displayOf());
    return { ...options.declared, contextWindow, maxOutputTokens: written.maxOutputTokens ?? maxOutputTokensFor(contextWindow) };
  };

  const measuring = async (reported: ReportedFields): Promise<never> => {
    throw targetProbingError(await options.startProbe(measuringAskOf(options.displayOf(), unknownFieldsOf({ toolCalling: options.toolCalling }, reported)), written.contextWindow ?? reported.contextWindow));
  };

  const fromSources = async (): Promise<Capabilities> => {
    const reported = await readReported();
    if (unknownFieldsOf({ toolCalling: options.toolCalling }, reported).length > 0) return measuring(reported);
    return sourcedCapabilities(declaredFor(reported, undefined), written, options.toolCalling, reported) ?? measuring(reported);
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
      const reported = await readReported();
      const { report } = record;
      const { core } = layerOf(declaredFor(reported, report.contextWindow.value));
      return mergeCapabilities({
        defaults: { ...core, schemaDialect: resolveDialectId(options.declared.schemaDialect, report) },
        declared: writtenLayerFor(written, options.toolCalling),
        reported: reportedLayerOf(reported),
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
