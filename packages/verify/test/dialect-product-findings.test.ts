import { describe, expect, it } from 'vitest';
import { allowedDropKeys } from './support/dialect-model/primitives.ts';
import { checkCase, emptyStats, isDeletionOf, type CheckClass } from './support/dialect-model/harness.ts';
import type { Definition, Rule } from './support/dialect-model/definition.ts';
import { render, type Rendered } from './support/dialect-model/render.ts';
import type { Site } from './support/dialect-model/selector.ts';
import { BUILTINS } from './support/dialect-model/definition.ts';
import { productRenderer } from './dialect-product.test.ts';

const ANY = [{ kinds: ['any'] }];
const rules = (...entries: Record<string, unknown>[]): Definition => ({ rules: entries as unknown as Rule[] });
const shape = (rendered: Rendered): unknown => (rendered.ok ? { ok: true, schema: rendered.schema } : { ok: false, reason: rendered.reason });

const bothRender = (schema: unknown, definition: Definition, site: Site = 'response-format'): void => {
  expect(shape(productRenderer(schema as never, definition, site))).toEqual(shape(render(schema as never, definition, site)));
};

const bothDecide = (schema: unknown, definition: Definition, decided: unknown, site: Site = 'response-format'): void => {
  expect(shape(productRenderer(schema as never, definition, site)), 'product').toEqual(decided);
  expect(shape(render(schema as never, definition, site)), 'model').toEqual(decided);
};

const soundUnderOracle = async (schema: unknown, definition: Definition, cls: CheckClass, witnesses: unknown[], renderer?: typeof productRenderer): Promise<unknown> =>
  await checkCase({ schema: schema as never, site: 'response-format', definition, cls, seed: 1, perDocument: 20, forcedInstances: witnesses as never, stats: emptyStats(), ...(renderer === undefined ? {} : { renderer }) });

describe('(a) one renders and the other fails', () => {
  it('ensure-key additionalProperties true on a node that carries unevaluatedProperties false and is not object-like (primitives.ts:67 guards on isObjectLike; the design fails with dependency)', async () => {
    bothRender({ anyOf: [{ unevaluatedProperties: false }] }, rules({ select: ANY, op: 'ensure-key', key: 'additionalProperties', value: true }));
  });

  it('ensure-key additionalProperties false on an untyped node under contains with maxContains (same guard; the design fails with polarity)', async () => {
    bothRender({ contains: {}, maxContains: 1 }, rules({ select: [{ kinds: ['untyped'] }], op: 'ensure-key', key: 'additionalProperties', value: false }));
  });

  it('drop whose keys feed unevaluatedItems through a $ref site (drop.ts:34 fails dependency; the design cascades the unevaluated keyword)', async () => {
    bothRender(
      { allOf: [{ $ref: '#/$defs/d0', unevaluatedItems: false }], $defs: { d0: { allOf: [{ anyOf: [] }] } } },
      rules({ select: ANY, op: 'drop', keys: ['prefixItems', 'items', 'anyOf'] }),
    );
  });

  it('object-without-properties on a node with an empty in-place applicator (select.ts:19 counts presence; the model ignores the empty array)', async () => {
    bothRender({ type: 'object', anyOf: [], required: ['foo'], unevaluatedProperties: false }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'declare-required' }));
  });

  it('reject on object-without-properties with an empty dependentSchemas', async () => {
    bothRender({ type: 'object', dependentSchemas: {} }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'reject', keys: ['dependentSchemas'] }));
  });

  it('decision 29 rule 2: the boolean subschema true under oneOf is the untyped node {}, so typing it at a mixed position fails with polarity', async () => {
    bothDecide({ oneOf: [true] }, rules({ select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'string' }), { ok: false, reason: 'polarity' });
  });

  it('decision 29 rule 3: a type array of one entry [object] selects the object kinds, so closing it under oneOf fails with polarity', async () => {
    bothDecide({ anyOf: [{ oneOf: [{ type: ['object'] }] }] }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'always' }), { ok: false, reason: 'polarity' });
  });

  it('type [] with properties under split-type-array: the model calls it unsatisfiable, the product does not select it', async () => {
    bothRender({ type: [], properties: {} }, rules({ select: [{ kinds: ['object-with-properties'] }], op: 'split-type-array' }));
  });

  it('a $schema sibling beside a $ref under inline-refs (inline-refs.ts:13-21 merges it; the model fails ref-sibling)', async () => {
    bothRender({ $ref: '#/$defs/d1', $defs: { d1: {} }, $schema: 'https://json-schema.org/draft/2020-12/schema' }, rules({ select: [{ kinds: ['root'] }], op: 'inline-refs' }));
  });

  it('inline-refs selected below the document root (primitives.ts:143 passes the selected node as the pointer root; inline-refs.ts:33-36 then fails construct for a $ref into the document $defs)', async () => {
    bothRender(
      { $defs: { d: { type: 'string' } }, properties: { p: { type: 'object', properties: { q: { $ref: '#/$defs/d' } } } } },
      rules({ select: [{ kinds: ['object-with-properties'], within: { below: ['properties'], through: ['properties'] } }], op: 'inline-refs' }),
    );
  });

  it('decision 29 rule 3: split-enum selects a type [object] node inside oneOf and fails as unsatisfiable when no enum value remains', async () => {
    bothDecide({ oneOf: [{ type: ['object'], enum: [] }] }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'split-enum' }), { ok: false, reason: 'unsatisfiable' });
  });
});

describe('(b) both render and the soundness verdict differs', () => {
  it('decision 29 rule 1: dropping minContains 0 drops contains with it, so the model render still accepts []', async () => {
    const definition = rules({ select: ANY, op: 'drop', keys: ['minContains'] });
    expect(await soundUnderOracle({ type: 'array', contains: {}, minContains: 0 }, definition, 'W', [[], [1]])).toBeNull();
  });

  it('decision 29 rule 1: the model oracle accepts the removal of contains with minContains 0 as part of the drop', async () => {
    const definition = rules({ select: ANY, op: 'drop', keys: ['minContains'] });
    const original = { type: 'array', contains: {}, minContains: 0 };
    const rendered = productRenderer(original as never, definition, 'response-format');
    expect(rendered.ok && isDeletionOf(original as never, rendered.schema as never, allowedDropKeys(['minContains']))).toBe(true);
  });
});

describe('(c) both render, both sound, the output differs', () => {
  it('fill-type on an enum node: the product infers a type from the values (primitives.ts:28), the model writes the fallback', async () => {
    bothRender({ enum: [{}, 1] }, rules({ select: [{ kinds: ['const'] }, { kinds: ['root'] }], op: 'fill-type', fallback: 'number' }));
  });

  it('decision 29 rule 2: label treats true as {} and writes an object node, and leaves false alone', async () => {
    bothDecide({ properties: { a: false, b: true } }, rules({ select: ANY, op: 'label', key: 'x-label' }), {
      ok: true,
      schema: { 'x-label': 'root', properties: { a: false, b: { 'x-label': 'root_b' } } },
    });
  });

  it('decision 29 rule 4: the label path of a oneOf branch is root_oneOf_0', async () => {
    bothDecide({ oneOf: [{}] }, rules({ select: ANY, op: 'label', key: 'x-label' }), { ok: true, schema: { 'x-label': 'root', oneOf: [{ 'x-label': 'root_oneOf_0' }] } });
  });

  it('decision 29 rule 2: explicit-keys renders the boolean schema true as it renders {}', async () => {
    bothDecide(true, BUILTINS['explicit-keys'] as Definition, {
      ok: true,
      schema: { type: 'object', properties: {}, 'x-order': [], additionalProperties: false },
    });
  });

  it('require-all on properties {}: the model writes required [] (a no-op), the product does not', async () => {
    bothRender({ properties: {} }, rules({ select: ANY, op: 'require-all' }));
  });

  it('decision 29 rule 2: ensure-key properties {} reaches the boolean schema true as the node {}', async () => {
    bothDecide({ dependentSchemas: { foo: true } }, rules({ select: ANY, op: 'ensure-key', key: 'properties', value: {} }), {
      ok: true,
      schema: { properties: {}, dependentSchemas: { foo: { properties: {} } } },
    });
  });

  it('split-enum on object-without-properties with an empty oneOf', async () => {
    bothRender({ type: 'object', oneOf: [], enum: [{}, []] }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'split-enum' }));
  });

  it('split-type-array on type [boolean] with properties', async () => {
    bothRender({ type: ['boolean'], properties: {} }, rules({ select: [{ kinds: ['type-boolean', 'object-with-properties'] }], op: 'split-type-array' }));
  });

  it('decision 29, the literal reading: a node with a properties map is an object for property-order, whatever its type', async () => {
    bothDecide({ type: ['array'], properties: {} }, rules({ select: [{ kinds: ['array'] }], op: 'property-order', key: 'propertyOrdering' }), {
      ok: true,
      schema: { type: ['array'], properties: {}, propertyOrdering: [] },
    });
  });

  it('object-with-properties on a non-object type that carries a properties map (select.ts:18 requires an object type; the model accepts any type)', async () => {
    bothRender({ type: 'string', properties: {} }, rules({ select: [{ kinds: ['object-with-properties'] }], op: 'drop', keys: ['properties'] }));
  });

  it('decision 29 rule 3: closing applies to type [object]', async () => {
    bothDecide({ type: ['object'] }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false }), {
      ok: true,
      schema: { type: ['object'], additionalProperties: false },
    });
  });
});

describe('decision 29: the four rules stated by JSON Schema meaning', () => {
  const close = rules({ select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false });
  const label = rules({ select: ANY, op: 'label', key: 'x-label' });

  it('rule 1: the model render of drop minContains 0 removes contains with it', async () => {
    expect(shape(render({ type: 'array', contains: {}, minContains: 0 } as never, rules({ select: ANY, op: 'drop', keys: ['minContains'] }), 'response-format'))).toEqual({ ok: true, schema: { type: 'array' } });
  });

  it('rule 1: the model render accepts the empty array under a property after drop minContains 0', async () => {
    const definition = rules({ select: ANY, op: 'drop', keys: ['minContains'] });
    expect(await soundUnderOracle({ type: 'object', properties: { r: { type: 'array', contains: { type: 'string' }, minContains: 0 } } }, definition, 'W', [{ r: [] }, { r: [1] }, { r: ['a'] }])).toBeNull();
  });

  it('rule 2: fill-type types a true property as it types {}', async () => {
    bothDecide({ properties: { b: true } }, rules({ select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'string' }), {
      ok: true,
      schema: { type: 'object', properties: { b: { type: 'string' } } },
    });
  });

  it('rule 2: a true items schema is labelled as {} is', async () => {
    bothDecide({ type: 'array', items: true }, label, { ok: true, schema: { type: 'array', 'x-label': 'root', items: { 'x-label': 'root_items' } } });
  });

  it('rule 3: a type list of object and null is closed at the root', async () => {
    bothDecide({ type: ['object', 'null'] }, close, { ok: true, schema: { type: ['object', 'null'], additionalProperties: false } });
  });

  it('rule 3: a type list of null and object is closed under properties', async () => {
    bothDecide({ type: 'object', properties: { p: { type: ['null', 'object'] } } }, close, {
      ok: true,
      schema: { type: 'object', properties: { p: { type: ['null', 'object'], additionalProperties: false } } },
    });
  });

  it('rule 3: a type list without object is not closed', async () => {
    bothDecide({ type: ['string', 'null'] }, close, { ok: true, schema: { type: ['string', 'null'] } });
  });

  it('rule 4: a property named "0" and the first oneOf branch get different labels', async () => {
    bothDecide({ properties: { '0': {} }, oneOf: [{}] }, label, {
      ok: true,
      schema: { 'x-label': 'root', properties: { '0': { 'x-label': 'root_0' } }, oneOf: [{ 'x-label': 'root_oneOf_0' }] },
    });
  });

  it('rule 4: nested anyOf branches under a property are labelled with the keyword and index', async () => {
    bothDecide({ properties: { a: { anyOf: [{}, {}] } } }, label, {
      ok: true,
      schema: { 'x-label': 'root', properties: { a: { 'x-label': 'root_a', anyOf: [{ 'x-label': 'root_a_anyOf_0' }, { 'x-label': 'root_a_anyOf_1' }] } } },
    });
  });
});

describe('(b) inline-refs below the root with a $defs of the same name on the selected node', () => {
  it('the product render accepts and rejects the same instances as the original', async () => {
    const schema = {
      $defs: { d: { type: 'string' } },
      properties: { p: { $defs: { d: { type: 'number' } }, type: 'object', properties: { q: { $ref: '#/$defs/d' } } } },
    };
    const definition = rules({ select: [{ kinds: ['object-with-properties'], within: { below: ['properties'], through: ['properties'] } }], op: 'inline-refs' });
    expect(await soundUnderOracle(schema, definition, 'P', [{ p: { q: 'a' } }, { p: { q: 1 } }], productRenderer)).toBeNull();
  });
});
