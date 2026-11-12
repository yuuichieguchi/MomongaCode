import { WORDS } from '@momonga/protocol';
import type { Capabilities, DetectedModel, ToolCallingMode } from '@momonga/protocol';
import { readModelDetails } from '../detect-local-servers.ts';
import type { DetailsAsk, ModelDetails } from '../detect-local-servers.ts';
import { withImageDefault } from './decide.ts';
import type { DeclaredCapabilities } from './decide.ts';
import type { MeasuringAsk } from './auto-probe.ts';

export type SourceField = 'toolCalling' | 'contextWindow';

export type ReportedFields = { toolCalling?: ToolCallingMode; contextWindow?: number };

export type ToolCallingDeclaration = ToolCallingMode | 'auto';

export const NOTHING_REPORTED: ReportedFields = {};

export const reportedFieldsOf = (details: ModelDetails | undefined): ReportedFields => {
  if (details === undefined) return {};
  return {
    ...(details.tools === 'unknown' ? {} : { toolCalling: details.tools === 'yes' ? 'native' : 'none' }),
    ...(details.window === undefined ? {} : { contextWindow: details.window }),
  };
};

export const readReportedFields = async (ask: DetailsAsk, details: Parameters<typeof readModelDetails>[1], model: string): Promise<ReportedFields> => reportedFieldsOf(await readModelDetails(ask, details, model));

export const unknownFieldsOf = (declared: { toolCalling: ToolCallingDeclaration }, reported: ReportedFields): readonly SourceField[] =>
  declared.toolCalling === 'auto' && reported.toolCalling === undefined ? ['toolCalling'] : [];

export const declarationOf = (targetName: string, fields: readonly SourceField[]): string => `declare ${fields.join(' and ')} for the ${WORDS.model} "${targetName}" in its settings`;

export const measuringAskOf = (targetName: string, fields: readonly SourceField[]): MeasuringAsk => ({ fields, declaration: declarationOf(targetName, fields) });

export const sourcedCapabilities = (declared: DeclaredCapabilities, toolCalling: ToolCallingDeclaration, reported: ReportedFields): Capabilities | undefined => {
  if (unknownFieldsOf({ toolCalling }, reported).length > 0) return undefined;
  const mode = toolCalling === 'auto' ? reported.toolCalling : toolCalling;
  if (mode === undefined) return undefined;
  return { ...withImageDefault(declared), toolCalling: mode, source: toolCalling === 'auto' ? 'reported' : 'declared' };
};

export const reportedWindowOf = (model: DetectedModel): number | undefined => model.contextWindow ?? model.ceiling;
