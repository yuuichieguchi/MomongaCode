import { describe, expect, it } from 'vitest';
import { COMMON_ENTRY_FLAGS } from '@momonga/foundation';
import { RUNTIME_ENTRY_FLAGS } from '@momonga/runtime';

describe('RUNTIME_ENTRY_FLAGS spreads COMMON_ENTRY_FLAGS (B1)', () => {
  it('every key of COMMON_ENTRY_FLAGS appears in RUNTIME_ENTRY_FLAGS with an identical spec object', () => {
    const commonKeys = Object.keys(COMMON_ENTRY_FLAGS) as Array<keyof typeof COMMON_ENTRY_FLAGS>;
    expect(commonKeys.length).toBeGreaterThan(0);
    for (const key of commonKeys) {
      expect(RUNTIME_ENTRY_FLAGS).toHaveProperty(key);
      expect((RUNTIME_ENTRY_FLAGS as Record<string, unknown>)[key]).toBe((COMMON_ENTRY_FLAGS as Record<string, unknown>)[key]);
    }
  });
});
