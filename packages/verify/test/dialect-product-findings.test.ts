import { describe, expect, it } from 'vitest';
import { allowedDropKeys } from '../src/dialect-model/primitives.ts';
import { checkCase, emptyStats, isDeletionOf, type CheckClass } from '../src/dialect-model/harness.ts';
import type { Definition, Rule } from '../src/dialect-model/definition.ts';
import { render, type Rendered } from '../src/dialect-model/render.ts';
import type { Site } from '../src/dialect-model/selector.ts';
import { BUILTINS } from '../src/dialect-model/definition.ts';
import { productRenderer } from './dialect-product.test.ts';

const ANY = [{ kinds: ['any'] }];
const rules = (...entries: Record<string, unknown>[]): Definition => ({ rules: entries as unknown as Rule[] });
const shape = (rendered: Rendered): unknown => (rendered.ok ? { ok: true, schema: rendered.schema } : { ok: false, reason: rendered.reason });

const bothRender = (schema: unknown, definition: Definition, site: Site = 'response-format'): void => {
  expect(shape(productRenderer(schema as never, definition, site))).toEqual(shape(render(schema as never, definition, site)));
};

const soundUnderOracle = (schema: unknown, definition: Definition, cls: CheckClass, witnesses: unknown[], renderer?: typeof productRenderer): unknown =>
  checkCase({ schema: schema as never, site: 'response-format', definition, cls, seed: 1, perDocument: 20, forcedInstances: witnesses as never, stats: emptyStats(), ...(renderer === undefined ? {} : { renderer }) });

describe('(a) one renders and the other fails', () => {
  it('ensure-key additionalProperties true on a node that carries unevaluatedProperties false and is not object-like (primitives.ts:67 guards on isObjectLike; the design fails with dependency)', () => {
    bothRender({ anyOf: [{ unevaluatedProperties: false }] }, rules({ select: ANY, op: 'ensure-key', key: 'additionalProperties', value: true }));
  });

  it('ensure-key additionalProperties false on an untyped node under contains with maxContains (same guard; the design fails with polarity)', () => {
    bothRender({ contains: {}, maxContains: 1 }, rules({ select: [{ kinds: ['untyped'] }], op: 'ensure-key', key: 'additionalProperties', value: false }));
  });

  it('drop whose keys feed unevaluatedItems through a $ref site (drop.ts:34 fails dependency; the design cascades the unevaluated keyword)', () => {
    bothRender(
      { allOf: [{ $ref: '#/$defs/d0', unevaluatedItems: false }], $defs: { d0: { allOf: [{ anyOf: [] }] } } },
      rules({ select: ANY, op: 'drop', keys: ['prefixItems', 'items', 'anyOf'] }),
    );
  });

  it('object-without-properties on a node with an empty in-place applicator (select.ts:19 counts presence; the model ignores the empty array)', () => {
    bothRender({ type: 'object', anyOf: [], required: ['foo'], unevaluatedProperties: false }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'declare-required' }));
  });

  it('reject on object-without-properties with an empty dependentSchemas', () => {
    bothRender({ type: 'object', dependentSchemas: {} }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'reject', keys: ['dependentSchemas'] }));
  });

  it('a boolean subschema under oneOf is a node for the product and not for the model', () => {
    bothRender({ oneOf: [true] }, rules({ select: [{ kinds: ['untyped'] }], op: 'fill-type', fallback: 'string' }));
  });

  it('a type array of one entry selects the object kinds for the product only', () => {
    bothRender({ anyOf: [{ oneOf: [{ type: ['object'] }] }] }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'always' }));
  });

  it('type [] with properties under split-type-array: the model calls it unsatisfiable, the product does not select it', () => {
    bothRender({ type: [], properties: {} }, rules({ select: [{ kinds: ['object-with-properties'] }], op: 'split-type-array' }));
  });

  it('a $schema sibling beside a $ref under inline-refs (inline-refs.ts:13-21 merges it; the model fails ref-sibling)', () => {
    bothRender({ $ref: '#/$defs/d1', $defs: { d1: {} }, $schema: 'https://json-schema.org/draft/2020-12/schema' }, rules({ select: [{ kinds: ['root'] }], op: 'inline-refs' }));
  });

  it('inline-refs selected below the document root (primitives.ts:143 passes the selected node as the pointer root; inline-refs.ts:33-36 then fails construct for a $ref into the document $defs)', () => {
    bothRender(
      { $defs: { d: { type: 'string' } }, properties: { p: { type: 'object', properties: { q: { $ref: '#/$defs/d' } } } } },
      rules({ select: [{ kinds: ['object-with-properties'], within: { below: ['properties'], through: ['properties'] } }], op: 'inline-refs' }),
    );
  });

  it('split-enum on an enum node inside oneOf whose type array excludes every value', () => {
    bothRender({ oneOf: [{ type: ['object'], enum: [] }] }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'split-enum' }));
  });
});

describe('(b) both render and the soundness verdict differs', () => {
  it('drop of minContains 0: the model render rejects [] that the original accepts (model and design :202 are unsound)', () => {
    const definition = rules({ select: ANY, op: 'drop', keys: ['minContains'] });
    expect(soundUnderOracle({ type: 'array', contains: {}, minContains: 0 }, definition, 'W', [[], [1]])).toBeNull();
  });

  it('drop of minContains 0: the product also removes contains, which the model oracle does not allow as a drop (drop.ts:30 is an undocumented rule)', () => {
    const definition = rules({ select: ANY, op: 'drop', keys: ['minContains'] });
    const original = { type: 'array', contains: {}, minContains: 0 };
    const rendered = productRenderer(original as never, definition, 'response-format');
    expect(rendered.ok && isDeletionOf(original as never, rendered.schema as never, allowedDropKeys(['minContains']))).toBe(true);
  });
});

describe('(c) both render, both sound, the output differs', () => {
  it('fill-type on an enum node: the product infers a type from the values (primitives.ts:28), the model writes the fallback', () => {
    bothRender({ enum: [{}, 1] }, rules({ select: [{ kinds: ['const'] }, { kinds: ['root'] }], op: 'fill-type', fallback: 'number' }));
  });

  it('label on boolean subschemas: the product turns true into an object node', () => {
    bothRender({ properties: { a: false, b: true } }, rules({ select: ANY, op: 'label', key: 'x-label' }));
  });

  it('label path of a oneOf branch', () => {
    bothRender({ oneOf: [{}] }, rules({ select: ANY, op: 'label', key: 'x-label' }));
  });

  it('explicit-keys on the boolean schema true', () => {
    bothRender(true, BUILTINS['explicit-keys'] as Definition);
  });

  it('require-all on properties {}: the model writes required [] (a no-op), the product does not', () => {
    bothRender({ properties: {} }, rules({ select: ANY, op: 'require-all' }));
  });

  it('ensure-key properties {} reaches a boolean schema for the product only', () => {
    bothRender({ dependentSchemas: { foo: true } }, rules({ select: ANY, op: 'ensure-key', key: 'properties', value: {} }));
  });

  it('split-enum on object-without-properties with an empty oneOf', () => {
    bothRender({ type: 'object', oneOf: [], enum: [{}, []] }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'split-enum' }));
  });

  it('split-type-array on type [boolean] with properties', () => {
    bothRender({ type: ['boolean'], properties: {} }, rules({ select: [{ kinds: ['type-boolean', 'object-with-properties'] }], op: 'split-type-array' }));
  });

  it('property-order on an array node that carries a properties map', () => {
    bothRender({ type: ['array'], properties: {} }, rules({ select: [{ kinds: ['array'] }], op: 'property-order', key: 'propertyOrdering' }));
  });

  it('object-with-properties on a non-object type that carries a properties map (select.ts:18 requires an object type; the model accepts any type)', () => {
    bothRender({ type: 'string', properties: {} }, rules({ select: [{ kinds: ['object-with-properties'] }], op: 'drop', keys: ['properties'] }));
  });

  it('strict-closed on type [object]', () => {
    bothRender({ type: ['object'] }, rules({ select: [{ kinds: ['object-without-properties'] }], op: 'ensure-key', key: 'additionalProperties', value: false }));
  });
});

describe('(b) inline-refs below the root with a $defs of the same name on the selected node', () => {
  it('the product render accepts and rejects the same instances as the original', () => {
    const schema = {
      $defs: { d: { type: 'string' } },
      properties: { p: { $defs: { d: { type: 'number' } }, type: 'object', properties: { q: { $ref: '#/$defs/d' } } } },
    };
    const definition = rules({ select: [{ kinds: ['object-with-properties'], within: { below: ['properties'], through: ['properties'] } }], op: 'inline-refs' });
    expect(soundUnderOracle(schema, definition, 'P', [{ p: { q: 'a' } }, { p: { q: 1 } }], productRenderer)).toBeNull();
  });
});
