import { describe, expect, it, vi } from 'vitest';
import { buildContext } from '@momonga/context';
import type { AnyTool } from '@momonga/tools';
import { makeTool, toolSetOf } from '../packages/tools/test/harness.ts';
import { capabilitiesFor, harness, inputFor, seeded, sourcesWith } from '../packages/context/test/helpers.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const LONG = 'x'.repeat(800);

const freshTools = (): AnyTool[] => [
  makeTool('Read', { tier: 'essential', description: LONG }),
  makeTool('Bash', { tier: 'common', description: LONG }),
  makeTool('Make', { tier: 'common', description: LONG }),
  makeTool('BashOutput', { tier: 'optional', companionOf: 'Bash' }),
  makeTool('KillBash', { tier: 'optional', companionOf: 'Bash' }),
  makeTool('Alpha', { tier: 'optional', description: LONG }),
  makeTool('Beta', { tier: 'optional', description: LONG }),
  makeTool('Gamma', { tier: 'optional', description: LONG }),
  makeTool('Delta', { tier: 'optional', description: LONG }),
];

const shuffled = <T>(items: readonly T[], seed: number): T[] => {
  const random = seeded(seed);
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = random.int(0, index);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
};

const outcomeOf = async (tools: readonly AnyTool[]) => {
  const set = await toolSetOf(...tools);
  const offered = set.forModel({ mode: 'manual', rules: [] });
  const capabilities = capabilitiesFor(2_048, { maxOutputTokens: 1024 });
  const { ports } = harness(capabilities);
  const built = await buildContext(
    inputFor(capabilities, { sources: sourcesWith({ tools: offered }), companions: { hostOf: Object.fromEntries(set.companions), keepWithoutHost: false } }),
    ports,
  );
  return {
    digest: set.digest,
    offered: offered.map((tool) => tool.name),
    kept: built.tools.map((tool) => tool.name),
    notice: built.notices.find((notice) => notice.code === 'tools_dropped')?.message,
  };
};

const SEEDS = Array.from({ length: 24 }, (_, index) => index + 1);

describe('the tools kept, their order and the digest', () => {
  it('drop some tools at the property window', async () => {
    const reference = await outcomeOf(freshTools());
    expect(reference.kept.length).toBeLessThan(reference.offered.length);
  });

  it.each(SEEDS)('are the same for every registration order (seed %i)', async (seed) => {
    const reference = await outcomeOf(freshTools());
    const permuted = await outcomeOf(shuffled(freshTools(), seed));
    expect(permuted.offered).toEqual(['Read', 'Bash', 'BashOutput', 'KillBash', 'Make', 'Alpha', 'Beta', 'Delta', 'Gamma']);
    expect(permuted.digest).toBe(reference.digest);
    expect(permuted.offered).toEqual(reference.offered);
    expect(permuted.kept).toEqual(reference.kept);
    expect(permuted.notice).toBe(reference.notice);
  });
});

describe('the tools_dropped notice', () => {
  const HUGE = 'x'.repeat(20_000);
  const droppedByTier = (message: string): Record<string, string[]> => {
    const list = /^The declared context window of \S+ \(\d+ tokens\) leaves no room for these tools, so they were left out: (.*); raise the declared context window of that model/.exec(message)?.[1];
    expect(list, message).toBeDefined();
    return Object.fromEntries(
      list!.split('; ').map((group) => {
        const tiered = /^(.*) \((\w+) tools\)$/.exec(group);
        return tiered === null ? ['', group.split(', ')] : [tiered[2], tiered[1]!.split(', ')];
      }),
    );
  };

  it('groups the dropped tools by tier, each companion marked with its host and ranked in its host tier, in the sentence that names the declared context window"', async () => {
    const set = await toolSetOf(
      makeTool('Read', { tier: 'essential' }),
      makeTool('Bash', { tier: 'common', description: HUGE }),
      makeTool('BashOutput', { tier: 'optional', companionOf: 'Bash' }),
      makeTool('KillBash', { tier: 'optional', companionOf: 'Bash' }),
      makeTool('Alpha', { tier: 'optional', description: HUGE }),
      makeTool('Beta', { tier: 'optional', description: HUGE }),
    );
    const capabilities = capabilitiesFor(1_536, { maxOutputTokens: 1024 });
    const { ports } = harness(capabilities);
    const built = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ tools: set.forModel({ mode: 'manual', rules: [] }) }),
        companions: { hostOf: Object.fromEntries(set.companions), keepWithoutHost: false },
      }),
      ports,
    );
    expect(built.tools.map((tool) => tool.name)).toEqual(['Read']);
    const message = built.notices.find((notice) => notice.code === 'tools_dropped')?.message;
    expect(message).toBeDefined();
    expect(droppedByTier(message!)).toEqual({
      common: ['Bash', 'BashOutput (with Bash)', 'KillBash (with Bash)'],
      optional: ['Alpha', 'Beta'],
    });
  });
});
