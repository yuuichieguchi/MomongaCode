import { describe, expect, it } from 'vitest';
import { renderSchema } from '../src/dialect/render.ts';
import { RESPONSE_FORMAT, builtin, validatorOf } from './dialect-support.ts';

const envelope = {
  type: 'object',
  anyOf: [
    { type: 'object', properties: { kind: { const: 'final' }, text: { type: 'string' } }, required: ['kind', 'text'] },
    { type: 'object', properties: { kind: { const: 'tool_calls' }, calls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } }, required: ['kind', 'calls'] },
  ],
};

const CALL = { kind: 'tool_calls', calls: [{ name: 'search' }] };
const FINAL = { kind: 'final', text: 'hi' };

describe.each(['strict-closed', 'explicit-keys'])('%s keeps an object whose properties an in-place applicator declares', (id) => {
  it('accepts a valid call object through the product engine', () => {
    const rendered = renderSchema(envelope, RESPONSE_FORMAT, builtin(id)).schema;
    const accepts = validatorOf(rendered);
    expect(accepts).toBeDefined();
    expect(validatorOf(envelope)?.(CALL)).toBe(true);
    expect(accepts?.(CALL)).toBe(true);
    expect(accepts?.(FINAL)).toBe(true);
  });

  it.each(id === 'explicit-keys' ? ['allOf', 'anyOf'] : ['anyOf'])('does not close or open the root beside %s', (keyword) => {
    const root = { type: 'object', [keyword]: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }] };
    const rendered = renderSchema(root, RESPONSE_FORMAT, builtin(id)).schema as Record<string, unknown>;
    expect(rendered['additionalProperties']).toBeUndefined();
    expect(rendered['properties']).toBeUndefined();
  });
});
