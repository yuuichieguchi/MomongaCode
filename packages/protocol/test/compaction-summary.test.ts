import { describe, expect, it } from 'vitest';
import { decodeCompactionSummary } from '@momonga/protocol';

const segment = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
const macSegment = segment('any-mac-bytes');

describe('decodeCompactionSummary', () => {
  it('returns the summary from a well-formed payload without checking the mac', () => {
    expect(decodeCompactionSummary(`${segment(JSON.stringify({ v: 1, summary: 'searched for x' }))}.${macSegment}`)).toBe('searched for x');
  });

  it('keeps non-ascii and empty summaries intact', () => {
    expect(decodeCompactionSummary(`${segment(JSON.stringify({ v: 1, summary: '要約: ✓' }))}.${macSegment}`)).toBe('要約: ✓');
    expect(decodeCompactionSummary(`${segment(JSON.stringify({ v: 1, summary: '' }))}.${macSegment}`)).toBe('');
  });

  it.each([
    ['a payload that is not JSON', `${segment('not json')}.${macSegment}`],
    ['a JSON payload that is not an object', `${segment('"just a string"')}.${macSegment}`],
    ['a null payload', `${segment('null')}.${macSegment}`],
    ['a payload without a summary', `${segment(JSON.stringify({ v: 1 }))}.${macSegment}`],
    ['a payload with version 2', `${segment(JSON.stringify({ v: 2, summary: 'x' }))}.${macSegment}`],
    ['a payload without a version', `${segment(JSON.stringify({ summary: 'x' }))}.${macSegment}`],
    ['a payload whose summary is not a string', `${segment(JSON.stringify({ v: 1, summary: 42 }))}.${macSegment}`],
  ])('returns undefined for %s', (_label, encrypted) => {
    expect(decodeCompactionSummary(encrypted)).toBeUndefined();
  });

  it.each([
    ['a payload segment with standard base64 characters', `${Buffer.from(JSON.stringify({ v: 1, summary: '>>>???' }), 'utf8').toString('base64')}.${macSegment}`],
    ['a payload segment with padding', `${segment(JSON.stringify({ v: 1, summary: 'x' }))}==.${macSegment}`],
    ['a payload segment with a space', `${segment(JSON.stringify({ v: 1, summary: 'x' }))} .${macSegment}`],
    ['a mac segment with invalid characters', `${segment(JSON.stringify({ v: 1, summary: 'x' }))}.mac!`],
    ['an empty mac segment', `${segment(JSON.stringify({ v: 1, summary: 'x' }))}.`],
    ['an empty payload segment', `.${macSegment}`],
  ])('returns undefined for %s', (_label, encrypted) => {
    expect(decodeCompactionSummary(encrypted)).toBeUndefined();
  });

  it.each([
    ['no separator', segment(JSON.stringify({ v: 1, summary: 'x' }))],
    ['three segments', `${segment(JSON.stringify({ v: 1, summary: 'x' }))}.${macSegment}.${macSegment}`],
    ['an empty string', ''],
  ])('returns undefined for a wrong segment count: %s', (_label, encrypted) => {
    expect(decodeCompactionSummary(encrypted)).toBeUndefined();
  });
});
