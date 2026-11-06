import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { fieldsOf, parseFieldInput } from '../src/elicit/form.ts';

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const SCHEMA = { type: 'object', properties: { blob: { type: 'object' } } };

const ORIGIN = { server: 'fx', key: 'profile' };

const blob = () => {
  const found = fieldsOf(SCHEMA).find((candidate) => candidate.name === 'blob');
  if (found === undefined) throw new Error('no blob field');
  return found;
};

const typedText = (depth: number): string => `{"a":${nestedArraysText(depth - 1)}}`;

describe('user-typed elicitation JSON and the one JSON depth bound', () => {
  it('reads the field as JSON input', async () => {
    expect(blob().kind).toBe('json');
  });

  it(`parses typed JSON nested exactly ${MAX_JSON_DEPTH} deep and judges it by the form rules`, async () => {
    const parsed = await parseFieldInput(ORIGIN, blob(), typedText(MAX_JSON_DEPTH));
    expect(parsed).toEqual({ ok: false, reason: 'invalid', error: 'blob must be a string, a number, a boolean or a list of strings' });
  });

  it(`refuses typed JSON nested ${MAX_JSON_DEPTH + 1} deep as invalid, naming the depth`, async () => {
    const parsed = await parseFieldInput(ORIGIN, blob(), typedText(MAX_JSON_DEPTH + 1));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid');
    expect(parsed.error).toMatch(/^blob /);
    expect(parsed.error).toMatch(/depth/i);
    expect(parsed.error).toContain(String(MAX_JSON_DEPTH));
  });
});
