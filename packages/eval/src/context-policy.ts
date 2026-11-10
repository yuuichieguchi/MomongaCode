import { defaultContextSettings, defaultMemorySettings, defaultToolsSettings } from '@momonga/config';
import { OUTPUT_FORMATTERS } from '@momonga/protocol';
import type { OutputFormatterName } from '@momonga/protocol';
import { canonicalJson, defineProductSchema, parseOutsideJson } from '@momonga/foundation';
import type { ProductValidator, UntrustedError } from '@momonga/foundation';
import { EvalError } from './runner.ts';

export type PolicyOverlay = {
  context?: { cachePrefix?: boolean; outputFormatters?: OutputFormatterName[]; loopGuidance?: boolean; observedCapacity?: boolean; unboundedOutputReserve?: boolean };
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
        unboundedOutputReserve: bool,
      },
      additionalProperties: false,
    },
    tools: { type: 'object', properties: { deferral: bool, conciseDescriptions: bool }, additionalProperties: false },
    memory: { type: 'object', properties: { repositoryFacts: bool }, additionalProperties: false },
  },
  additionalProperties: false,
} as const;

export const validatePolicyOverlay: ProductValidator<PolicyOverlay> = defineProductSchema('eval/policy-overlay', POLICY_OVERLAY_SCHEMA);

const describeViolation = (errors: readonly UntrustedError[]): string => {
  const first = errors[0];
  if (first === undefined) return '/: schema violation';
  const extra = first.keyword === 'additionalProperties' ? `/${String(first.params['additionalProperty'])}` : '';
  const pointer = `${first.instancePath}${extra}`;
  return `${pointer === '' ? '/' : pointer}: ${first.message}`;
};

const withoutDefaults = <T extends object>(section: T | undefined, defaults: Record<string, unknown>): T | undefined => {
  if (section === undefined) return undefined;
  const kept = Object.fromEntries(Object.entries(section).filter(([key, value]) => canonicalJson(value) !== canonicalJson(defaults[key])));
  return Object.keys(kept).length === 0 ? undefined : (kept as T);
};

export const normalisePolicyOverlay = (overlay: PolicyOverlay): PolicyOverlay => {
  const context = withoutDefaults(
    overlay.context === undefined ? undefined : { ...overlay.context, ...(overlay.context.outputFormatters === undefined ? {} : { outputFormatters: [...overlay.context.outputFormatters].sort() }) },
    { ...defaultContextSettings() },
  );
  const tools = withoutDefaults(overlay.tools, { ...defaultToolsSettings() });
  const memory = withoutDefaults(overlay.memory, { ...defaultMemorySettings() });
  return { ...(context === undefined ? {} : { context }), ...(tools === undefined ? {} : { tools }), ...(memory === undefined ? {} : { memory }) };
};

export const parsePolicyOverlay = (text: string, source: string): PolicyOverlay => {
  let value: unknown;
  try {
    value = parseOutsideJson(text);
  } catch (error) {
    throw new EvalError(`${source}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const verdict = validatePolicyOverlay(value);
  if (!verdict.valid) throw new EvalError(`${source}: not a token policy overlay (${describeViolation(verdict.errors)})`);
  return normalisePolicyOverlay(verdict.value);
};
