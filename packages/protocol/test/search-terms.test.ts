import { describe, expect, it } from 'vitest';
import { MIN_INDEXED_TERM_CHARS, asciiLower, partitionTerms, termsOf } from '@momonga/protocol';

describe('the shared term rule', () => {
  it('indexes a term of three characters or more', () => {
    expect(MIN_INDEXED_TERM_CHARS).toBe(3);
  });

  it('splits a query on white space and lowers only ASCII letters', () => {
    expect(termsOf('  Fix   the PARSER\tÄrger ')).toEqual(['fix', 'the', 'parser', 'Ärger']);
    expect(asciiLower('ABC-Äz')).toBe('abc-Äz');
  });

  it('keeps a word of three characters or more for the index', () => {
    expect(partitionTerms(['fix', 'parser'])).toEqual({ indexed: ['fix', 'parser'], short: [] });
  });

  it('drops a short ASCII word when another term can carry the query', () => {
    expect(partitionTerms(['fix', 'a', 'bug'])).toEqual({ indexed: ['fix', 'bug'], short: [] });
    expect(partitionTerms(['to', 'parser'])).toEqual({ indexed: ['parser'], short: [] });
  });

  it('keeps a short word of two characters or more with a non-ASCII character', () => {
    expect(partitionTerms(['設計', 'parser'])).toEqual({ indexed: ['parser'], short: ['設計'] });
  });

  it('drops a single non-ASCII character beside another term', () => {
    expect(partitionTerms(['設', 'parser'])).toEqual({ indexed: ['parser'], short: [] });
  });

  it('keeps every term when none of them could carry the query alone', () => {
    expect(partitionTerms(['a'])).toEqual({ indexed: [], short: ['a'] });
    expect(partitionTerms(['a', 'b'])).toEqual({ indexed: [], short: ['a', 'b'] });
  });
});
