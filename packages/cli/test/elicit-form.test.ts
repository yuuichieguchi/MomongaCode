import { describe, expect, it } from 'vitest';
import { fieldsOf, parseFieldInput, validateContent } from '../src/elicit/form.ts';

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Your name', minLength: 2 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    ratio: { type: 'number' },
    agree: { type: 'boolean' },
    color: { type: 'string', enum: ['red', 'green'], enumNames: ['Red', 'Green'] },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] } },
    size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
    blob: { type: 'object' },
  },
  required: ['name'],
};

const field = (name: string) => {
  const found = fieldsOf(SCHEMA).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no field ${name}`);
  return found;
};

describe('fieldsOf', () => {
  it('classifies every primitive of the MCP form subset and marks required fields', () => {
    expect(fieldsOf(SCHEMA).map((entry) => [entry.name, entry.kind, entry.required])).toEqual([
      ['name', 'string', true],
      ['age', 'integer', false],
      ['ratio', 'number', false],
      ['agree', 'boolean', false],
      ['color', 'choice', false],
      ['tags', 'choices', false],
      ['size', 'choice', false],
      ['blob', 'json', false],
    ]);
    expect(field('name').title).toBe('Your name');
    expect(field('color').options).toEqual([
      { value: 'red', label: 'Red' },
      { value: 'green', label: 'Green' },
    ]);
    expect(field('size').options.map((option) => option.label)).toEqual(['Small', 'Large']);
  });
});

describe('parseFieldInput', () => {
  it('coerces text to the type the schema declares', () => {
    expect(parseFieldInput(field('name'), 'Ada')).toEqual({ ok: true, value: 'Ada' });
    expect(parseFieldInput(field('age'), '36')).toEqual({ ok: true, value: 36 });
    expect(parseFieldInput(field('ratio'), '0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseFieldInput(field('agree'), 'Yes')).toEqual({ ok: true, value: true });
    expect(parseFieldInput(field('agree'), 'no')).toEqual({ ok: true, value: false });
    expect(parseFieldInput(field('color'), '2')).toEqual({ ok: true, value: 'green' });
    expect(parseFieldInput(field('color'), 'Red')).toEqual({ ok: true, value: 'red' });
    expect(parseFieldInput(field('tags'), '1, c')).toEqual({ ok: true, value: ['a', 'c'] });
  });

  it('validates each value against the schema of its field', () => {
    expect(parseFieldInput(field('name'), 'A')).toMatchObject({ ok: false, error: expect.stringContaining('must NOT have fewer than 2 characters') });
    expect(parseFieldInput(field('age'), '1.5')).toMatchObject({ ok: false, error: expect.stringContaining('must be integer') });
    expect(parseFieldInput(field('age'), '200')).toMatchObject({ ok: false, error: expect.stringContaining('must be <= 150') });
    expect(parseFieldInput(field('age'), 'old')).toEqual({ ok: false, error: 'age must be a number' });
    expect(parseFieldInput(field('agree'), 'maybe')).toEqual({ ok: false, error: 'agree must be yes or no' });
    expect(parseFieldInput(field('color'), 'blue')).toMatchObject({ ok: false });
    expect(parseFieldInput(field('tags'), 'a,z')).toMatchObject({ ok: false });
  });

  it('skips an empty optional field, reports a required one and still holds an empty string to the string schema', () => {
    expect(parseFieldInput(field('age'), '')).toEqual({ ok: true, value: undefined });
    expect(parseFieldInput(field('name'), '')).toMatchObject({ ok: false, error: expect.stringContaining('fewer than 2 characters') });
    const required = { ...field('age'), required: true };
    expect(parseFieldInput(required, '')).toEqual({ ok: false, error: 'age is required' });
  });

  it('rejects JSON that is not a form content value', () => {
    expect(parseFieldInput(field('blob'), '{"a":1}')).toMatchObject({ ok: false, error: expect.stringContaining('must be a string') });
    expect(parseFieldInput(field('blob'), '{')).toMatchObject({ ok: false, error: expect.stringContaining('must be JSON') });
  });
});

describe('validateContent', () => {
  it('validates the whole answer against the requested schema', () => {
    expect(validateContent(SCHEMA, { name: 'Ada' })).toEqual({ kind: 'valid' });
    expect(validateContent(SCHEMA, { age: 3 })).toMatchObject({ kind: 'invalid', message: expect.stringContaining("must have required property 'name'") });
  });
});
