import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import { ROOT_AGENTS, USER_AGENTS, capabilitiesFor, harness, inputFor } from './helpers.ts';

describe('loaded instruction text', () => {
  it('returns the exact text of every loaded instruction file', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, { files: { [USER_AGENTS]: 'user rules', [ROOT_AGENTS]: 'root rules' } });

    const result = await buildContext(inputFor(capabilities), ports);

    expect(result.loadedInstructions.map((entry) => [entry.path, entry.text])).toEqual([
      [USER_AGENTS, 'user rules'],
      [ROOT_AGENTS, 'root rules'],
    ]);
  });
});
