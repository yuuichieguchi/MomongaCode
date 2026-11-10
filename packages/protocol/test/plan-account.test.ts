import { describe, expect, it } from 'vitest';
import { planAccountRefOf } from '../src/index.ts';

describe('planAccountRefOf reads a plan account reference from untrusted input', () => {
  it('planAccountRefOf copies profile and account from a record', () => {
    const ref = planAccountRefOf({ profile: 'chatgpt', account: 'work', x: 1 });
    expect(ref).toEqual({ profile: 'chatgpt', account: 'work' });
    expect(ref !== undefined && 'x' in ref).toBe(false);
  });

  it('planAccountRefOf is undefined for a non-record, a missing member and a non-string member', () => {
    expect([null, [], { profile: 'a' }, { profile: 'a', account: 1 }].map((value) => planAccountRefOf(value))).toEqual([undefined, undefined, undefined, undefined]);
  });
});
