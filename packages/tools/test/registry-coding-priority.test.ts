import { describe, expect, it } from 'vitest';
import { TEST_BUILTIN_TOOL_OFFER } from '@momonga/testkit';
import { createBuiltinTools } from '@momonga/tools';
import { toolSetOf } from './harness.ts';

const offered = async (): Promise<ReadonlyArray<{ name: string; fitRank: number; fitTier: string }>> =>
  (await toolSetOf(...createBuiltinTools(TEST_BUILTIN_TOOL_OFFER))).forModel({ mode: 'manual', rules: [] }) as unknown as ReadonlyArray<{ name: string; fitRank: number; fitTier: string }>;

describe('the fit order of the built-in tools is the order a coding task needs them', () => {
  it('places Edit and Write right after Read, in its tier, before every tool of a later tier', async () => {
    const tools = await offered();
    const rankOf = (name: string): number => tools.find((tool) => tool.name === name)!.fitRank;

    expect(tools.find((tool) => tool.name === 'Edit')?.fitTier).toBe('essential');
    expect(tools.find((tool) => tool.name === 'Write')?.fitTier).toBe('essential');
    expect([rankOf('Read'), rankOf('Edit'), rankOf('Write')]).toEqual([rankOf('Read'), rankOf('Read') + 1, rankOf('Read') + 2]);
    expect(rankOf('Write')).toBeLessThan(rankOf('Bash'));
  });

  it('keeps Edit and Write only with Read, which they need first', async () => {
    const toolSet = await toolSetOf(...createBuiltinTools(TEST_BUILTIN_TOOL_OFFER));

    expect(toolSet.companions.get('Edit')).toBe('Read');
    expect(toolSet.companions.get('Write')).toBe('Read');
  });
});
