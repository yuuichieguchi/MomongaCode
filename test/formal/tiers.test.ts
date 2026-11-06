import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readManifest } from './manifest.ts';

const manifest = readManifest(path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla', 'manifest.json'));
const tierOf = (config: string) => manifest.entries.find((entry) => entry.config === config)?.tier;

describe('the tiers of the TLC configurations (decision 49)', () => {
  it.each(['ProcessMarker', 'ProcessMarker.full', 'ProcessMarker.lifecycle', 'BashExpiry', 'OutputDrain', 'OutputDrain.ceilingOnly', 'ProcessStop'])(
    'runs the holding check %s in the every-run tier',
    (config) => {
      expect(tierOf(config)).toBe('every-run');
    },
  );

  it('runs every evidence configuration in the every-run tier', () => {
    const evidence = manifest.entries.filter((entry) => entry.role === 'evidence');
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.filter((entry) => entry.tier !== 'every-run').map((entry) => entry.config)).toEqual([]);
  });
});
