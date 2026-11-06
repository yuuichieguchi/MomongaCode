import { describe, expect, it } from 'vitest';
import type { DialectDefinition } from '@momonga/protocol';
import { renderSchema } from '../../gateway/src/dialect/render.ts';
import { resolveRules, type Definition } from '../src/dialect-model/definition.ts';
import { checkCase, type CaseInput } from '../src/dialect-model/harness.ts';
import type { Json } from '../src/dialect-model/json.ts';
import { render } from '../src/dialect-model/render.ts';

const dropMinContains: Definition = { rules: [{ select: [{ kinds: ['any'] }], op: 'drop', keys: ['minContains'] }] };

const productDroppingContainsToo: NonNullable<CaseInput['renderer']> = () => ({ ok: true, schema: { type: 'array' } });

const oracleVerdict = (minContains: number) =>
  checkCase({
    schema: { type: 'array', contains: { type: 'string' }, minContains },
    site: 'response-format',
    definition: dropMinContains,
    cls: 'W',
    seed: 1,
    perDocument: 8,
    renderer: productDroppingContainsToo,
  });

describe('decision 29 rule 1: the drop oracle drops contains only with minContains 0', () => {
  it.each([1, 2])('rejects dropping contains together with minContains %i', (minContains) => {
    expect(oracleVerdict(minContains)?.kind).toBe('drop-changed-more-than-keys');
  });

  it('accepts dropping contains together with minContains 0', () => {
    expect(oracleVerdict(0)).toBeNull();
  });
});

const labelAll: Definition = { rules: [{ select: [{ kinds: ['any'] }], op: 'label', key: 'title' }] };

const productRender = (schema: Json): Json | undefined => {
  const resolved = { id: 'reference-model', definition: { rules: resolveRules(labelAll) } as unknown as DialectDefinition };
  return renderSchema(schema, { kind: 'response-format' }, resolved).schema as Json | undefined;
};

const modelRender = (schema: Json): Json | undefined => {
  const result = render(schema, labelAll, 'response-format');
  if (!result.ok) throw new Error(`model refused: ${result.detail}`);
  return result.schema as Json | undefined;
};

describe('decision 29: the model labels a property named like a keyword as the product does', () => {
  it('labels a root property named properties', () => {
    const schema: Json = { type: 'object', properties: { properties: { type: 'string' } } };
    const model = modelRender(schema) as { properties: { properties: { title: string } } };
    expect(model.properties.properties.title).toBe('root_properties');
    expect(model).toEqual(productRender(schema));
  });

  it('labels a nested property named properties', () => {
    const schema: Json = { type: 'object', properties: { a: { type: 'object', properties: { properties: { type: 'string' } } } } };
    const model = modelRender(schema) as { properties: { a: { properties: { properties: { title: string } } } } };
    expect(model.properties.a.properties.properties.title).toBe('root_a_properties');
    expect(model).toEqual(productRender(schema));
  });

  it('labels a property named anyOf', () => {
    const schema: Json = { type: 'object', properties: { anyOf: { type: 'string' } } };
    const model = modelRender(schema) as { properties: { anyOf: { title: string } } };
    expect(model.properties.anyOf.title).toBe('root_anyOf');
    expect(model).toEqual(productRender(schema));
  });
});
