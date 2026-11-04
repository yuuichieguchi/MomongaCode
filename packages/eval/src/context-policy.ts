import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { OUTPUT_FORMATTERS } from '@momonga/protocol';
import type { OutputFormatterName } from '@momonga/protocol';
import { EvalError } from './runner.ts';

export type PolicyOverlay = {
  context?: { cachePrefix?: boolean; outputFormatters?: OutputFormatterName[]; loopGuidance?: boolean; observedCapacity?: boolean };
  tools?: { deferral?: boolean; conciseDescriptions?: boolean };
  memory?: { repositoryFacts?: boolean };
};

const bool = { type: 'boolean' } as const;

export const POLICY_OVERLAY_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    context: {
      type: 'object',
      properties: {
        cachePrefix: bool,
        outputFormatters: { type: 'array', items: { enum: [...OUTPUT_FORMATTERS] } },
        loopGuidance: bool,
        observedCapacity: bool,
      },
      additionalProperties: false,
    },
    tools: { type: 'object', properties: { deferral: bool, conciseDescriptions: bool }, additionalProperties: false },
    memory: { type: 'object', properties: { repositoryFacts: bool }, additionalProperties: false },
  },
  additionalProperties: false,
} as const;

const ajv = new Ajv2020.default({ strict: true });
export const validatePolicyOverlay: ValidateFunction<PolicyOverlay> = ajv.compile<PolicyOverlay>(POLICY_OVERLAY_SCHEMA);

const describeViolation = (): string => {
  const first = validatePolicyOverlay.errors?.[0];
  if (first === undefined) return '/: schema violation';
  const extra = first.keyword === 'additionalProperties' ? `/${String(first.params['additionalProperty'])}` : '';
  const pointer = `${first.instancePath}${extra}`;
  return `${pointer === '' ? '/' : pointer}: ${first.message ?? 'schema violation'}`;
};

export const parsePolicyOverlay = (text: string, source: string): PolicyOverlay => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new EvalError(`${source}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!validatePolicyOverlay(value)) throw new EvalError(`${source}: not a token policy overlay (${describeViolation()})`);
  return value;
};
