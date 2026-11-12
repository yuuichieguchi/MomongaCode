import { describe, expect, it } from 'vitest';
import { parsePolicyOverlay } from '@momonga/eval';

describe('an overlay that restates a default is refused', () => {
  it('refuses context.cachePrefix true, its default, by name', () => {
    expect(() => parsePolicyOverlay(JSON.stringify({ context: { cachePrefix: true } }), 'policy.json')).toThrow(/policy\.json: context\.cachePrefix restates its default/);
  });

  it('names every restated key at once', () => {
    expect(() => parsePolicyOverlay(JSON.stringify({ tools: { deferral: true, conciseDescriptions: true } }), 'policy.json')).toThrow(/policy\.json: tools\.deferral, tools\.conciseDescriptions restate their defaults/);
  });

  it('accepts a value that differs from the default', () => {
    expect(parsePolicyOverlay(JSON.stringify({ context: { cachePrefix: false } }), 'policy.json')).toEqual({ context: { cachePrefix: false } });
  });
});
