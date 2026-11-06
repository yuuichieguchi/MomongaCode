import { describe, expect, it } from 'vitest';
import { createCapabilityProbe } from '@momonga/foundation';
import type { CapabilityResult } from '@momonga/foundation';

const countingProbe = (results: Record<string, CapabilityResult<boolean>>) => {
  const measured: string[] = [];
  const probe = createCapabilityProbe<string, boolean>(
    (input) => input,
    (input) => {
      measured.push(input);
      return results[input] as CapabilityResult<boolean>;
    },
  );
  return { probe, measured };
};

describe('capabilityProbe', () => {
  it('measures a supported answer once per key and answers later calls from the cache', () => {
    const { probe, measured } = countingProbe({ a: { kind: 'supported', value: true, evidence: 'measured a' } });
    expect(probe('a')).toEqual({ kind: 'supported', value: true, evidence: 'measured a' });
    expect(probe('a')).toEqual({ kind: 'supported', value: true, evidence: 'measured a' });
    expect(measured).toEqual(['a']);
  });

  it('caches an unsupported answer', () => {
    const { probe, measured } = countingProbe({ b: { kind: 'unsupported', evidence: 'kernel refused b' } });
    expect(probe('b').kind).toBe('unsupported');
    expect(probe('b').kind).toBe('unsupported');
    expect(measured).toEqual(['b']);
  });

  it('never caches an unmeasured answer, so the next call measures again', () => {
    const { probe, measured } = countingProbe({ c: { kind: 'unmeasured', evidence: 'probe could not run' } });
    expect(probe('c')).toEqual({ kind: 'unmeasured', evidence: 'probe could not run' });
    expect(probe('c').kind).toBe('unmeasured');
    expect(measured).toEqual(['c', 'c']);
  });

  it('keeps one cache entry per key', () => {
    const { probe, measured } = countingProbe({
      a: { kind: 'supported', value: true, evidence: 'a' },
      b: { kind: 'supported', value: false, evidence: 'b' },
    });
    probe('a');
    probe('b');
    probe('a');
    probe('b');
    expect(measured).toEqual(['a', 'b']);
  });
});
