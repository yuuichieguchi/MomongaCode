import {
  CORE_SETTING_KEYS,
  SETTINGS_SCHEMA,
  defaultContextSettings,
  defaultMemorySettings,
  defaultToolsSettings,
  mergeContextSettings,
  mergeMemorySettings,
  mergeToolsSettings,
} from '@momonga/config';
import type { OutputFormatterName } from '@momonga/protocol';
import { defineProductSchema, isRecord, parseOutsideJson } from '@momonga/foundation';
import type { ProductValidator, UntrustedError } from '@momonga/foundation';
import { EvalError } from './runner.ts';

export type PolicyOverlay = {
  context?: {
    adaptiveBudget?: boolean;
    autoCompact?: boolean;
    cachePrefix?: boolean;
    outputFormatters?: OutputFormatterName[];
    loopGuidance?: boolean;
    observedCapacity?: boolean;
    unboundedOutputReserve?: boolean;
  };
  tools?: { deferral?: boolean; conciseDescriptions?: boolean };
  memory?: { repositoryFacts?: boolean; reflection?: { enabled?: boolean } };
};

export type ResolvedPolicy = {
  context: {
    adaptiveBudget: boolean;
    autoCompact: boolean;
    cachePrefix: boolean;
    outputFormatters: OutputFormatterName[];
    loopGuidance: boolean;
    observedCapacity: boolean;
    unboundedOutputReserve: boolean;
  };
  tools: { deferral: boolean; conciseDescriptions: boolean };
  memory: { repositoryFacts: boolean; reflection: { enabled: boolean } };
};

type SchemaNode = Record<string, unknown>;

const CORE_PATHS: readonly (readonly string[])[] = CORE_SETTING_KEYS.map((key) => key.split('.'));

const settingNodeAt = (path: readonly string[]): SchemaNode =>
  path.reduce<SchemaNode>((node, part) => {
    const properties = node['properties'];
    const child = isRecord(properties) ? properties[part] : undefined;
    if (!isRecord(child)) throw new Error(`the settings schema declares no ${path.join('.')}`);
    return child;
  }, SETTINGS_SCHEMA as unknown as SchemaNode);

const sectionSchemaOf = (paths: readonly (readonly string[])[], prefix: readonly string[], required: boolean): SchemaNode => {
  const names = [...new Set(paths.map((path) => path[0] ?? ''))];
  const properties = Object.fromEntries(
    names.map((name) => {
      const below = paths.filter((path) => path[0] === name).map((path) => path.slice(1));
      const at = [...prefix, name];
      return [name, below.some((path) => path.length === 0) ? settingNodeAt(at) : sectionSchemaOf(below, at, required)];
    }),
  );
  return { type: 'object', properties, ...(required ? { required: names } : {}), additionalProperties: false };
};

export const POLICY_OVERLAY_SCHEMA: SchemaNode = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...sectionSchemaOf(CORE_PATHS, [], false) };

export const RESOLVED_POLICY_SCHEMA: SchemaNode = sectionSchemaOf(CORE_PATHS, [], true);

export const validatePolicyOverlay: ProductValidator<PolicyOverlay> = defineProductSchema('eval/policy-overlay', POLICY_OVERLAY_SCHEMA);

export const validateResolvedPolicy: ProductValidator<ResolvedPolicy> = defineProductSchema('eval/resolved-policy', {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...RESOLVED_POLICY_SCHEMA,
});

const describeViolation = (errors: readonly UntrustedError[]): string => {
  const first = errors[0];
  if (first === undefined) return '/: schema violation';
  const extra = first.keyword === 'additionalProperties' ? `/${String(first.params['additionalProperty'])}` : '';
  const pointer = `${first.instancePath}${extra}`;
  return `${pointer === '' ? '/' : pointer}: ${first.message}`;
};

const valueAt = (root: Record<string, unknown>, path: readonly string[]): unknown =>
  path.reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), root);

const withValueAt = (root: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> => {
  const [head, ...rest] = path;
  if (head === undefined) throw new Error('a core setting key has no name');
  const child = root[head];
  return { ...root, [head]: rest.length === 0 ? value : withValueAt(isRecord(child) ? child : {}, rest, value) };
};

const canonicalValue = (value: unknown): unknown => (Array.isArray(value) ? [...value].sort() : value);

export const resolvePolicyOverlay = (overlay: PolicyOverlay): ResolvedPolicy => {
  const settings: Record<string, unknown> = {
    context: mergeContextSettings(defaultContextSettings(), overlay.context),
    tools: mergeToolsSettings(defaultToolsSettings(), overlay.tools),
    memory: mergeMemorySettings(defaultMemorySettings(), overlay.memory),
  };
  const picked = CORE_PATHS.reduce<Record<string, unknown>>((resolved, path) => withValueAt(resolved, path, canonicalValue(valueAt(settings, path))), {});
  const verdict = validateResolvedPolicy(picked);
  if (!verdict.valid) throw new EvalError(`the resolved token policy does not hold every core key (${describeViolation(verdict.errors)})`);
  return verdict.value;
};

export const policyDifferences = (left: PolicyOverlay, right: PolicyOverlay): string[] =>
  CORE_PATHS.filter((path) => JSON.stringify(valueAt(left, path)) !== JSON.stringify(valueAt(right, path)))
    .map((path) => path.join('.'))
    .sort();

export const parsePolicyOverlay = (text: string, source: string): PolicyOverlay => {
  let value: unknown;
  try {
    value = parseOutsideJson(text);
  } catch (error) {
    throw new EvalError(`${source}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const verdict = validatePolicyOverlay(value);
  if (!verdict.valid) throw new EvalError(`${source}: not a token policy overlay (${describeViolation(verdict.errors)})`);
  if (verdict.value.context?.autoCompact !== undefined) {
    throw new EvalError(`${source}: context.autoCompact is set by the compaction field of each case, so an overlay that sets it would be recorded as a policy the runs did not have; remove it from the overlay`);
  }
  const defaults = resolvePolicyOverlay({});
  const restated = CORE_PATHS.filter((path) => {
    const value = valueAt(verdict.value, path);
    return value !== undefined && JSON.stringify(canonicalValue(value)) === JSON.stringify(valueAt(defaults, path));
  }).map((path) => path.join('.'));
  if (restated.length > 0) {
    throw new EvalError(`${source}: ${restated.join(', ')} ${restated.length === 1 ? 'restates its default' : 'restate their defaults'}, so the overlay would be recorded as a change it does not make; set a value that differs from the default or remove the key`);
  }
  return verdict.value;
};
