import { describe, expect, it } from 'vitest';
import type { WrapRecord } from '@momonga/protocol';
import { renderSchema } from '../src/dialect/render.ts';
import { invertReply } from '../src/dialect/unwrap.ts';
import { RESPONSE_FORMAT, builtin, failureOf, toolSite, userRules } from './dialect-support.ts';

const TOOL = 'edit';
const NULL = { type: 'null' };

const strictClosed = (parameters: unknown, tool = TOOL) => renderSchema(parameters, toolSite(tool), builtin('strict-closed'));
const nullableOnly = userRules([{ select: [{ kinds: ['tool-parameters'] }], op: 'nullable-optional' }]);

describe('strict-closed wraps an optional property and records it (decision 2 (ii))', () => {
  it('wraps an optional string, closes the object and requires every property', () => {
    const rendered = strictClosed({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['b'] });
    expect(rendered.schema).toEqual({
      type: 'object',
      properties: { a: { anyOf: [{ type: 'string' }, NULL] }, b: { type: 'integer' } },
      required: ['b', 'a'],
      additionalProperties: false,
    });
    expect(rendered.wraps).toEqual([{ tool: TOOL, wrapped: [{ at: [], property: 'a' }] }]);
    expect(rendered.narrowings).toEqual([]);
  });

  it('neither wraps nor records a property whose original schema admits null', () => {
    const rendered = strictClosed({
      type: 'object',
      properties: {
        n1: { type: ['string', 'null'] },
        n2: { enum: ['x', null] },
        n3: { const: null },
        enforcement: { anyOf: [NULL, { type: 'object', properties: { level: { type: 'string' } }, required: ['level'] }] },
      },
    });
    expect(rendered.schema).toEqual({
      type: 'object',
      properties: {
        n1: { type: ['string', 'null'] },
        n2: { enum: ['x', null] },
        n3: { const: null },
        enforcement: { anyOf: [NULL, { type: 'object', properties: { level: { type: 'string' } }, required: ['level'], additionalProperties: false }] },
      },
      additionalProperties: false,
      required: ['n1', 'n2', 'n3', 'enforcement'],
    });
    expect(rendered.wraps).toEqual([]);
  });

  it('wraps an optional object and its own optional property, reaching through the wrapper', () => {
    const rendered = strictClosed({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } });
    expect(rendered.schema).toEqual({
      type: 'object',
      properties: {
        a: {
          anyOf: [
            { type: 'object', properties: { b: { anyOf: [{ type: 'string' }, NULL] } }, additionalProperties: false, required: ['b'] },
            NULL,
          ],
        },
      },
      additionalProperties: false,
      required: ['a'],
    });
    expect(rendered.wraps).toEqual([{ tool: TOOL, wrapped: [{ at: [], property: 'a' }, { at: [{ property: 'a' }], property: 'b' }] }]);
  });

  it('records an optional property of array elements with an items segment', () => {
    const rendered = strictClosed({
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'integer' } }, required: ['y'] } } },
      required: ['list'],
    });
    expect(rendered.schema).toEqual({
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { type: 'object', properties: { x: { anyOf: [{ type: 'string' }, NULL] }, y: { type: 'integer' } }, required: ['y', 'x'], additionalProperties: false },
        },
      },
      required: ['list'],
      additionalProperties: false,
    });
    expect(rendered.wraps).toEqual([{ tool: TOOL, wrapped: [{ at: [{ property: 'list' }, { items: true }], property: 'x' }] }]);
  });

  it('makes an optional property required without null outside a tool (a root response format)', () => {
    const rendered = renderSchema({ type: 'object', properties: { a: { type: 'string' } } }, RESPONSE_FORMAT, builtin('strict-closed'));
    expect(rendered.schema).toEqual({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false, required: ['a'] });
    expect(rendered.wraps).toEqual([]);
  });

  it('gives two tools with a property of the same name their own records', () => {
    const alpha = strictClosed({ type: 'object', properties: { p: { type: 'string' }, q: { type: 'string' } }, required: ['q'] }, 'alpha');
    const beta = strictClosed({ type: 'object', properties: { p: { type: 'string' }, q: { type: 'string' } }, required: ['p'] }, 'beta');
    expect(alpha.wraps).toEqual([{ tool: 'alpha', wrapped: [{ at: [], property: 'p' }] }]);
    expect(beta.wraps).toEqual([{ tool: 'beta', wrapped: [{ at: [], property: 'q' }] }]);
    const reply = '{"p":null,"q":null}';
    expect(JSON.parse(invertReply(alpha.wraps[0]!, reply))).toEqual({ q: null });
    expect(JSON.parse(invertReply(beta.wraps[0]!, reply))).toEqual({ p: null });
  });
});

describe('where nullable-optional has no unambiguous inverse (item g)', () => {
  it.each([
    ['below anyOf', { type: 'object', properties: { u: { anyOf: [{ type: 'object', properties: { b: { type: 'string' } } }, { type: 'string' }] } }, required: ['u'] }, '/properties/u/anyOf/0'],
    ['below oneOf', { type: 'object', properties: { u: { oneOf: [{ type: 'object', properties: { b: { type: 'string' } } }, { type: 'string' }] } }, required: ['u'] }, '/properties/u/oneOf/0'],
    ['below additionalProperties', { type: 'object', properties: {}, additionalProperties: { type: 'object', properties: { b: { type: 'string' } } } }, '/additionalProperties'],
    ['below then', { type: 'object', properties: { k: { type: 'string' } }, required: ['k'], if: { required: ['k'] }, then: { properties: { b: { type: 'string' } } } }, '/then'],
  ])('fails with inverse-ambiguous %s, naming the tool and the object', (_name, parameters, path) => {
    expect(failureOf(() => renderSchema(parameters, toolSite(TOOL), nullableOnly))).toEqual({
      reason: 'inverse-ambiguous',
      tool: TOOL,
      path,
      code: 'unsupported_tool_schema',
    });
  });

  it('fails with inverse-ambiguous under strict-closed for an optional property in a union branch', () => {
    const failure = failureOf(() =>
      strictClosed({ type: 'object', properties: { u: { anyOf: [{ type: 'object', properties: { b: { type: 'string' } } }, NULL] } }, required: ['u'] }),
    );
    expect(failure).toEqual({ reason: 'inverse-ambiguous', tool: TOOL, path: '/properties/u/anyOf/0', code: 'unsupported_tool_schema' });
  });

  it.each([
    ['minProperties', { minProperties: 1 }],
    ['maxProperties', { maxProperties: 2 }],
    ['dependentRequired', { dependentRequired: { a: ['b'] } }],
    ['dependentSchemas', { dependentSchemas: { a: { required: ['b'] } } }],
    ['patternProperties', { patternProperties: { '^z': { type: 'string' } } }],
  ])('fails with dependency beside %s, naming the tool and the object', (_name, extra) => {
    const parameters = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, ...extra };
    expect(failureOf(() => renderSchema(parameters, toolSite(TOOL), nullableOnly))).toEqual({
      reason: 'dependency',
      tool: TOOL,
      path: '',
      code: 'unsupported_tool_schema',
    });
  });

  it('fails with dependency when an in-place applicator sits at the object location', () => {
    const parameters = { type: 'object', properties: { a: { type: 'string' } }, allOf: [{ required: [] }] };
    expect(failureOf(() => renderSchema(parameters, toolSite(TOOL), nullableOnly)).reason).toBe('dependency');
  });

  it('passes an object below a union whose properties are all required', () => {
    const parameters = { type: 'object', properties: { u: { anyOf: [{ type: 'object', properties: { b: { type: 'string' } }, required: ['b'] }, NULL] } }, required: ['u'] };
    expect(renderSchema(parameters, toolSite(TOOL), nullableOnly).wraps).toEqual([]);
  });
});

describe('invertReply, the one inverse of class R', () => {
  const record: WrapRecord = {
    tool: TOOL,
    wrapped: [
      { at: [], property: 'a' },
      { at: [{ property: 'a' }], property: 'b' },
      { at: [{ property: 'list' }, { items: true }], property: 'x' },
    ],
  };

  it('deletes a recorded property whose value is null', () => {
    expect(JSON.parse(invertReply(record, '{"a":null,"c":1}'))).toEqual({ c: 1 });
  });

  it('deletes a nested recorded null and keeps the parent', () => {
    expect(JSON.parse(invertReply(record, '{"a":{"b":null,"k":2}}'))).toEqual({ a: { k: 2 } });
    expect(JSON.parse(invertReply(record, '{"a":{"b":null}}'))).toEqual({ a: {} });
  });

  it('deletes the recorded null in every element an items segment reaches', () => {
    expect(JSON.parse(invertReply(record, '{"list":[{"x":null,"y":1},{"x":"k","y":2},{"x":null,"y":3}]}'))).toEqual({
      list: [{ y: 1 }, { x: 'k', y: 2 }, { y: 3 }],
    });
  });

  it('keeps null for a property the record does not name', () => {
    expect(JSON.parse(invertReply(record, '{"a":{"b":"v"},"n":null}'))).toEqual({ a: { b: 'v' }, n: null });
  });

  it.each([
    ['a recorded property that is absent', '{ "c" : 1 }'],
    ['a recorded property that is not null', '{"a": {"b": "v"}}'],
    ['a path that reaches no object', '{"a":"str","list":3}'],
    ['an array', '[null]'],
    ['null', 'null'],
    ['text that is not JSON', '{"a":null'],
  ])('passes %s through byte for byte', (_name, text) => {
    expect(invertReply(record, text)).toBe(text);
  });

  it('inverts nothing for a record with no entries', () => {
    expect(invertReply({ tool: TOOL, wrapped: [] }, '{"a": null}')).toBe('{"a": null}');
  });
});
