import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { parseClassifierVerdict } from '../../src/worker/classifier-verdict.ts';

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const replyOf = (depth: number): string => `{"verdict":"safe","confidence":"high","rationale":"reads a file","extra":${nestedArraysText(depth - 1)}}`;

describe('the auto mode classifier reply', () => {
  it('parses a well-formed verdict', () => {
    expect(parseClassifierVerdict('{"verdict":"safe","confidence":"high","rationale":"reads a file"}')).toEqual({
      verdict: 'safe',
      confidence: 'high',
      rationale: 'reads a file',
    });
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['an unknown verdict', '{"verdict":"maybe","confidence":"high","rationale":""}'],
    ['an unknown confidence', '{"verdict":"safe","confidence":0.9,"rationale":""}'],
    ['a missing rationale', '{"verdict":"safe","confidence":"high"}'],
  ])('rejects %s', (_label, text) => {
    expect(parseClassifierVerdict(text)).toHaveProperty('error');
  });

  it(`reads a reply nested exactly ${MAX_JSON_DEPTH} deep`, () => {
    expect(parseClassifierVerdict(replyOf(MAX_JSON_DEPTH))).toEqual({ verdict: 'safe', confidence: 'high', rationale: 'reads a file' });
  });

  it(`refuses a reply nested ${MAX_JSON_DEPTH + 1} deep, naming the depth`, () => {
    const verdict = parseClassifierVerdict(replyOf(MAX_JSON_DEPTH + 1));
    expect(verdict).toHaveProperty('error');
    const error = (verdict as { error: string }).error;
    expect(error).toMatch(/depth/i);
    expect(error).toContain(String(MAX_JSON_DEPTH));
  });
});
