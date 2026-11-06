import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH, canonicalJson, defineProductSchema, jsonReplyInstructions, readJsonReply } from '@momonga/foundation';

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['fact', 'episode'] },
    text: { type: 'string', minLength: 1, maxLength: 4 },
  },
  required: ['kind', 'text'],
  additionalProperties: false,
} as const;

const validator = defineProductSchema<{ kind: string; text: string }>('foundation-test/json-reply', { ...SCHEMA });

const VALID = JSON.stringify({ kind: 'fact', text: 'abcd' });

describe('jsonReplyInstructions', () => {
  it('ends the instructions with one contract generated from the schema', () => {
    const built = jsonReplyInstructions('Review the run.', { ...SCHEMA });
    expect(built.startsWith('Review the run.\n')).toBe(true);
    expect(built.endsWith(canonicalJson(SCHEMA))).toBe(true);
    expect(built).toContain('Reply with one JSON value and nothing else: no text before or after it and no code fence.');
    expect(built).toContain('It must be valid under this JSON Schema:');
  });

  it('is a function of the instructions and the schema alone', () => {
    expect(jsonReplyInstructions('a', { ...SCHEMA })).toBe(jsonReplyInstructions('a', { ...SCHEMA }));
    expect(jsonReplyInstructions('a', { ...SCHEMA })).not.toBe(jsonReplyInstructions('b', { ...SCHEMA }));
  });
});

describe('readJsonReply', () => {
  it.each([
    ['not JSON', 'sure, here you go', 'not JSON'],
    ['a code fence', `\`\`\`json\n${VALID}\n\`\`\``, 'not JSON'],
    ['prose around an object', `Here it is: ${VALID} done`, 'not JSON'],
    ['two objects', `${VALID}${VALID}`, 'not JSON'],
    ['an extra field', JSON.stringify({ kind: 'fact', text: 'ab', more: 1 }), '/'],
    ['a missing field', JSON.stringify({ kind: 'fact' }), '/'],
    ['a wrong enum', JSON.stringify({ kind: 'rumour', text: 'ab' }), '/kind'],
    ['a text over maxLength', JSON.stringify({ kind: 'fact', text: 'abcde' }), '/text'],
    ['an empty text', JSON.stringify({ kind: 'fact', text: '' }), '/text'],
  ])('rejects %s on both paths and names the path', (_label, text, fragment) => {
    for (const [path, label] of [
      ['enforced', 'reply enforced by the target'],
      ['prompt', 'reply not enforced by the target'],
    ] as const) {
      const read = readJsonReply(validator, { text, incomplete: undefined, path });
      expect(read).toEqual({ error: expect.stringContaining(`output failed the schema (${label}): `) });
      expect('error' in read ? read.error : '').toContain(fragment);
    }
  });

  it('rejects an incomplete response without parsing it, even when its text is a valid value', () => {
    const read = readJsonReply(validator, { text: VALID, incomplete: 'max_output_tokens', path: 'prompt' });
    expect(read).toEqual({ error: expect.stringContaining('max_output_tokens') });
    expect('error' in read ? read.error : '').toContain('output failed the schema');
  });

  it('accepts exactly one valid value and returns it', () => {
    expect(readJsonReply(validator, { text: VALID, incomplete: undefined, path: 'enforced' })).toEqual({ value: { kind: 'fact', text: 'abcd' } });
    expect(readJsonReply(validator, { text: VALID, incomplete: undefined, path: 'prompt' })).toEqual({ value: { kind: 'fact', text: 'abcd' } });
  });

  it('rejects a reply nested past the depth bound as not JSON', () => {
    const deep = `${'['.repeat(MAX_JSON_DEPTH + 1)}${']'.repeat(MAX_JSON_DEPTH + 1)}`;
    expect(readJsonReply(validator, { text: deep, incomplete: undefined, path: 'prompt' })).toEqual({ error: expect.stringContaining('output failed the schema') });
  });

  it('names no path when the gateway reported none', () => {
    const read = readJsonReply(validator, { text: 'x', incomplete: undefined, path: undefined });
    expect(read).toEqual({ error: expect.stringMatching(/^output failed the schema: /) });
  });

  it('counts maxLength in code points, the measure of the product engine', () => {
    const emoji = '\u{1F600}'.repeat(4);
    expect(readJsonReply(validator, { text: JSON.stringify({ kind: 'fact', text: emoji }), incomplete: undefined, path: 'prompt' })).toEqual({ value: { kind: 'fact', text: emoji } });
  });
});
