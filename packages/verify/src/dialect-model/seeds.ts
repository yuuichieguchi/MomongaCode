import { BUILTINS, type Definition, type Rule } from './definition.ts';
import { checkCase, type CheckClass, type Failure } from './harness.ts';
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
];

export interface SeedOutcome {
  name: string;
  failure: Failure | null;
  assertion: string | null;
  summary: string;
}

export const runSeed = (seed: Seed): SeedOutcome => {
  const failure = checkCase({ schema: seed.schema, site: seed.site, definition: seed.definition, cls: seed.cls, seed: 1, perDocument: 60, forcedInstances: seed.witnesses });
  const rendered = render(seed.schema, seed.definition, seed.site);
  const assertion = seed.assertRendered === undefined ? null : seed.assertRendered(rendered);
  const summary = rendered.ok ? `rendered ${JSON.stringify(rendered.schema ?? null)}` : `render failed: ${rendered.reason}`;
  return { name: seed.name, failure, assertion, summary };
};
