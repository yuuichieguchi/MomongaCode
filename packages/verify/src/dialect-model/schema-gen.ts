import type { Json, JsonObject } from './json.ts';
import type { Rng } from './prng.ts';
import type { Site } from './selector.ts';

export interface PatternSample {
  pattern: string;
  matching: string[];
  other: string[];
}

export const PATTERNS: readonly PatternSample[] = [
  { pattern: '^a', matching: ['a', 'ab', 'abc'], other: ['b', '', 'ba'] },
  { pattern: '^[0-9]+$', matching: ['1', '42', '007'], other: ['a', '4a', ''] },
  { pattern: 'x$', matching: ['x', 'ax', 'bbx'], other: ['xa', 'y', ''] },
  { pattern: '^[a-z]{2}$', matching: ['ab', 'zz'], other: ['a', 'abc', 'A1'] },
  { pattern: '^(foo|bar)', matching: ['foo', 'barx'], other: ['baz', 'fo'] },
];

export const NAMES: readonly string[] = ['a', 'b', 'c', 'ab', 'id', '1', 'x', 'foo', 'zz'];

export const VALUES: readonly Json[] = [
  null, true, false, 0, 1, -1, 2, 2.5, 1.0, 10, '', 'a', 'ab', 'x', '1', 'foo', [], [1], ['a'], [null], {}, { a: 1 }, { a: null }, { a: 'x', b: 1 },
];

const ANNOTATION_KEYS = ['title', 'description', 'default', 'x-note', 'examples', 'deprecated', '$comment'];
const TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'] as const;

export interface GenOptions {
  boost: readonly string[];
  allowLoops: boolean;
}

interface Env {
  options: GenOptions;
  budget: number;
  refs: string[];
  bodies: Map<string, Json>;
  container: '$defs' | 'definitions';
}

type Adder = (node: JsonObject, rng: Rng, depth: number, env: Env) => void;

const names = (rng: Rng, count: number): string[] => rng.shuffle(NAMES).slice(0, count);
const sampleValues = (rng: Rng, count: number): Json[] => Array.from({ length: count }, () => structuredClone(rng.pick(VALUES)));
const bound = (rng: Rng): number => rng.pick([0, 1, 2, 3]);

const child = (rng: Rng, depth: number, env: Env): Json => build(rng, depth - 1, env);

const referenceNode = (rng: Rng, env: Env): Json => {
  const reference = rng.pick(env.refs);
  const node: JsonObject = { $ref: reference };
  const target = env.bodies.get(reference);
  const variant = rng.next();
  if (variant < 0.35) return node;
  if (variant < 0.5) {
    node[rng.pick(['title', 'description'])] = rng.pick(['n', 'm']);
    if (rng.chance(0.3)) node['default'] = rng.pick<Json>([1, 'n', null]);
  } else if (variant < 0.8) {
    const pool = ['type', 'minimum', 'maximum', 'minLength', 'required', 'minContains', 'maxContains', 'minProperties', 'maxItems', 'uniqueItems', 'pattern', 'multipleOf'];
    const present = target !== undefined && typeof target === 'object' && target !== null && !Array.isArray(target) ? pool.filter((entry) => entry in target) : [];
    const hasContains = target !== undefined && typeof target === 'object' && target !== null && !Array.isArray(target) && 'contains' in target;
    const key = hasContains && rng.chance(0.6) ? rng.pick(['minContains', 'maxContains']) : present.length > 0 && rng.chance(0.5) ? rng.pick(present) : rng.pick(pool);
    node[key] = ({
      type: rng.pick(TYPES),
      minimum: rng.pick([0, 1]),
      maximum: rng.pick([1, 5]),
      minLength: 1,
      required: [rng.pick(NAMES)],
      minContains: rng.pick([0, 1, 2]),
      maxContains: rng.pick([0, 1, 2]),
      minProperties: 1,
      maxItems: 2,
      uniqueItems: true,
      pattern: rng.pick(PATTERNS).pattern,
      multipleOf: 2,
    } as Record<string, Json>)[key] as Json;
  } else {
    const key = rng.pick(['properties', 'items', 'allOf', 'additionalProperties', 'not', 'anyOf', 'unevaluatedProperties', 'unevaluatedItems', 'patternProperties', 'contains']);
    node[key] = ({
      properties: { b: {} },
      items: { type: 'string' },
      allOf: [{ required: ['a'] }],
      additionalProperties: false,
      not: { type: 'null' },
      anyOf: [{ type: 'string' }, { type: 'number' }],
      unevaluatedProperties: false,
      patternProperties: { '^a': { type: 'string' } },
      unevaluatedItems: false,
      contains: { type: 'string' },
    } as Record<string, Json>)[key] as Json;
  }
  return node;
};

const adders: Record<string, Adder> = {
  type: (node, rng) => {
    node['type'] = rng.pick(TYPES);
  },
  typeArray: (node, rng) => {
    const count = rng.range(2, 3);
    node['type'] = rng.shuffle(TYPES).slice(0, count);
    if (rng.chance(0.4) && !(node['type'] as string[]).includes('null')) (node['type'] as string[]).push('null');
  },
  properties: (node, rng, depth, env) => {
    const properties: JsonObject = {};
    for (const name of names(rng, rng.range(1, 3))) properties[name] = child(rng, depth, env);
    node['properties'] = properties;
  },
  required: (node, rng) => {
    const pool = new Set<string>();
    const properties = node['properties'];
    const own = typeof properties === 'object' && properties !== null && !Array.isArray(properties) ? Object.keys(properties) : [];
    for (const name of own) if (rng.chance(0.6)) pool.add(name);
    if (rng.chance(0.4) || pool.size === 0) pool.add(rng.pick(NAMES));
    node['required'] = [...pool];
  },
  additionalProperties: (node, rng, depth, env) => {
    const choice = rng.next();
    node['additionalProperties'] = choice < 0.3 ? false : choice < 0.5 ? true : child(rng, depth, env);
  },
  patternProperties: (node, rng, depth, env) => {
    const entries: JsonObject = {};
    for (const sample of rng.shuffle(PATTERNS).slice(0, rng.range(1, 2))) entries[sample.pattern] = child(rng, depth, env);
    node['patternProperties'] = entries;
  },
  propertyNames: (node, rng) => {
    node['propertyNames'] = rng.pick<Json>([{ pattern: rng.pick(PATTERNS).pattern }, { maxLength: 2 }, { enum: ['a', 'b', 'ab'] }, { minLength: 1 }, false]);
  },
  minProperties: (node, rng) => {
    node['minProperties'] = bound(rng);
  },
  maxProperties: (node, rng) => {
    node['maxProperties'] = bound(rng) + 1;
  },
  dependentRequired: (node, rng) => {
    const [trigger, other] = names(rng, 2) as [string, string];
    node['dependentRequired'] = { [trigger]: [other] };
  },
  dependentSchemas: (node, rng, depth, env) => {
    node['dependentSchemas'] = { [rng.pick(NAMES)]: child(rng, depth, env) };
  },
  unevaluatedProperties: (node, rng, depth, env) => {
    const choice = rng.next();
    node['unevaluatedProperties'] = choice < 0.55 ? false : choice < 0.7 ? true : child(rng, depth, env);
  },
  items: (node, rng, depth, env) => {
    node['items'] = child(rng, depth, env);
  },
  prefixItems: (node, rng, depth, env) => {
    node['prefixItems'] = Array.from({ length: rng.range(1, 2) }, () => child(rng, depth, env));
  },
  contains: (node, rng, depth, env) => {
    node['contains'] = rng.chance(0.5) ? { type: rng.pick(TYPES) } : child(rng, depth, env);
    if (rng.chance(0.5)) node['minContains'] = rng.pick([0, 1, 2]);
    if (rng.chance(0.4)) node['maxContains'] = rng.pick([0, 1, 2]);
  },
  minContains: (node, rng) => {
    node['minContains'] = rng.pick([0, 1, 2]);
  },
  maxContains: (node, rng) => {
    node['maxContains'] = rng.pick([0, 1, 2]);
  },
  minItems: (node, rng) => {
    node['minItems'] = bound(rng);
  },
  maxItems: (node, rng) => {
    node['maxItems'] = bound(rng) + 1;
  },
  uniqueItems: (node) => {
    node['uniqueItems'] = true;
  },
  unevaluatedItems: (node, rng, depth, env) => {
    const choice = rng.next();
    node['unevaluatedItems'] = choice < 0.55 ? false : choice < 0.7 ? true : child(rng, depth, env);
  },
  enum: (node, rng) => {
    node['enum'] = sampleValues(rng, rng.range(1, 4));
  },
  const: (node, rng) => {
    node['const'] = structuredClone(rng.pick(VALUES));
  },
  pattern: (node, rng) => {
    node['pattern'] = rng.pick(PATTERNS).pattern;
  },
  minLength: (node, rng) => {
    node['minLength'] = bound(rng);
  },
  maxLength: (node, rng) => {
    node['maxLength'] = bound(rng) + 1;
  },
  minimum: (node, rng) => {
    node['minimum'] = rng.pick([-1, 0, 1, 2, 2.5]);
  },
  maximum: (node, rng) => {
    node['maximum'] = rng.pick([0, 1, 2, 2.5, 10]);
  },
  exclusiveMinimum: (node, rng) => {
    node['exclusiveMinimum'] = rng.pick([-1, 0, 1]);
  },
  exclusiveMaximum: (node, rng) => {
    node['exclusiveMaximum'] = rng.pick([1, 2, 10]);
  },
  multipleOf: (node, rng) => {
    node['multipleOf'] = rng.pick([1, 2, 0.5]);
  },
  allOf: (node, rng, depth, env) => {
    node['allOf'] = Array.from({ length: rng.range(1, 3) }, () => child(rng, depth, env));
  },
  anyOf: (node, rng, depth, env) => {
    node['anyOf'] = Array.from({ length: rng.range(1, 3) }, () => child(rng, depth, env));
  },
  oneOf: (node, rng, depth, env) => {
    if (rng.chance(0.4)) {
      adders['oneOfOverlap']?.(node, rng, depth, env);
      return;
    }
    node['oneOf'] = Array.from({ length: rng.range(1, 3) }, () => child(rng, depth, env));
  },
  not: (node, rng, depth, env) => {
    node['not'] = child(rng, depth, env);
  },
  if: (node, rng, depth, env) => {
    node['if'] = child(rng, depth, env);
    if (rng.chance(0.8)) node['then'] = child(rng, depth, env);
    if (rng.chance(0.6)) node['else'] = child(rng, depth, env);
  },
  oneOfOverlap: (node, rng) => {
    const pool: Json[] = [true, {}, { type: rng.pick(TYPES) }, { type: [rng.pick(TYPES.filter((entry) => entry !== 'null')), 'null'] }];
    node['oneOf'] = rng.shuffle(pool).slice(0, rng.range(2, 3));
  },
  containsMax: (node, rng) => {
    node['contains'] = rng.chance(0.7) ? { type: rng.pick(TYPES) } : {};
    node['maxContains'] = rng.pick([0, 1, 2]);
    if (rng.chance(0.5)) node['minContains'] = rng.pick([0, 1]);
    if (rng.chance(0.5)) node['type'] = 'array';
  },
  refDependency: (node, rng, _depth, env) => {
    if (env.refs.length === 0) return;
    node['allOf'] = [referenceNode(rng, env)];
    node[rng.pick(['unevaluatedProperties', 'unevaluatedItems'])] = false;
    if (rng.chance(0.4)) node['additionalProperties'] = rng.pick<Json>([false, true]);
  },
  annotation: (node, rng) => {
    const key = rng.pick(ANNOTATION_KEYS);
    node[key] = key === 'examples' ? ['q'] : key === 'deprecated' ? true : key === 'default' || key === 'x-note' ? rng.pick<Json>(['n', 1, { a: 1 }]) : 'n';
  },
};

const OBJECT_ADDERS = ['properties', 'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames', 'minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas', 'unevaluatedProperties'];
const ARRAY_ADDERS = ['items', 'items', 'prefixItems', 'contains', 'minItems', 'maxItems', 'uniqueItems', 'unevaluatedItems'];
const STRING_ADDERS = ['pattern', 'minLength', 'maxLength'];
const NUMBER_ADDERS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const COMBINATORS = ['allOf', 'anyOf', 'oneOf', 'not', 'if'];

const apply = (name: string, node: JsonObject, rng: Rng, depth: number, env: Env): void => {
  const adder = adders[name];
  if (adder === undefined) throw new Error(`unknown adder ${name}`);
  adder(node, rng, depth, env);
};

const scalarLeaf = (rng: Rng): Json => {
  const type = rng.pick(TYPES);
  return rng.chance(0.2) && type !== 'null' ? { type: [type, 'null'] } : { type };
};

const build = (rng: Rng, depth: number, env: Env): Json => {
  env.budget -= 1;
  if (depth <= 0 || env.budget <= 0) {
    const leaf = rng.next();
    if (leaf < 0.15) return true;
    if (leaf < 0.25) return false;
    if (leaf < 0.4) return {};
    if (leaf < 0.5 && env.refs.length > 0) return referenceNode(rng, env);
    return scalarLeaf(rng);
  }
  if (env.refs.length > 0 && rng.chance(0.1)) return referenceNode(rng, env);
  const node: JsonObject = {};
  const shape = rng.next();
  if (shape < 0.26) {
    if (rng.chance(0.85)) node['type'] = 'object';
    for (const name of rng.shuffle(OBJECT_ADDERS).slice(0, rng.range(1, 5))) apply(name, node, rng, depth, env);
  } else if (shape < 0.4) {
    if (rng.chance(0.85)) node['type'] = 'array';
    for (const name of rng.shuffle(ARRAY_ADDERS).slice(0, rng.range(1, 3))) apply(name, node, rng, depth, env);
  } else if (shape < 0.48) {
    node['type'] = 'string';
    for (const name of rng.shuffle(STRING_ADDERS).slice(0, rng.range(0, 2))) apply(name, node, rng, depth, env);
  } else if (shape < 0.56) {
    node['type'] = rng.pick(['number', 'integer']);
    for (const name of rng.shuffle(NUMBER_ADDERS).slice(0, rng.range(0, 2))) apply(name, node, rng, depth, env);
  } else if (shape < 0.6) {
    node['type'] = rng.pick(['boolean', 'null']);
  } else if (shape < 0.7) {
    apply('typeArray', node, rng, depth, env);
    const arrayTypes = node['type'] as string[];
    if (arrayTypes.includes('object') && rng.chance(0.7)) for (const name of rng.shuffle(OBJECT_ADDERS).slice(0, 2)) apply(name, node, rng, depth, env);
    if (arrayTypes.includes('string') && rng.chance(0.3)) apply('pattern', node, rng, depth, env);
    if (rng.chance(0.4)) apply('enum', node, rng, depth, env);
  } else if (shape < 0.8) {
    const mode = rng.next();
    if (mode < 0.4) apply('enum', node, rng, depth, env);
    else if (mode < 0.7) apply('const', node, rng, depth, env);
    else {
      apply('enum', node, rng, depth, env);
      apply('const', node, rng, depth, env);
    }
    if (rng.chance(0.5)) apply('type', node, rng, depth, env);
    else if (rng.chance(0.2)) apply('typeArray', node, rng, depth, env);
    if (rng.chance(0.3)) apply(rng.pick([...STRING_ADDERS, ...NUMBER_ADDERS]), node, rng, depth, env);
  } else if (shape < 0.9) {
    const pool = rng.shuffle([...OBJECT_ADDERS, ...ARRAY_ADDERS, ...STRING_ADDERS, ...NUMBER_ADDERS]);
    for (const name of pool.slice(0, rng.range(0, 3))) apply(name, node, rng, depth, env);
  } else {
    node['type'] = rng.pick(TYPES);
  }
  const combinatorCount = rng.chance(0.5) ? rng.range(1, 2) : 0;
  for (const name of rng.shuffle(COMBINATORS).slice(0, combinatorCount)) apply(name, node, rng, depth, env);
  if (rng.chance(0.15)) apply('annotation', node, rng, depth, env);
  for (const name of env.options.boost) {
    if (rng.chance(0.3) && !(name in node) && name in adders) apply(name, node, rng, depth, env);
  }
  return node;
};

const buildDefinitions = (rng: Rng, depth: number, env: Env): JsonObject => {
  const defs: JsonObject = {};
  const count = rng.range(1, 3);
  for (let index = 0; index < count; index += 1) {
    const name = `d${index}`;
    const pointer = `#/${env.container}/${name}`;
    const loops = env.options.allowLoops && rng.chance(0.2);
    const built = build(rng, depth - 1, env);
    const body: JsonObject = typeof built === 'object' && built !== null && !Array.isArray(built) ? built : { type: 'object' };
    if (rng.chance(0.4)) apply(rng.pick(['additionalProperties', 'unevaluatedProperties']), body, rng, depth - 2, env);
    if (rng.chance(0.5)) apply(rng.pick(['properties', 'patternProperties', 'prefixItems', 'items', 'containsMax', 'allOf']), body, rng, depth - 2, env);
    if (loops) {
      const target = rng.chance(0.3) ? '#' : pointer;
      const recursive: JsonObject = { $ref: target };
      if (rng.chance(0.5)) {
        body['properties'] = { ...((body['properties'] as JsonObject | undefined) ?? {}), next: recursive };
      } else {
        body['items'] = recursive;
      }
    }
    defs[name] = body;
    env.refs.push(pointer);
    env.bodies.set(pointer, body);
  }
  return defs;
};

const MARGIN = 5;

const buildRoot = (rng: Rng, env: Env, objectShaped: boolean): JsonObject => {
  let root: JsonObject;
  if (objectShaped) {
    root = { type: 'object' };
    const count = rng.range(1, 4);
    const properties: JsonObject = {};
    for (const name of names(rng, count)) properties[name] = build(rng, MARGIN - 1, env);
    root['properties'] = properties;
    if (rng.chance(0.5)) apply('required', root, rng, MARGIN, env);
    if (rng.chance(0.3)) apply('additionalProperties', root, rng, MARGIN, env);
    if (rng.chance(0.15)) apply(rng.pick(['unevaluatedProperties', 'patternProperties', 'dependentRequired']), root, rng, MARGIN, env);
    if (rng.chance(0.2)) apply(rng.pick(COMBINATORS), root, rng, MARGIN, env);
  } else {
    const built = build(rng, MARGIN, env);
    root = typeof built === 'object' && built !== null && !Array.isArray(built) ? built : { type: 'object' };
  }
  return root;
};

const rewriteRefsToContainer = (value: Json, from: string, to: string): void => {
  if (Array.isArray(value)) {
    value.forEach((entry) => rewriteRefsToContainer(entry, from, to));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const key of Object.keys(value)) {
    const entry = value[key] as Json;
    if (key === '$ref' && typeof entry === 'string') value[key] = entry.replace(`#/${from}/`, `#/${to}/`);
    else rewriteRefsToContainer(entry, from, to);
  }
};

export interface GeneratedCase {
  schema: Json | null;
  site: Site;
}

export const generateCase = (rng: Rng, options: GenOptions): GeneratedCase => {
  const site: Site = rng.chance(0.28) ? 'tool-parameters' : 'response-format';
  if (site === 'tool-parameters') {
    const choice = rng.next();
    if (choice < 0.1) return { schema: null, site };
    if (choice < 0.18) return { schema: {}, site };
    if (choice < 0.26) return { schema: { type: 'object' }, site };
    if (choice < 0.3) return { schema: rng.pick([true, false]), site };
  } else if (rng.chance(0.04)) {
    return { schema: rng.pick<Json>([true, false, {}]), site };
  }
  const container = rng.chance(0.7) ? '$defs' : 'definitions';
  const env: Env = { options, budget: 40, refs: [], bodies: new Map(), container };
  const useDefs = rng.chance(0.45);
  const defs = useDefs ? buildDefinitions(rng, MARGIN - 1, env) : undefined;
  const root = buildRoot(rng, env, site === 'tool-parameters');
  if (defs !== undefined) root[container] = defs;
  if (env.refs.length > 0 && rng.chance(0.3)) {
    const properties = (root['properties'] as JsonObject | undefined) ?? {};
    properties['r'] = referenceNode(rng, env);
    root['properties'] = properties;
  }
  if (!useDefs && rng.chance(0.06) && typeof root['properties'] === 'object' && root['properties'] !== null) {
    const properties = root['properties'] as JsonObject;
    const first = Object.keys(properties)[0];
    if (first !== undefined) properties['p'] = { $ref: `#/properties/${first}` };
  }
  if (container === 'definitions') rewriteRefsToContainer(root, '$defs', 'definitions');
  if (rng.chance(0.5)) root['$schema'] = 'https://json-schema.org/draft/2020-12/schema';
  return { schema: root, site };
};
