import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { readManifest } from './formal/manifest.ts';

const spec = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'specs', 'tla', 'ProcessMarker.tla'), 'utf8');

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in ProcessMarker.tla`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const manifest = readManifest(path.resolve(import.meta.dirname, '..', 'specs', 'tla', 'manifest.json'));

const setOf = (name: string): string[] => {
  const match = new RegExp(`^${name} == \\{([^}]*)\\}`, 'm').exec(spec);
  if (match === null) throw new Error(`${name} is not defined in ProcessMarker.tla`);
  return (match[1] ?? '').split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
};

describe('T14 conformance: the implementation of the attempt record and the write order follows specs/tla/ProcessMarker.tla', () => {
  it('the retry kinds of the record are the Events of the model, in the record order', () => {
    expect((foundation as Record<string, unknown>)['RETRY_KINDS']).toEqual(setOf('Events'));
  });

  it('the model bounds the retries by the number of kinds, which is four', () => {
    expect(spec).toMatch(/AtMostFourRetries == \\A m \\in Markers : tries\[m\]\["guard"\] \+ tries\[m\]\["sweep"\] \+ tries\[m\]\["startup"\] \+ tries\[m\]\["shutdown"\] <= 4/);
    expect(setOf('Events')).toHaveLength(4);
  });

  it('the marker states of the implementation are the views of the model', () => {
    expect((foundation as Record<string, unknown>)['MARKER_STATES']).toEqual(['free', 'held', 'unknown']);
    for (const state of ['free', 'held', 'unknown']) expect(spec).toContain(`"${state}"`);
  });
});

describe('the generation scope of the process markers, as specs/tla/ProcessMarker.tla states', () => {
  it('a sweep selects its own generation and the generations whose lock is free, and a marker of another live generation is unowned for it', () => {
    expect(definitionOf('InScope')).toContain('gen[m] = serving');
    expect(definitionOf('InScope')).toContain('~GenHeld(gen[m])');
    expect(definitionOf('UnsettledKeys')).toContain('InScope(m)');
    expect(definitionOf('UnsettledKeys')).toContain('gen[m] # serving');
  });

  it('the startup reap of a live generation is an evidence configuration, and the generation check holds', () => {
    expect(manifest.entries.find((entry) => entry.config === 'ProcessMarker.unscopedReap')).toMatchObject({ role: 'evidence', tier: 'every-run', expect: { violates: 'StartupReapSparesLiveGen', exitCode: 12 } });
    expect(manifest.entries.find((entry) => entry.config === 'ProcessMarker.generations')).toMatchObject({ role: 'check', expect: 'holds' });
  });
});

