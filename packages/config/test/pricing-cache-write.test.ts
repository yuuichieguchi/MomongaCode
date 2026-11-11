import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

const entry = { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15, currency: 'USD' };

describe('pricing with a cache-write rate', () => {
  it('takes cacheWritePerMTok from the user settings, so the bill follows the provider cache pricing, and rejects a negative one', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { pricing: [{ ...entry, cacheWritePerMTok: 3.75 }] });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.pricing).toEqual([{ ...entry, cacheWritePerMTok: 3.75 }]);

    const negative = makeTree();
    writeJson(userSettingsPath(negative), { pricing: [{ ...entry, cacheWritePerMTok: -1 }] });
    await expect(loadSettings({ signal: new AbortController().signal, home: negative.home, projectDir: negative.project, cli: {}, trust: trusting(negative) })).rejects.toThrow(/pricing/);
  });
});
