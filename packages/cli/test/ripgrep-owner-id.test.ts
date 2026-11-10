import { describe, expect, it } from 'vitest';
import type { ProcessInspector } from '@momonga/foundation';
import { ownOwnerIdWith, ownerIdOf } from '../src/ripgrep/host.ts';

describe('the ripgrep owner id carries the start time as decimal text', () => {
  it('writes a Windows FILETIME of 2^60 in full', () => {
    expect(ownerIdOf(4242, 2n ** 60n)).toBe('4242.1152921504606846976');
  });

  it('builds the own owner id from the bigint start time the inspector reports', async () => {
    const inspector = { startTimeOf: async () => ({ kind: 'value', value: 987654n }) } as unknown as ProcessInspector;
    expect(await ownOwnerIdWith(inspector, 4242)({ signal: new AbortController().signal })).toBe('4242.987654');
  });
});
