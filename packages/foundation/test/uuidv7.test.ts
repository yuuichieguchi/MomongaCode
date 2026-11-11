import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@momonga/foundation';
import type { Random } from '@momonga/foundation';
import { createFakeClock, createFakeRandom } from '@momonga/testkit';

const FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const zeros: Random = { ...createFakeRandom(1), bytes: (length) => new Uint8Array(length) };

describe('uuidv7', () => {
  it('follows the RFC 9562 layout with version 7 and variant 10', () => {
    const id = uuidv7();
    expect(id).toMatch(FORMAT);
  });

  it('encodes the clock millisecond in the first 48 bits (RFC 9562 example timestamp)', () => {
    const id = uuidv7(createFakeClock(1_645_557_742_000));
    expect(id.slice(0, 13)).toBe('017f22e2-79b0');
  });

  it('is strictly increasing for many ids in the same millisecond', () => {
    const clock = createFakeClock(1_700_000_000_000);
    const ids = Array.from({ length: 10_000 }, () => uuidv7(clock));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(FORMAT);
  });

  it('stays unique and increasing with a constant random source', () => {
    const clock = createFakeClock(1_700_000_000_000);
    const ids = Array.from({ length: 1000 }, () => uuidv7(clock, zeros));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('keeps increasing when the clock goes backwards', () => {
    const clock = createFakeClock(1_700_000_000_000);
    const first = uuidv7(clock);
    clock.set(1_699_999_000_000);
    const second = uuidv7(clock);
    const third = uuidv7(clock);
    expect(second > first).toBe(true);
    expect(third > second).toBe(true);
    expect(second).toMatch(FORMAT);
  });

  it('moves to the new timestamp when the clock advances', () => {
    const clock = createFakeClock(1_645_557_742_000);
    uuidv7(clock);
    clock.advance(1);
    expect(uuidv7(clock).slice(0, 13)).toBe('017f22e2-79b1');
  });
});
