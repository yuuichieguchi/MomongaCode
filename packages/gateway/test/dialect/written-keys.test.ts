import { describe, expect, it } from 'vitest';
import { renderSchema } from '../../src/dialect/render.ts';
import { failureOf, toolSite, userRules } from '../dialect-support.ts';

const nullableOptional = userRules([{ select: [{ kinds: ['tool-parameters'] }], op: 'nullable-optional' }]);

describe('nullable-optional guards the keys it writes', () => {
  it('refuses to wrap a property that a $ref pointer passes through', () => {
    const parameters = { type: 'object', properties: { a: { type: 'string' }, b: { $ref: '#/properties/a' } }, required: ['b'] };
    expect(failureOf(() => renderSchema(parameters, toolSite('edit'), nullableOptional))).toMatchObject({ reason: 'written-key', tool: 'edit', code: 'unsupported_tool_schema' });
  });

  it('wraps a property that no $ref pointer passes through', () => {
    const parameters = { type: 'object', properties: { a: { type: 'string' }, b: { $ref: '#/$defs/s' } }, required: ['b'], $defs: { s: { type: 'string' } } };
    expect(renderSchema(parameters, toolSite('edit'), nullableOptional).wraps).toEqual([{ tool: 'edit', wrapped: [{ at: [], property: 'a' }] }]);
  });
});
