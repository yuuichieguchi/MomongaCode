import { BUILTINS, type Definition, type Rule } from './definition.ts';
import { checkCase, emptyStats, type CheckClass, type Failure } from './harness.ts';
import type { Json } from './json.ts';
import type { Rendered } from './render.ts';
import { render } from './render.ts';
import type { Site } from './selector.ts';

export interface Seed {
  name: string;
  schema: Json | null;
  site: Site;
  definition: Definition;
  cls: CheckClass;
  witnesses: Json[];
  assertRendered?: (rendered: Rendered) => string | null;
}

const only = (rule: Record<string, Json>): Definition => ({ rules: [{ select: [{ kinds: ['any'] }], ...rule } as unknown as Rule] });

const WITNESSES: Json[] = [{}, { a: 1 }, { b: 1 }, { a: 'x' }, { ab: 'x' }, { a: 1, b: 2 }, 'x', 1, null, [], { a: null }, ['a'], [1]];

export const SEEDS: Seed[] = [
  { name: 'declare-required: additionalProperties false', schema: { required: ['a'], additionalProperties: false }, site: 'response-format', definition: only({ op: 'declare-required' }), cls: 'P', witnesses: WITNESSES },
  { name: 'declare-required: additionalProperties false, type object', schema: { type: 'object', required: ['a'], additionalProperties: false }, site: 'response-format', definition: only({ op: 'declare-required' }), cls: 'P', witnesses: WITNESSES },
  { name: 'declare-required: schema-valued additionalProperties', schema: { required: ['a'], additionalProperties: { type: 'string' } }, site: 'response-format', definition: only({ op: 'declare-required' }), cls: 'P', witnesses: WITNESSES },
  { name: 'declare-required: patternProperties', schema: { required: ['a'], patternProperties: { '^a': { type: 'string' } } }, site: 'response-format', definition: only({ op: 'declare-required' }), cls: 'P', witnesses: WITNESSES },
  {
    name: 'inline-refs: $ref with properties sibling over additionalProperties false',
    schema: { $ref: '#/$defs/T', properties: { b: {} }, $defs: { T: { additionalProperties: false } } },
    site: 'response-format',
    definition: only({ op: 'inline-refs' }),
    cls: 'P',
    witnesses: WITNESSES,
  },
  { name: 'fill-type: not {}', schema: { not: {} }, site: 'response-format', definition: only({ op: 'fill-type', fallback: 'string' }), cls: 'N', witnesses: WITNESSES },
  { name: 'fill-type: if {}', schema: { if: {}, then: { required: ['a'] } }, site: 'response-format', definition: only({ op: 'fill-type', fallback: 'string' }), cls: 'N', witnesses: WITNESSES },
  { name: 'split-enum: type string, enum a and null', schema: { type: 'string', enum: ['a', null] }, site: 'response-format', definition: only({ op: 'split-enum' }), cls: 'P', witnesses: ['a', null, 1] },
  { name: 'split-type-array: object or null with properties', schema: { type: ['object', 'null'], properties: { a: { type: 'string' } }, required: ['a'] }, site: 'response-format', definition: only({ op: 'split-type-array' }), cls: 'P', witnesses: [null, {}, { a: 'x' }, { a: 1 }, 'x'] },
  { name: 'split-type-array: string or null with enum a', schema: { type: ['string', 'null'], enum: ['a'] }, site: 'response-format', definition: only({ op: 'split-type-array' }), cls: 'P', witnesses: ['a', null, 'b'] },
  { name: 'ensure-key additionalProperties true: unevaluatedProperties false on the node', schema: { properties: { a: {} }, unevaluatedProperties: false }, site: 'response-format', definition: only({ op: 'ensure-key', key: 'additionalProperties', value: true }), cls: 'P', witnesses: WITNESSES },
  { name: 'ensure-key additionalProperties true: unevaluatedProperties false on the allOf parent', schema: { allOf: [{ properties: { a: {} } }], unevaluatedProperties: false }, site: 'response-format', definition: only({ op: 'ensure-key', key: 'additionalProperties', value: true }), cls: 'P', witnesses: WITNESSES },
  { name: 'declare-required: unevaluatedProperties false on the allOf parent', schema: { allOf: [{ required: ['a'] }], unevaluatedProperties: false }, site: 'response-format', definition: only({ op: 'declare-required' }), cls: 'P', witnesses: WITNESSES },
  { name: 'declare-required: unevaluatedProperties false on the node', schema: { required: ['a'], unevaluatedProperties: false }, site: 'response-format', definition: only({ op: 'declare-required' }), cls: 'P', witnesses: WITNESSES },
  { name: 'const-as-enum: const outside enum', schema: { const: 'a', enum: ['b'] }, site: 'response-format', definition: only({ op: 'const-as-enum' }), cls: 'P', witnesses: ['a', 'b'] },
  {
    name: 'explicit-keys: parameters {}',
    schema: {},
    site: 'tool-parameters',
    definition: BUILTINS['explicit-keys'] as Definition,
    cls: 'N',
    witnesses: WITNESSES,
    assertRendered: (rendered) => {
      if (!rendered.ok) return `render failed: ${rendered.reason}`;
      const schema = rendered.schema;
      return typeof schema === 'object' && schema !== null && !Array.isArray(schema) && schema['type'] === 'object' ? null : 'rendered root is not an object type';
    },
  },
  { name: 'require-all: required name that is not a property', schema: { properties: {}, required: ['x'] }, site: 'response-format', definition: only({ op: 'require-all' }), cls: 'N', witnesses: WITNESSES },
  { name: 'fill-type: oneOf with overlapping branches', schema: { type: 'array', oneOf: [true, {}] }, site: 'response-format', definition: only({ op: 'fill-type', fallback: 'number' }), cls: 'N', witnesses: [[], [1], 'x', null] },
  { name: 'ensure-key additionalProperties false: oneOf branch', schema: { additionalProperties: true, oneOf: [{}, true] }, site: 'response-format', definition: only({ op: 'ensure-key', key: 'additionalProperties', value: false }), cls: 'N', witnesses: WITNESSES },
  { name: 'inline-refs: minContains beside a $ref whose target has contains', schema: { properties: { r: { $ref: '#/$defs/d0', minContains: 0 } }, $defs: { d0: { contains: {} } } }, site: 'response-format', definition: only({ op: 'inline-refs' }), cls: 'P', witnesses: [{ r: [] }, { r: [1] }, {}] },
  { name: 'drop: properties beside additionalProperties', schema: { additionalProperties: false, properties: { foo: true } }, site: 'response-format', definition: only({ op: 'drop', keys: ['properties'] }), cls: 'W', witnesses: [{ foo: null }, { foo: 1 }, { bar: 1 }, {}] },
  { name: 'drop: patternProperties beside additionalProperties', schema: { additionalProperties: false, patternProperties: { '^a': true } }, site: 'response-format', definition: only({ op: 'drop', keys: ['patternProperties'] }), cls: 'W', witnesses: [{ ab: 1 }, { zz: 1 }, {}] },
  { name: 'drop: properties beside unevaluatedProperties', schema: { properties: { zz: true }, unevaluatedProperties: false }, site: 'response-format', definition: only({ op: 'drop', keys: ['properties'] }), cls: 'W', witnesses: [{ zz: null }, {}] },
  { name: 'drop: prefixItems beside unevaluatedItems', schema: { unevaluatedItems: false, prefixItems: [{}] }, site: 'response-format', definition: only({ op: 'drop', keys: ['prefixItems'] }), cls: 'W', witnesses: [[null], [], [1, 2]] },
  { name: 'drop: items beside unevaluatedItems', schema: { unevaluatedItems: false, items: {} }, site: 'response-format', definition: only({ op: 'drop', keys: ['items'] }), cls: 'W', witnesses: [[null], [], [1, 2]] },
  { name: 'drop: type under contains with maxContains', schema: { contains: { type: 'boolean' }, maxContains: 1 }, site: 'response-format', definition: only({ op: 'drop', keys: ['type'] }), cls: 'W', witnesses: [[false, null], [false], [], [1]] },
  { name: 'drop: type inside a oneOf branch', schema: { oneOf: [{}, { type: ['null'] }] }, site: 'response-format', definition: only({ op: 'drop', keys: ['type'] }), cls: 'W', witnesses: [true, null, 1] },
  { name: 'drop: prefixItems in a $ref target beside unevaluatedItems', schema: { $ref: '#/$defs/d0', unevaluatedItems: false, $defs: { d0: { prefixItems: [{}] } } }, site: 'response-format', definition: only({ op: 'drop', keys: ['prefixItems'] }), cls: 'W', witnesses: [[null], [], [1, 2]] },
  { name: 'drop: items in an allOf element beside unevaluatedItems', schema: { allOf: [{ items: {} }], unevaluatedItems: false }, site: 'response-format', definition: only({ op: 'drop', keys: ['items'] }), cls: 'W', witnesses: [[null], [], [1, 2]] },
];

export interface SeedOutcome {
  name: string;
  failure: Failure | null;
  assertion: string | null;
  summary: string;
}

export const runSeed = (seed: Seed): SeedOutcome => {
  const stats = emptyStats();
  const checked = checkCase({ schema: seed.schema, site: seed.site, definition: seed.definition, cls: seed.cls, seed: 1, perDocument: 60, forcedInstances: seed.witnesses, stats });
  const refusal = Object.keys(stats.refused)[0];
  const failure: Failure | null = checked ?? (refusal === undefined ? null : { kind: 'oracle-error', detail: `seed refused by the boundary: ${refusal}` });
  const rendered = render(seed.schema, seed.definition, seed.site);
  const assertion = seed.assertRendered === undefined ? null : seed.assertRendered(rendered);
  const summary = rendered.ok ? `rendered ${JSON.stringify(rendered.schema ?? null)}` : `render failed: ${rendered.reason}`;
  return { name: seed.name, failure, assertion, summary };
};
