import { describe, expect, it } from 'vitest';
import { FULL_KEYWORD_SUPPORT } from '../src/probe/lowering.ts';
import { renderParameters, renderSchema } from '../src/probe/schema-dialect.ts';

describe('guided-generation renderer', () => {
  it('adds x-order, additionalProperties and required to every object with properties and keeps the original required', () => {
    const rendered = renderSchema(
      { type: 'object', properties: { a: { type: 'string' }, b: { type: 'object', properties: { c: { type: 'integer' } } } }, required: ['a'] },
      'guided-generation',
      FULL_KEYWORD_SUPPORT,
    );
    expect(rendered).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'object', properties: { c: { type: 'integer' } }, 'x-order': ['c'], additionalProperties: false, required: [] },
      },
      'x-order': ['a', 'b'],
      additionalProperties: false,
      required: ['a'],
    });
  });

  it('titles every anyOf and every object branch', () => {
    const rendered = renderSchema(
      { type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'object', properties: { k: { type: 'string' } } }] } } },
      'guided-generation',
      FULL_KEYWORD_SUPPORT,
    );
    const union = (rendered['properties'] as Record<string, any>)['v'];
    expect(union.title).toBe('v');
    expect(union.anyOf[0]).toEqual({ type: 'string' });
    expect(union.anyOf[1].title).toBe('v_1');
  });

  it('infers the type of an untyped enum from its values', () => {
    const rendered = renderSchema(
      { type: 'object', properties: { s: { enum: ['a'] }, n: { enum: [1, 2] }, b: { enum: [true] } } },
      'guided-generation',
      FULL_KEYWORD_SUPPORT,
    );
    const properties = rendered['properties'] as Record<string, unknown>;
    expect(properties).toEqual({
      s: { enum: ['a'], type: 'string' },
      n: { enum: [1, 2], type: 'integer' },
      b: { enum: [true], type: 'boolean' },
    });
  });

  it('gives a tool without parameters an object with empty properties, and leaves json-schema-2020-12 untouched', () => {
    expect(renderParameters(undefined, 'guided-generation', FULL_KEYWORD_SUPPORT)).toEqual({
      type: 'object',
      properties: {},
      'x-order': [],
      additionalProperties: false,
      required: [],
    });
    expect(renderParameters(undefined, 'json-schema-2020-12', FULL_KEYWORD_SUPPORT)).toBeUndefined();
    const schema = { type: 'object', properties: { a: { enum: ['x'] } } };
    expect(renderSchema(schema, 'json-schema-2020-12', FULL_KEYWORD_SUPPORT)).toEqual(schema);
  });

  it('renders an untyped node as a string and keeps its description', () => {
    const rendered = renderSchema(
      { type: 'object', properties: { bare: {}, described: { description: 'any value' }, list: { type: 'array', items: {} } } },
      'guided-generation',
      FULL_KEYWORD_SUPPORT,
    );
    const properties = rendered['properties'] as Record<string, unknown>;
    expect(properties).toEqual({
      bare: { type: 'string' },
      described: { description: 'any value', type: 'string' },
      list: { type: 'array', items: { type: 'string' } },
    });
  });

  it('rewrites a mixed-type enum as an anyOf with one typed, titled enum branch per literal type', () => {
    const rendered = renderSchema(
      { type: 'object', properties: { v: { description: 'pick', enum: ['a', 'b', 1, 2.5, true] } } },
      'guided-generation',
      FULL_KEYWORD_SUPPORT,
    );
    expect((rendered['properties'] as Record<string, unknown>)['v']).toEqual({
      description: 'pick',
      anyOf: [
        { type: 'string', enum: ['a', 'b'], title: 'v_string' },
        { type: 'number', enum: [1, 2.5], title: 'v_number' },
        { type: 'boolean', enum: [true], title: 'v_boolean' },
      ],
      title: 'v',
    });
  });

  it('renders a schema-valued additionalProperties as true', () => {
    const rendered = renderSchema(
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } },
      'guided-generation',
      FULL_KEYWORD_SUPPORT,
    );
    expect(rendered['additionalProperties']).toBe(true);
  });
});
