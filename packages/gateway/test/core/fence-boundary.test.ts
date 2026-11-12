import { describe, expect, it } from 'vitest';
import type { AdapterInputItem } from '@momonga/protocol';
import { createFenceBoundary } from '../../src/core/fence-boundary.ts';

const history: AdapterInputItem[] = [{ type: 'message', role: 'user', content: 'read it' }];

describe('the boundary of a conversation without a session fence', () => {
  it('is keyed: two gateway keys give two boundaries for the same input, one key gives the same boundary every time', () => {
    const first = createFenceBoundary(new Uint8Array(32).fill(1));
    const second = createFenceBoundary(new Uint8Array(32).fill(2));
    expect(first(history)).toBe(first([...history]));
    expect(first(history)).not.toBe(second(history));
    expect(first(history)).toMatch(/^[0-9a-f]{32}$/);
  });
});
