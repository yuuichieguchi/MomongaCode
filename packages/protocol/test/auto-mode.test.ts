import { describe, expect, it } from 'vitest';
import { AUTO_MODE_UNAVAILABLE, classifierAllows, parseClassifierVerdict } from '@momonga/protocol';

describe('auto mode classifier verdict', () => {
  it('parses a well-formed verdict', () => {
    expect(parseClassifierVerdict('{"verdict":"safe","confidence":"high","rationale":"reads a file"}')).toEqual({
      verdict: 'safe',
      confidence: 'high',
      rationale: 'reads a file',
    });
  });

  it('allows only a safe verdict with high confidence', () => {
    const allowed = [
      { verdict: 'safe', confidence: 'high' },
      { verdict: 'safe', confidence: 'medium' },
      { verdict: 'safe', confidence: 'low' },
      { verdict: 'unsafe', confidence: 'high' },
      { verdict: 'unsafe', confidence: 'low' },
    ] as const;
    expect(allowed.map((entry) => classifierAllows({ ...entry, rationale: '' }))).toEqual([true, false, false, false, false]);
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

  it('carries the unavailable code', () => {
    expect(AUTO_MODE_UNAVAILABLE.code).toBe('mode_unavailable');
  });
});
