import { describe, expect, it } from 'vitest';
import { partitionTerms } from '../src/search-terms.ts';

describe('partitionTerms', () => {
  it('keeps a word of three characters or more for the index', () => {
    expect(partitionTerms(['fix', 'parser'])).toEqual({ indexed: ['fix', 'parser'], short: [] });
  });

  it('drops a short ASCII word when another term can carry the query', () => {
    expect(partitionTerms(['fix', 'a', 'bug'])).toEqual({ indexed: ['fix', 'bug'], short: [] });
    expect(partitionTerms(['to', 'parser'])).toEqual({ indexed: ['parser'], short: [] });
  });

  it('keeps a short word of two characters or more with a non-ASCII character, so Japanese still works', () => {
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
