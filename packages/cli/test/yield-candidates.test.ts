import type { YieldFamily } from '@momonga/eval';
import { describe, expect, it } from 'vitest';
import { familySettingsFor } from '../src/eval/yield-host.ts';

const FAMILY = { id: 'codename', learn: { input: 'find the codename', verification: 'node tools/check.mjs' }, reuse: { input: 'use it', graders: [] }, accept: { anchors: ['Bluebird'] } } as unknown as YieldFamily;

describe('the learn session of a yield family', () => {
  it('stores no repository fact, so its candidates are the ones reflection proposed, the population the yield counts', () => {
    const settings = familySettingsFor({ models: {} }, FAMILY);

    expect(settings['memory']).toEqual({ repositoryFacts: false });
    expect(settings['verification']).toEqual({ commands: ['node tools/check.mjs'] });
  });

  it('keeps the memory settings the case home was given', () => {
    const settings = familySettingsFor({ models: {}, memory: { reflection: { maxTokens: 900 } } }, FAMILY);

    expect(settings['memory']).toEqual({ reflection: { maxTokens: 900 }, repositoryFacts: false });
  });
});
