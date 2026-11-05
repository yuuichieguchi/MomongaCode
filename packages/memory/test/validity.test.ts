import { describe, expect, it } from 'vitest';
import { validityOf } from '@momonga/memory';

const CREATED = 1_000;

const observed = (status: 'verified' | 'unbound' | 'unverifiable' | 'stale', observedAt: number) => ({ status, observedAt });

describe('validityOf', () => {
  it('verified, stale, verified again gives three intervals', () => {
    const validity = validityOf({
      observations: [observed('verified', 1_000), observed('stale', 2_000), observed('verified', 3_000)],
      createdAt: CREATED,
      successorCreatedAt: null,
      retiredAt: null,
    });
    expect(validity.intervals).toEqual([
      { status: 'verified', from: 1_000, to: 2_000, closedBy: 'observation' },
      { status: 'stale', from: 2_000, to: 3_000, closedBy: 'observation' },
      { status: 'verified', from: 3_000, to: null, closedBy: null },
    ]);
  });

  it('the last interval is open', () => {
    const validity = validityOf({ observations: [observed('unbound', 1_000)], createdAt: CREATED, successorCreatedAt: null, retiredAt: null });
    expect(validity.intervals).toEqual([{ status: 'unbound', from: 1_000, to: null, closedBy: null }]);
  });

  it('a successor closes the interval at its createdAt', () => {
    const validity = validityOf({
      observations: [observed('verified', 1_000), observed('stale', 2_000)],
      createdAt: CREATED,
      successorCreatedAt: 2_500,
      retiredAt: null,
    });
    expect(validity.intervals).toEqual([
      { status: 'verified', from: 1_000, to: 2_000, closedBy: 'observation' },
      { status: 'stale', from: 2_000, to: 2_500, closedBy: 'successor' },
    ]);
  });

  it('a retirement closes it at retiredAt', () => {
    const validity = validityOf({ observations: [observed('verified', 1_000)], createdAt: CREATED, successorCreatedAt: null, retiredAt: 4_000 });
    expect(validity.intervals).toEqual([{ status: 'verified', from: 1_000, to: 4_000, closedBy: 'retirement' }]);
  });

  it('the earlier of a successor and a retirement closes it', () => {
    const validity = validityOf({ observations: [observed('verified', 1_000)], createdAt: CREATED, successorCreatedAt: 6_000, retiredAt: 4_000 });
    expect(validity.intervals).toEqual([{ status: 'verified', from: 1_000, to: 4_000, closedBy: 'retirement' }]);
  });

  it('changedBetween is the pair of observations, never a single time', () => {
    const validity = validityOf({
      observations: [observed('verified', 1_000), observed('stale', 2_000), observed('verified', 3_000)],
      createdAt: CREATED,
      successorCreatedAt: null,
      retiredAt: null,
    });
    expect(validity.changes).toEqual([
      { from: 'verified', to: 'stale', changedBetween: [1_000, 2_000] },
      { from: 'stale', to: 'verified', changedBetween: [2_000, 3_000] },
    ]);
    for (const change of validity.changes) {
      expect(change).not.toHaveProperty('changedAt');
      expect(change.changedBetween[0]).toBeLessThan(change.changedBetween[1]);
    }
  });

  it('a note with one finding has no change', () => {
    expect(validityOf({ observations: [observed('verified', 1_000)], createdAt: CREATED, successorCreatedAt: null, retiredAt: null }).changes).toEqual([]);
  });
});
