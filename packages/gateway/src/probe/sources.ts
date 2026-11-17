import { LOWEST_REASONING_EFFORT, WORDS, imageCapability } from '@momonga/protocol';
import type { Capabilities, DetectedModel, ToolCallingMode } from '@momonga/protocol';
import { readModelDetails } from '../detect-local-servers.ts';
import type { DetailsAsk, ModelDetails } from '../detect-local-servers.ts';
import { withImageDefault, writtenLayerOf } from './decide.ts';
import type { CapabilityLayer, DeclaredCapabilities, WrittenCapabilities } from './decide.ts';
import type { MeasuringAsk } from './auto-probe.ts';

export type SourceField = 'toolCalling' | 'contextWindow';

export type ReportedFields = { toolCalling?: ToolCallingMode; contextWindow?: number; thinking?: boolean; vision?: boolean };

export type ToolCallingDeclaration = ToolCallingMode | 'auto';

export const NOTHING_REPORTED: ReportedFields = {};

export const reportedLayerOf = (reported: ReportedFields): CapabilityLayer => ({
  ...(reported.toolCalling === undefined ? {} : { toolCalling: reported.toolCalling }),
  ...(reported.contextWindow === undefined ? {} : { contextWindow: reported.contextWindow }),
  ...(reported.thinking === undefined ? {} : { reasoning: reported.thinking ? { control: 'reasoning_effort', lowest: LOWEST_REASONING_EFFORT } : { control: 'none' } }),
  ...(reported.vision === false ? { image: imageCapability(false, undefined) } : {}),
});

export const writtenLayerFor = (written: WrittenCapabilities, toolCalling: ToolCallingDeclaration): CapabilityLayer => {
  const layer = writtenLayerOf(written);
  return toolCalling === 'auto' ? layer : { ...layer, toolCalling };
};

export const reportedFieldsOf = (details: ModelDetails | undefined): ReportedFields => {
  if (details === undefined) return {};
  return {
    ...(details.tools === 'unknown' ? {} : { toolCalling: details.tools === 'yes' ? 'native' : 'none' }),
    ...(details.window === undefined ? {} : { contextWindow: details.window }),
    ...(details.capabilities === undefined ? {} : { thinking: details.capabilities.includes('thinking'), vision: details.capabilities.includes('vision') }),
  };
};

export const readReportedFields = async (ask: DetailsAsk, details: Parameters<typeof readModelDetails>[1], model: string): Promise<ReportedFields> => reportedFieldsOf(await readModelDetails(ask, details, model));

export const unknownFieldsOf = (declared: { toolCalling: ToolCallingDeclaration }, reported: ReportedFields): readonly SourceField[] =>
  declared.toolCalling === 'auto' && reported.toolCalling === undefined ? ['toolCalling'] : [];

export const declarationOf = (targetName: string, fields: readonly SourceField[]): string => `declare ${fields.join(' and ')} for the ${WORDS.model} "${targetName}" in its settings`;

export const measuringAskOf = (targetName: string, fields: readonly SourceField[]): MeasuringAsk => ({ fields, declaration: declarationOf(targetName, fields) });

export const sourcedCapabilities = (defaults: DeclaredCapabilities, written: WrittenCapabilities, toolCalling: ToolCallingDeclaration, reported: ReportedFields): Capabilities | undefined => {
  if (unknownFieldsOf({ toolCalling }, reported).length > 0) return undefined;
  const mode = toolCalling === 'auto' ? reported.toolCalling : toolCalling;
  if (mode === undefined) return undefined;
  const { image, ...layers } = { ...reportedLayerOf(reported), ...writtenLayerFor(written, toolCalling) };
  const { imageInput: _input, imageTokens: _tokens, ...base } = withImageDefault(defaults);
  return { ...base, ...layers, ...(image ?? imageCapability(false, undefined)), toolCalling: mode, source: toolCalling === 'auto' ? 'reported' : 'declared' };
};

export const reportedWindowOf = (model: DetectedModel): number | undefined => model.contextWindow ?? model.ceiling;
