import { describe, expect, it } from 'vitest';
import { definePriceTable, quoteChain } from '@momonga/observability';

const table = definePriceTable([
  { provider: 'p', model: 'cheap', effectiveFrom: '2026-01-01', inputPerMTok: 1, outputPerMTok: 2, currency: 'USD' },
  { provider: 'p', model: 'dear', effectiveFrom: '2026-02-01', inputPerMTok: 0.5, cacheWritePerMTok: 4, outputPerMTok: 9, currency: 'USD' },
  { provider: 'p', model: 'later', effectiveFrom: '2027-01-01', inputPerMTok: 1, outputPerMTok: 1, currency: 'USD' },
]);
const at = Date.parse('2026-06-01T00:00:00Z');

const metered = (model: string) => ({ billing: 'metered', provider: 'p', model });

describe('the quote of a model is the largest price of the models a request may be answered by', () => {
  it('takes the larger input price (cache write included) and the larger output price over the members, with every price version', () => {
    expect(quoteChain('m', [metered('cheap'), metered('dear'), { billing: 'local', provider: undefined, model: 'x' }], table, at)).toEqual({
      model: 'm',
      priced: true,
      inUnits: '4000000000',
      outUnits: '9000000000',
      priceVersions: ['2026-01-01', '2026-02-01', 'local'],
    });
  });

  it('prices a chain of local models at zero', () => {
    expect(quoteChain('m', [{ billing: 'local', provider: undefined, model: 'x' }], table, at)).toEqual({ model: 'm', priced: true, inUnits: '0', outUnits: '0', priceVersions: ['local'] });
  });

  it.each([
    ['a member with no price entry', metered('unknown')],
    ['a member billed by a plan', { billing: 'plan', provider: 'p', model: 'cheap' }],
    ['a member whose billing is unknown', { billing: 'unknown', provider: 'p', model: 'cheap' }],
    ['a member with no billing', { billing: undefined, provider: 'p', model: 'cheap' }],
    ['a metered member with no provider', { billing: 'metered', provider: undefined, model: 'cheap' }],
    ['a price entry that is not yet in force', metered('later')],
  ])('is not priced when the chain holds %s', (_label, unpriced) => {
    expect(quoteChain('m', [metered('cheap'), unpriced], table, at)).toEqual({ model: 'm', priced: false });
  });

  it('is not priced for a chain with no member', () => {
    expect(quoteChain('m', [], table, at)).toEqual({ model: 'm', priced: false });
  });
});
