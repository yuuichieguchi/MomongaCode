import { DEFAULT_DIALECT_ID } from '@momonga/protocol';
import { NO_USER_DIALECTS, resolveDialect } from '../dialect/choice.ts';
import type { DialectChoice } from '../dialect/choice.ts';
import { FULL_KEYWORD_SUPPORT } from '../dialect/keyword-support.ts';
import type { RenderLedger } from '../dialect/ledger.ts';
import type { ResolvedDialect } from '../dialect/render.ts';
import { renderToolParameters } from '../dialect/tool-render.ts';
import { buildToolsEnvelope } from './envelope.ts';
import type { EnvelopeShape, ProbeTool } from './envelope.ts';
import type { JsonObject } from './reply.ts';

export const FORECAST_TOOL: ProbeTool = {
  name: 'probe_forecast',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', minLength: 1 },
      unit: { enum: ['celsius', 'fahrenheit'] },
      options: {
        type: 'object',
        properties: { days: { type: 'integer' }, label: { type: 'string' } },
        required: ['days'],
      },
      note: {},
      enforcement: { anyOf: [{ type: 'null' }, { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] }] },
    },
    required: ['city', 'unit'],
  },
};

export const PING_TOOL: ProbeTool = { name: 'probe_ping' };

export const SELECTION_TOOLS: readonly ProbeTool[] = [FORECAST_TOOL, PING_TOOL];

export const NEUTRAL_PROMPT = 'Say hello in one short sentence.';

export const DEMANDING_PROMPT = `Please call ${FORECAST_TOOL.name} for Tokyo and give the temperature in kelvin.`;

export const SELECTION_SYSTEM_PROMPT = 'Answer only with JSON that matches the given schema.';

const originalDialect = (): DialectChoice => resolveDialect(DEFAULT_DIALECT_ID, NO_USER_DIALECTS);

export const selectionEnvelope = (dialect: DialectChoice, shape: EnvelopeShape, ledger?: RenderLedger): JsonObject =>
  buildToolsEnvelope(SELECTION_TOOLS, FULL_KEYWORD_SUPPORT, false, dialect, shape, ledger);

export const originalEnvelope = (shape: EnvelopeShape): JsonObject => buildToolsEnvelope(SELECTION_TOOLS, FULL_KEYWORD_SUPPORT, false, originalDialect(), shape);

export const selectionToolSpecs = (dialect: ResolvedDialect, ledger?: RenderLedger): unknown[] =>
  SELECTION_TOOLS.map((tool) => {
    const { schema } = renderToolParameters(tool, dialect, ledger);
    return { type: 'function', function: { name: tool.name, description: 'A probe tool', ...(schema === undefined ? {} : { parameters: schema }) } };
  });

export type ConstructName = 'ref' | 'typeArray' | 'mixedEnum';

export const CONSTRUCT_NAMES: readonly ConstructName[] = ['ref', 'typeArray', 'mixedEnum'];

export const CONSTRUCT_TOOLS: Record<ConstructName, ProbeTool> = {
  ref: {
    name: 'probe_ref',
    parameters: { type: 'object', properties: { r: { $ref: '#/$defs/d' } }, required: ['r'], $defs: { d: { type: 'string' } } },
  },
  typeArray: {
    name: 'probe_type_array',
    parameters: { type: 'object', properties: { a: { type: ['string', 'integer'] }, b: { type: ['string', 'null'] } }, required: ['a', 'b'] },
  },
  mixedEnum: {
    name: 'probe_mixed_enum',
    parameters: { type: 'object', properties: { e: { enum: ['alpha', 1] } }, required: ['e'] },
  },
};
