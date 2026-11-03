import { describe, expect, it } from 'vitest';
import { normalizeMemoryText } from '@momonga/memory';

describe('normalizeMemoryText', () => {
  it('composes Unicode to NFC, so a decomposed and a composed spelling are equal', () => {
    expect(normalizeMemoryText('café')).toBe(normalizeMemoryText('café'));
    expect(normalizeMemoryText('café')).toBe('café');
  });

  it('trims and collapses every whitespace run to one space', () => {
    expect(normalizeMemoryText('  run \t the\n\nseed　script  ')).toBe('run the seed script');
  });

  it('keeps case, because identifiers are case-sensitive', () => {
    expect(normalizeMemoryText('Use FooBar')).toBe('Use FooBar');
    expect(normalizeMemoryText('Use FooBar')).not.toBe(normalizeMemoryText('use foobar'));
  });

  it('keeps words that differ', () => {
    expect(normalizeMemoryText('use X')).not.toBe(normalizeMemoryText('do not use X'));
  });
});
