import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { JsonDepthError, MAX_JSON_DEPTH, parseBoundedJson, spanValueOfJsonText } from '@momonga/foundation';

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

  it('no longer exports parseJsonOrText', () => {
    expect(Object.keys(foundation)).not.toContain('parseJsonOrText');
  });
});

describe('spanValueOfJsonText', () => {
  it('gives the parsed value for valid JSON and the text for malformed text', () => {
    expect(spanValueOfJsonText('{"a":1}', 'arguments')).toEqual({ a: 1 });
    expect(spanValueOfJsonText('{not json', 'tool output')).toBe('{not json');
  });

  it.each([
    ['arguments', '[arguments nest deeper than 128 levels]'],
    ['tool output', '[tool output nests deeper than 128 levels]'],
    ['text', '[text nests deeper than 128 levels]'],
  ] as const)('gives a placeholder that names the kind %s and the bound, and not the text, for JSON deeper than the bound', (kind, placeholder) => {
    expect(spanValueOfJsonText(nested(MAX_JSON_DEPTH + 1), kind)).toBe(placeholder);
  });
});
