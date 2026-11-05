import Ajv2020 from 'ajv/dist/2020.js';
import type { DialectDefinition, WrapRecord } from '@momonga/protocol';
import { SchemaRenderError } from '../src/dialect/render.ts';
import type { ResolvedDialect } from '../src/dialect/render.ts';
import { definitionOf } from '../src/dialect/resolve.ts';

export const STATED_REASONS = ['loop', 'reject', 'polarity', 'dependency', 'written-key', 'unsatisfiable', 'ref-sibling', 'inverse-ambiguous', 'construct'] as const;

export const builtin = (id: string, extra: Partial<ResolvedDialect> = {}): ResolvedDialect => ({ id, definition: definitionOf(id, {}), ...extra });

export const userRules = (rules: unknown[]): ResolvedDialect => ({ id: 'test-rules', definition: { rules } as DialectDefinition });

export const toolSite = (tool: string) => ({ kind: 'tool-parameters' as const, tool });

export const RESPONSE_FORMAT = { kind: 'response-format' as const };

export type Failure = { reason: string; tool: string | undefined; path: string; code: string };

export const failureOf = (render: () => unknown): Failure => {
  try {
    render();
  } catch (error) {
    if (!(error instanceof SchemaRenderError)) throw error;
    return { reason: error.reason, tool: error.tool, path: error.path, code: error.code };
  }
  throw new Error('the render succeeded where a failure was expected');
};

export const seeded = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(values: readonly T[]): T => values[int(0, values.length - 1)] as T;
  const chance = (p: number): boolean => next() < p;
  return { next, int, pick, chance };
};

export type Rng = ReturnType<typeof seeded>;

type Validator = (instance: unknown) => boolean;

export const validatorOf = (schema: unknown): Validator | undefined => {
  const ajv = new Ajv2020.default({ strict: false, allErrors: false, validateSchema: false });
  try {
    const compiled = ajv.compile(schema as object);
    return (instance: unknown) => compiled(instance) === true;
  } catch {
    return undefined;
  }
};

const NAMES = ['a', 'b', 'c'] as const;
const SCALARS: readonly unknown[] = [null, true, false, 0, 1, 1.5, -2, '', 'a', 'ab', 'xyz'];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const resolvePointer = (root: unknown, pointer: string): unknown => {
  if (!pointer.startsWith('#')) return undefined;
  const segments = pointer.slice(1).split('/').filter((segment) => segment !== '').map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  let node: unknown = root;
  for (const segment of segments) {
    if (!isObject(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
};

export const nodeAt = (root: unknown, pointer: string): unknown => resolvePointer(root, `#${pointer}`);

export const instancesOf = (rng: Rng, root: unknown, count: number): unknown[] => {
  const instances: unknown[] = [];
  for (let index = 0; index < count; index += 1) instances.push(instanceOf(rng, root, root, 0));
  return instances;
};

const typeOfInstance = (rng: Rng, type: string, node: Record<string, unknown>, root: unknown, depth: number): unknown => {
  switch (type) {
    case 'null':
      return null;
    case 'boolean':
      return rng.chance(0.5);
    case 'integer':
      return rng.pick([-1, 0, 1, 2, 5]);
    case 'number':
      return rng.pick([0.5, 1.5, -2.5, 0, 3]);
    case 'string':
      return rng.pick(['', 'a', 'ab', 'xyz', 'abcdef']);
    case 'array': {
      const prefix = Array.isArray(node['prefixItems']) ? node['prefixItems'] : [];
      const length = rng.int(0, 3);
      const values: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const schema = index < prefix.length ? prefix[index] : node['items'];
        values.push(instanceOf(rng, schema, root, depth + 1));
      }
      return values;
    }
    default: {
      const properties = isObject(node['properties']) ? node['properties'] : {};
      const required = Array.isArray(node['required']) ? (node['required'] as string[]) : [];
      const value: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(properties)) {
        if (required.includes(name) || rng.chance(0.5)) value[name] = instanceOf(rng, child, root, depth + 1);
      }
      for (const name of required) if (!(name in value)) value[name] = instanceOf(rng, true, root, depth + 1);
      if (rng.chance(0.15)) value[rng.pick(['z', 'a', 'extra'])] = instanceOf(rng, true, root, depth + 1);
      return value;
    }
  }
};

export const instanceOf = (rng: Rng, schema: unknown, root: unknown, depth: number): unknown => {
  if (depth > 6 || schema === true || schema === false || schema === undefined || !isObject(schema)) {
    return depth > 6 ? rng.pick(SCALARS) : rng.chance(0.3) ? rng.pick([{}, [], { a: null }]) : rng.pick(SCALARS);
  }
  if (typeof schema['$ref'] === 'string' && rng.chance(0.85)) return instanceOf(rng, resolvePointer(root, schema['$ref']), root, depth + 1);
  if ('const' in schema && rng.chance(0.85)) return structuredClone(schema['const']);
  if (Array.isArray(schema['enum']) && schema['enum'].length > 0 && rng.chance(0.85)) return structuredClone(rng.pick(schema['enum']));
  for (const keyword of ['anyOf', 'oneOf']) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0 && rng.chance(0.85)) return instanceOf(rng, rng.pick(branches), root, depth + 1);
  }
  if (Array.isArray(schema['allOf']) && schema['allOf'].length > 0 && rng.chance(0.5)) return instanceOf(rng, rng.pick(schema['allOf']), root, depth + 1);
  const type = schema['type'];
  if (typeof type === 'string') return typeOfInstance(rng, type, schema, root, depth);
  if (Array.isArray(type) && type.length > 0) return typeOfInstance(rng, rng.pick(type as string[]), schema, root, depth);
  if (isObject(schema['properties']) || Array.isArray(schema['required'])) return typeOfInstance(rng, 'object', schema, root, depth);
  if ('items' in schema || 'prefixItems' in schema) return typeOfInstance(rng, 'array', schema, root, depth);
  return rng.pick(SCALARS);
};

export const mutationsOf = (rng: Rng, instance: unknown): unknown[] => {
  const mutated: unknown[] = [null, rng.pick(SCALARS), {}, []];
  if (isObject(instance)) {
    const keys = Object.keys(instance);
    for (const key of keys) {
      const { [key]: _removed, ...without } = instance;
      mutated.push(without, { ...instance, [key]: null }, { ...instance, [key]: rng.pick(SCALARS) });
    }
    mutated.push({ ...instance, [rng.pick(['z', ...NAMES])]: rng.pick(SCALARS) });
  }
  if (Array.isArray(instance)) mutated.push([...instance, rng.pick(SCALARS)], instance.slice(1), [...instance, ...instance]);
  return mutated;
};

export const withNulls = (instance: unknown): unknown[] => {
  const variants: unknown[] = [];
  const visit = (node: unknown, rebuild: (replacement: unknown) => unknown): void => {
    if (isObject(node)) {
      for (const key of Object.keys(node)) {
        variants.push(rebuild({ ...node, [key]: null }));
        visit(node[key], (replacement) => rebuild({ ...node, [key]: replacement }));
      }
    }
    if (Array.isArray(node)) {
      node.forEach((element, index) => visit(element, (replacement) => rebuild(node.map((other, at) => (at === index ? replacement : other)))));
    }
  };
  visit(instance, (replacement) => replacement);
  return variants;
};

export const pad = (record: WrapRecord | undefined, instance: unknown): unknown => {
  if (record === undefined) return instance;
  const padded = structuredClone(instance);
  for (const { at, property } of record.wrapped) {
    let reached: unknown[] = [padded];
    for (const segment of at) {
      reached = reached.flatMap((node) => {
        if ('items' in segment) return Array.isArray(node) ? node : [];
        return isObject(node) && segment.property in node ? [node[segment.property]] : [];
      });
    }
    for (const node of reached) if (isObject(node) && !(property in node)) node[property] = null;
  }
  return padded;
};

const schemaGenerator = (rng: Rng, defNames: readonly string[]) => {
  const scalarSchema = (): Record<string, unknown> => {
    const type = rng.pick(['string', 'integer', 'number', 'boolean', 'null']);
    const node: Record<string, unknown> = { type };
    if (type === 'string' && rng.chance(0.3)) node['minLength'] = rng.int(0, 2);
    if (type === 'string' && rng.chance(0.15)) node['pattern'] = '^a';
    if ((type === 'integer' || type === 'number') && rng.chance(0.3)) node['minimum'] = rng.int(-1, 1);
    return node;
  };
  const enumValues = (): unknown[] => {
    const count = rng.int(1, 4);
    const values: unknown[] = [];
    for (let index = 0; index < count; index += 1) values.push(rng.pick(SCALARS));
    return values;
  };
  const objectSchema = (depth: number): Record<string, unknown> => {
    const node: Record<string, unknown> = {};
    if (rng.chance(0.8)) node['type'] = 'object';
    if (rng.chance(0.8)) {
      const properties: Record<string, unknown> = {};
      for (const name of NAMES) if (rng.chance(0.6)) properties[name] = schemaOf(depth + 1);
      node['properties'] = properties;
    }
    if (rng.chance(0.6)) node['required'] = [...NAMES.filter(() => rng.chance(0.4)), ...(rng.chance(0.15) ? ['x'] : [])];
    if (rng.chance(0.4)) node['additionalProperties'] = rng.pick<unknown>([true, false, scalarSchema()]);
    if (rng.chance(0.1)) node['patternProperties'] = { '^a': scalarSchema() };
    if (rng.chance(0.08)) node['minProperties'] = 1;
    if (rng.chance(0.08)) node['maxProperties'] = 2;
    if (rng.chance(0.08)) node['dependentRequired'] = { a: ['b'] };
    if (rng.chance(0.06)) node['dependentSchemas'] = { a: { required: ['c'] } };
    if (rng.chance(0.08)) node['unevaluatedProperties'] = rng.pick<unknown>([true, false, scalarSchema()]);
    if (rng.chance(0.06)) node['propertyNames'] = { maxLength: 1 };
    return node;
  };
  const arraySchema = (depth: number): Record<string, unknown> => {
    const node: Record<string, unknown> = { type: 'array' };
    if (rng.chance(0.8)) node['items'] = schemaOf(depth + 1);
    if (rng.chance(0.15)) node['prefixItems'] = [schemaOf(depth + 1)];
    if (rng.chance(0.15)) {
      node['contains'] = scalarSchema();
      if (rng.chance(0.5)) node['minContains'] = rng.int(0, 1);
      if (rng.chance(0.5)) node['maxContains'] = rng.int(1, 2);
    }
    if (rng.chance(0.2)) node['minItems'] = rng.int(0, 2);
    if (rng.chance(0.1)) node['uniqueItems'] = true;
    if (rng.chance(0.08)) node['unevaluatedItems'] = rng.pick<unknown>([true, false]);
    return node;
  };
  const refSchema = (): Record<string, unknown> => {
    const node: Record<string, unknown> = { $ref: `#/$defs/${rng.pick(defNames)}` };
    const sibling = rng.int(0, 4);
    if (sibling === 1) node['description'] = 'r';
    if (sibling === 2) node['minimum'] = 0;
    if (sibling === 3) node['properties'] = { b: {} };
    if (sibling === 4) node['minContains'] = 0;
    return node;
  };
  const schemaOf = (depth: number): unknown => {
    if (depth >= 4) return rng.chance(0.1) ? rng.pick<unknown>([true, false, {}]) : scalarSchema();
    switch (rng.int(0, 14)) {
      case 0:
        return scalarSchema();
      case 1: {
        const types = [...new Set([rng.pick(['string', 'integer', 'object', 'array']), rng.pick(['null', 'string', 'number'])])];
        const node: Record<string, unknown> = { type: types };
        if (types.includes('object') && rng.chance(0.5)) node['properties'] = { a: scalarSchema() };
        if (rng.chance(0.3)) node['enum'] = enumValues();
        return node;
      }
      case 2: {
        const node: Record<string, unknown> = { enum: enumValues() };
        if (rng.chance(0.4)) node['type'] = rng.pick(['string', 'integer', 'number', 'null']);
        return node;
      }
      case 3: {
        const node: Record<string, unknown> = { const: rng.pick(SCALARS) };
        if (rng.chance(0.3)) node['enum'] = enumValues();
        if (rng.chance(0.2)) node['type'] = rng.pick(['string', 'integer']);
        return node;
      }
      case 4:
      case 5:
        return objectSchema(depth);
      case 6:
        return arraySchema(depth);
      case 7:
        return { anyOf: [schemaOf(depth + 1), schemaOf(depth + 1)] };
      case 8:
        return rng.chance(0.3) ? { type: 'array', oneOf: [true, {}] } : { oneOf: [schemaOf(depth + 1), schemaOf(depth + 1)] };
      case 9:
        return { allOf: [schemaOf(depth + 1)], ...(rng.chance(0.3) ? { unevaluatedProperties: false } : {}) };
      case 10:
        return { not: schemaOf(depth + 1) };
      case 11:
        return { if: schemaOf(depth + 1), then: schemaOf(depth + 1), ...(rng.chance(0.5) ? { else: schemaOf(depth + 1) } : {}) };
      case 12:
        return rng.pick<unknown>([true, false, {}]);
      case 13:
        return defNames.length > 0 ? refSchema() : scalarSchema();
      default:
        return { description: 'untyped', ...(rng.chance(0.5) ? { minLength: 1 } : {}) };
    }
  };
  return { schemaOf, objectSchema };
};

export const toolParametersOf = (rng: Rng): Record<string, unknown> => {
  const defNames = rng.chance(0.3) ? ['d0', 'd1'] : [];
  const leaves = schemaGenerator(rng, []);
  const generator = schemaGenerator(rng, defNames);
  const root = generator.objectSchema(0);
  if (defNames.length > 0) root['$defs'] = Object.fromEntries(defNames.map((name) => [name, leaves.schemaOf(2)]));
  if (rng.chance(0.05)) return rng.pick([{}, { type: 'object' }]);
  return root;
};

export const responseFormatOf = (rng: Rng): unknown => {
  const defNames = rng.chance(0.3) ? ['d0'] : [];
  const leaves = schemaGenerator(rng, []);
  const root = schemaGenerator(rng, defNames).schemaOf(0);
  if (defNames.length > 0 && isObject(root)) return { ...root, $defs: { d0: leaves.schemaOf(2) } };
  return root;
};

export const strictToolParametersOf = (rng: Rng): Record<string, unknown> => {
  const scalar = (): unknown => {
    switch (rng.int(0, 7)) {
      case 0:
        return { type: rng.pick(['string', 'integer', 'boolean', 'number']) };
      case 1:
        return { type: 'string', minLength: rng.int(0, 2) };
      case 2:
        return { type: ['string', 'null'] };
      case 3:
        return { enum: rng.chance(0.5) ? ['x', 'y'] : ['x', null] };
      case 4:
        return { const: rng.pick<unknown>(['k', null, 1]) };
      case 5:
        return { anyOf: [{ type: 'null' }, objectOf(2, true)] };
      case 6:
        return { anyOf: [{ type: 'string' }, { type: 'integer' }] };
      default:
        return rng.chance(0.5) ? {} : true;
    }
  };
  const objectOf = (depth: number, allRequired = false): Record<string, unknown> => {
    const properties: Record<string, unknown> = {};
    for (const name of NAMES) {
      if (!rng.chance(0.7)) continue;
      const nested = depth < 3 ? rng.int(0, 5) : 0;
      if (nested === 4) properties[name] = objectOf(depth + 1);
      else if (nested === 5) properties[name] = { type: 'array', items: rng.chance(0.6) ? objectOf(depth + 1) : scalar() };
      else properties[name] = scalar();
    }
    const names = Object.keys(properties);
    const required = allRequired ? names : names.filter(() => rng.chance(0.4));
    return { type: 'object', properties, ...(required.length > 0 || rng.chance(0.5) ? { required } : {}) };
  };
  return objectOf(0);
};
