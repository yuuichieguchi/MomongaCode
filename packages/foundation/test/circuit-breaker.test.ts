import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';

const make = () => {
  const clock = createFakeClock(1_000_000);
  const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 5000, clock });
  return { clock, breaker };
};

const tripOpen = (breaker: CircuitBreaker) => {
  for (let index = 0; index < 3; index += 1) {
    expect(breaker.canPass()).toBe(true);
    breaker.onFailure();
  }
};

describe('CircuitBreaker', () => {
  it('starts closed and lets calls pass', () => {
    const { breaker } = make();
    expect(breaker.state).toBe('closed');
    expect(breaker.canPass()).toBe(true);
  });

  it('opens only after threshold consecutive failures', () => {
    const { breaker } = make();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.state).toBe('closed');
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canPass()).toBe(false);
  });

  it('resets the failure counter on success while closed', () => {
    const { breaker } = make();
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.state).toBe('closed');
    breaker.onFailure();
    expect(breaker.state).toBe('open');
  });

  it('rejects until openMs has elapsed, then allows exactly one half-open trial', () => {
    const { clock, breaker } = make();
    tripOpen(breaker);
    clock.advance(4999);
    expect(breaker.canPass()).toBe(false);
    clock.advance(1);
    expect(breaker.canPass()).toBe(true);
    expect(breaker.state).toBe('half-open');
    expect(breaker.canPass()).toBe(false);
    expect(breaker.canPass()).toBe(false);
  });

  it('closes and resets the counter after a successful trial', () => {
    const { clock, breaker } = make();
    tripOpen(breaker);
    clock.advance(5000);
    expect(breaker.canPass()).toBe(true);
    breaker.onSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.canPass()).toBe(true);
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.state).toBe('closed');
  });

  it('reopens with a fresh openMs after a failed trial', () => {
    const { clock, breaker } = make();
    tripOpen(breaker);
    clock.advance(5000);
    expect(breaker.canPass()).toBe(true);
    clock.advance(1000);
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    clock.advance(4999);
    expect(breaker.canPass()).toBe(false);
    clock.advance(1);
    expect(breaker.canPass()).toBe(true);
  });

  it('allows a new trial after openMs when the previous half-open trial never reported', () => {
    const { clock, breaker } = make();
    tripOpen(breaker);
    clock.advance(5000);
    expect(breaker.canPass()).toBe(true);
    clock.advance(4999);
    expect(breaker.canPass()).toBe(false);
    clock.advance(1);
    expect(breaker.canPass()).toBe(true);
    expect(breaker.state).toBe('half-open');
    expect(breaker.canPass()).toBe(false);
  });

  it('closes the breaker when an abandoned trial reports success late', () => {
    const { clock, breaker } = make();
    tripOpen(breaker);
    clock.advance(5000);
    expect(breaker.canPass()).toBe(true);
    clock.advance(5000);
    expect(breaker.canPass()).toBe(true);
    breaker.onSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.canPass()).toBe(true);
  });

  it('re-trips the breaker when an abandoned trial reports failure late', () => {
    const { clock, breaker } = make();
    tripOpen(breaker);
    clock.advance(5000);
    expect(breaker.canPass()).toBe(true);
    clock.advance(5000);
    expect(breaker.canPass()).toBe(true);
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canPass()).toBe(false);
    clock.advance(5000);
    expect(breaker.canPass()).toBe(true);
  });

  it('ignores a late success while open', () => {
    const { breaker } = make();
    tripOpen(breaker);
    breaker.onSuccess();
    expect(breaker.state).toBe('open');
    expect(breaker.canPass()).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects failureThreshold %s', (failureThreshold) => {
    expect(() => new CircuitBreaker({ failureThreshold, openMs: 5000, clock: createFakeClock(0) })).toThrow(/failureThreshold/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects openMs %s', (openMs) => {
    expect(() => new CircuitBreaker({ failureThreshold: 3, openMs, clock: createFakeClock(0) })).toThrow(/openMs/);
  });
  describe('onNeutral', () => {
    it('leaves a closed breaker and its failure count untouched', () => {
      const { breaker } = make();
      breaker.onFailure();
      breaker.onFailure();
      breaker.onNeutral();
      expect(breaker.state).toBe('closed');
      breaker.onFailure();
      expect(breaker.state).toBe('open');
    });

    it('leaves an open breaker open', () => {
      const { breaker } = make();
      tripOpen(breaker);
      breaker.onNeutral();
      expect(breaker.state).toBe('open');
      expect(breaker.canPass()).toBe(false);
    });

    it('releases the half-open trial slot without closing or reopening', () => {
      const { clock, breaker } = make();
      tripOpen(breaker);
      clock.advance(5000);
      expect(breaker.canPass()).toBe(true);
      expect(breaker.canPass()).toBe(false);
      breaker.onNeutral();
      expect(breaker.state).toBe('half-open');
      expect(breaker.canPass()).toBe(true);
    });
  });
});
