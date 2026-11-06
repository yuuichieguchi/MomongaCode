import { describe, expect, it } from 'vitest';
import { createCanary, findCanaries } from '../src/index.ts';

describe('canary tokens', () => {
  it('are long, random, distinct and carry their label', () => {
    const canaries = Array.from({ length: 50 }, () => createCanary('access'));
    expect(new Set(canaries).size).toBe(50);
    for (const canary of canaries) {
      expect(canary.length).toBeGreaterThanOrEqual(64);
      expect(canary.startsWith('canary-access-')).toBe(true);
      expect(canary).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('are found in text, in JSON and in a URL-encoded query, and not in clean text', () => {
    const [first, second] = [createCanary('refresh'), createCanary('id')] as [string, string];
    expect(findCanaries(`log line ${first} tail`, [first, second])).toEqual([first]);
    expect(findCanaries(JSON.stringify({ nested: { value: second } }), [first, second])).toEqual([second]);
    expect(findCanaries(new URLSearchParams({ id_token_hint: first }).toString(), [first])).toEqual([first]);
    expect(findCanaries(encodeURIComponent(`a b ${second}`), [second])).toEqual([second]);
    expect(findCanaries('nothing to see', [first, second])).toEqual([]);
  });

  it('are found by a long prefix, since a redactor may truncate a token', () => {
    const canary = createCanary('access');
    expect(findCanaries(`prefix ${canary.slice(0, 40)} suffix`, [canary])).toEqual([canary]);
    expect(findCanaries(`prefix ${canary.slice(0, 12)} suffix`, [canary])).toEqual([]);
  });

  it('refuse an empty label and a label that would make the canary short or unsafe', () => {
    expect(() => createCanary('')).toThrow(/label/);
    expect(() => createCanary('has space')).toThrow(/label/);
  });
});
