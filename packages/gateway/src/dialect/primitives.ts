import type { DialectRule } from '@momonga/protocol';
import { dropKeys } from './drop.ts';
import { inlineRefs } from './inline-refs.ts';
import { nullableOptional } from './nullable-optional.ts';
import { isRecord, jsonTypeOf, typeIncludes, typesOf } from './schema.ts';
import type { JsonObject } from './schema.ts';
import { constAsEnum, splitEnum, splitTypeArray } from './split.ts';
import { FreeFormObject, fail, guardWrittenKeys, hasActiveUneval, reportNarrowing, requirePositive } from './state.ts';
import type { NodeContext, RenderState } from './state.ts';

const typeOfValues = (values: readonly unknown[]): string | undefined => {
  const types = values.map(jsonTypeOf);
  const numeric = types.includes('number');
  const unique = [...new Set(types.map((type) => (numeric && type === 'integer' ? 'number' : type)))];
  return unique.length === 1 ? (unique[0] as string) : undefined;
};

const commonBranchType = (branches: unknown): string | undefined => {
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  const types = branches.map((branch) => (isRecord(branch) && typeof branch['type'] === 'string' ? branch['type'] : undefined));
  const [first] = types;
  return first !== undefined && types.every((type) => type === first) ? first : undefined;
};

const fillType = (state: RenderState, node: JsonObject, context: NodeContext, rule: Extract<DialectRule, { op: 'fill-type' }>): JsonObject => {
  if ('type' in node) return node;
  let type: string | undefined;
  if ('const' in node) type = typeOfValues([node['const']]);
  else if (Array.isArray(node['enum']) && node['enum'].length > 0) type = typeOfValues(node['enum']);
  type ??= commonBranchType(node['oneOf']) ?? commonBranchType(node['allOf']);
  if (type === undefined && isRecord(node['properties'])) type = 'object';
  if (type === undefined && 'items' in node) type = 'array';
  requirePositive(state, context, 'fill-type');
  guardWrittenKeys(state, ['type'], 'fill-type');
  if (type === undefined) {
    reportNarrowing(state, context, rule);
    type = rule.fallback;
  }
  return { ...node, type };
};

const requireAll = (state: RenderState, node: JsonObject, context: NodeContext, rule: DialectRule): JsonObject => {
  const properties = node['properties'];
  if (!isRecord(properties)) return node;
  const existing = Array.isArray(node['required']) ? node['required'] : [];
  const added = Object.keys(properties).filter((name) => !existing.includes(name));
  if (added.length === 0) return node;
  requirePositive(state, context, 'require-all');
  guardWrittenKeys(state, ['required'], 'require-all');
  if (added.some((name) => !state.wrappers.has(properties[name] as object))) reportNarrowing(state, context, rule);
  return { ...node, required: [...existing, ...added] };
};

const admitsAnObject = (node: JsonObject): boolean => {
  const types = typesOf(node);
  if (types !== undefined && !types.includes('object')) return false;
  if ('const' in node && !isRecord(node['const'])) return false;
  const values = node['enum'];
  return !Array.isArray(values) || values.some((value) => isRecord(value));
};

const namesNoProperty = (state: RenderState, node: JsonObject): boolean => {
  const properties = node['properties'];
  return !isRecord(properties) || state.writtenProperties.has(node);
};

const closeObject = (state: RenderState, node: JsonObject, context: NodeContext, rule: Extract<DialectRule, { op: 'ensure-key' }>): JsonObject => {
  const overwrite = rule.overwrite ?? 'never';
  const current = node['additionalProperties'];
  const replaces = current === undefined || (overwrite === 'non-boolean' && isRecord(current)) || (overwrite === 'always' && current !== false);
  if (!replaces) return node;
  requirePositive(state, context, 'ensure-key additionalProperties false');
  const freeForm = !context.absent && admitsAnObject(node) && namesNoProperty(state, node);
  if (freeForm && overwrite === 'always') throw new FreeFormObject(context.origin);
  guardWrittenKeys(state, ['additionalProperties'], 'ensure-key');
  if (freeForm || current !== undefined) reportNarrowing(state, context, rule);
  return { ...node, additionalProperties: false };
};

const ensureKey = (state: RenderState, node: JsonObject, rule: Extract<DialectRule, { op: 'ensure-key' }>, context: NodeContext): JsonObject => {
  const { key, value } = rule;
  if (key === 'additionalProperties' && value === false) return closeObject(state, node, context, rule);
  if (key in node) return node;
  if (key === 'additionalProperties' && hasActiveUneval(state, context, node)) {
    return fail(state, 'dependency', context.origin, 'additionalProperties would evaluate properties that unevaluatedProperties checks');
  }
  guardWrittenKeys(state, [key], 'ensure-key');
  if (key !== 'properties') return { ...node, [key]: structuredClone(value) };
  if (typeIncludes(node, 'object') && node['additionalProperties'] !== false) reportNarrowing(state, context, rule);
  const written = { ...node, [key]: structuredClone(value) };
  state.writtenProperties.add(written);
  return written;
};

const declareRequired = (state: RenderState, node: JsonObject, context: NodeContext): JsonObject => {
  const required = node['required'];
  if (!Array.isArray(required)) return node;
  const declared = isRecord(node['properties']) ? node['properties'] : {};
  const missing = [...new Set(required.filter((name): name is string => typeof name === 'string' && !Object.hasOwn(declared, name)))];
  if (missing.length === 0) return node;
  if (hasActiveUneval(state, context, node)) return fail(state, 'dependency', context.origin, 'a declared property would be evaluated by unevaluatedProperties');
  guardWrittenKeys(state, ['properties'], 'declare-required');
  const patterns = isRecord(node['patternProperties']) ? Object.keys(node['patternProperties']) : [];
  const additional = node['additionalProperties'];
  const schemaFor = (name: string): unknown => {
    if (patterns.some((pattern) => patternMatches(state, context, pattern, name))) return {};
    if (additional === false) return false;
    return isRecord(additional) ? structuredClone(additional) : {};
  };
  return { ...node, properties: { ...declared, ...Object.fromEntries(missing.map((name): [string, unknown] => [name, schemaFor(name)])) } };
};

const patternMatches = (state: RenderState, context: NodeContext, pattern: string, name: string): boolean => {
  try {
    return new RegExp(pattern, 'u').test(name);
  } catch (error) {
    if (error instanceof SyntaxError) return fail(state, 'dependency', context.origin, `the pattern ${pattern} is not a regular expression`);
    throw error;
  }
};

const emptyParameters = (state: RenderState, node: JsonObject, context: NodeContext): JsonObject => {
  if (!context.absent) return node;
  guardWrittenKeys(state, ['type', 'properties'], 'empty-parameters');
  return { ...node, type: node['type'] ?? 'object', properties: node['properties'] ?? {} };
};

export const applyRule = (state: RenderState, rule: DialectRule, node: JsonObject, context: NodeContext): JsonObject => {
  switch (rule.op) {
    case 'reject': {
      const hit = rule.keys.find((key) => key in node);
      return hit === undefined ? node : fail(state, 'reject', context.origin, `the target does not accept ${hit}`);
    }
    case 'drop':
      return dropKeys(state, node, rule.keys, context);
    case 'fill-type':
      return fillType(state, node, context, rule);
    case 'split-enum':
      return splitEnum(state, node, context);
    case 'split-type-array':
      return splitTypeArray(state, node, context);
    case 'const-as-enum':
      return constAsEnum(state, node, context);
    case 'ensure-key':
      return ensureKey(state, node, rule, context);
    case 'label':
      if (rule.key in node) return node;
      guardWrittenKeys(state, [rule.key], 'label');
      return { ...node, [rule.key]: context.labelPath };
    case 'property-order':
      if (!isRecord(node['properties']) || rule.key in node) return node;
      guardWrittenKeys(state, [rule.key], 'property-order');
      return { ...node, [rule.key]: Object.keys(node['properties']) };
    case 'require-all':
      return requireAll(state, node, context, rule);
    case 'declare-required':
      return declareRequired(state, node, context);
    case 'empty-parameters':
      return emptyParameters(state, node, context);
    case 'inline-refs':
      return inlineRefs(state, node, context);
    case 'nullable-optional':
      return nullableOptional(state, node, context);
  }
};
