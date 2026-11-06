import { describe, expect, it } from 'vitest';
import { JsonDepthError, MAX_JSON_DEPTH, parseBoundedJson, parseJsonOrText } from '@momonga/foundation';

const nested = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

describe('parseBoundedJson', () => {
  it('returns the value for valid JSON within the bound', () => {
    expect(parseBoundedJson('{"a":[1,2]}')).toEqual({ kind: 'value', value: { a: [1, 2] } });
    expect(parseBoundedJson('7')).toEqual({ kind: 'value', value: 7 });
    expect(parseBoundedJson(nested(MAX_JSON_DEPTH))).toMatchObject({ kind: 'value' });
  });

  it('returns the text as malformed for a syntax error', () => {
    expect(parseBoundedJson('{')).toEqual({ kind: 'text', text: '{', reason: 'malformed' });
    expect(parseBoundedJson('')).toEqual({ kind: 'text', text: '', reason: 'malformed' });
  });

  it('returns the text as too_deep for JSON one level deeper than the bound', () => {
    const text = nested(MAX_JSON_DEPTH + 1);
    expect(parseBoundedJson(text)).toEqual({ kind: 'text', text, reason: 'too_deep' });
  });

  it('maps a SyntaxError and a JsonDepthError of the injected parse and nothing else', () => {
    expect(
      parseBoundedJson('x', () => {
        throw new SyntaxError('Unexpected token');
      }),
    ).toEqual({ kind: 'text', text: 'x', reason: 'malformed' });
    expect(
      parseBoundedJson('x', () => {
        throw new JsonDepthError();
      }),
    ).toEqual({ kind: 'text', text: 'x', reason: 'too_deep' });
  });

  it('propagates any other error of the parse unchanged', () => {
    const failure = new RangeError('Maximum call stack size exceeded');
    expect(() =>
      parseBoundedJson('x', () => {
        throw failure;
      }),
    ).toThrow(failure);
    const typed = new TypeError('not a string');
    expect(() =>
      parseBoundedJson('x', () => {
        throw typed;
      }),
    ).toThrow(typed);
  });

  it('keeps the old parseJsonOrText export until its callers move', () => {
    expect(parseJsonOrText('{"a":1}')).toEqual({ a: 1 });
  });
});
