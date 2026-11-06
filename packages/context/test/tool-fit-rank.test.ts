import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { FunctionTool } from '@momonga/protocol';
import { capabilitiesFor, harness, inputFor, sourcesWith } from './helpers.ts';

type RankedTool = FunctionTool & { fitRank?: number };

const ranked = (name: string, fitRank: number, descriptionChars: number): RankedTool => ({
  type: 'function',
  name,
  description: 'x'.repeat(descriptionChars),
  parameters: { type: 'object', properties: {} },
  fitRank,
});

const IN_RANK_ORDER: RankedTool[] = [
  ranked('Read', 0, 800),
  ranked('Bash', 1, 800),
  ranked('BashOutput', 2, 1),
  ranked('KillBash', 3, 1),
  ranked('Alpha', 4, 800),
  ranked('Beta', 5, 800),
  ranked('Gamma', 6, 800),
  ranked('Delta', 7, 800),
];

const HOST_OF = { BashOutput: 'Bash', KillBash: 'Bash' };

const PERMUTATIONS: RankedTool[][] = [
  IN_RANK_ORDER,
  [...IN_RANK_ORDER].reverse(),
  [IN_RANK_ORDER[6]!, IN_RANK_ORDER[3]!, IN_RANK_ORDER[0]!, IN_RANK_ORDER[7]!, IN_RANK_ORDER[2]!, IN_RANK_ORDER[5]!, IN_RANK_ORDER[1]!, IN_RANK_ORDER[4]!],
];

const buildWith = async (tools: readonly FunctionTool[], contextWindow: number) => {
  const capabilities = capabilitiesFor(contextWindow, { maxOutputTokens: 1024 });
  const { ports } = harness(capabilities);
  return buildContext(inputFor(capabilities, { sources: sourcesWith({ tools }), companions: { hostOf: HOST_OF, keepWithoutHost: false } }), ports);
};

const namesOf = (tools: readonly FunctionTool[]): string[] => tools.map((tool) => tool.name);
const droppedNoticeOf = (built: Awaited<ReturnType<typeof buildWith>>): string | undefined =>
  built.notices.find((notice) => notice.code === 'tools_dropped')?.message;

describe('the tools kept when they do not all fit', () => {
  it('are the same tools, with the same notice, for every order the candidates arrive in', async () => {
    const builds = await Promise.all(PERMUTATIONS.map((tools) => buildWith(tools, 1_536)));
    const [reference] = builds;
    expect(namesOf(reference!.tools).length).toBeLessThan(IN_RANK_ORDER.length);
    for (const built of builds) {
      expect(new Set(namesOf(built.tools))).toEqual(new Set(namesOf(reference!.tools)));
      expect(droppedNoticeOf(built)).toBe(droppedNoticeOf(reference!));
    }
  });

  it('keep the order the candidates arrived in, for every arrival order', async () => {
    for (const tools of PERMUTATIONS) {
      const kept = namesOf((await buildWith(tools, 1_536)).tools);
      expect(kept.length).toBeLessThan(IN_RANK_ORDER.length);
      expect(kept).toEqual(namesOf(tools).filter((name) => kept.includes(name)));
    }
  });

  it('are the leading tools in ascending fit rank, whatever the arrival order', async () => {
    const built = await buildWith([...IN_RANK_ORDER].reverse(), 1_536);
    const kept = namesOf(built.tools);
    expect(kept.length).toBeGreaterThan(0);
    expect(new Set(kept)).toEqual(new Set(namesOf(IN_RANK_ORDER).slice(0, kept.length)));
  });

  it('keep the reversed arrival order of the leading tools when the candidates arrive reversed', async () => {
    const built = await buildWith([...IN_RANK_ORDER].reverse(), 1_536);
    const kept = namesOf(built.tools);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(namesOf(IN_RANK_ORDER).slice(0, kept.length).reverse());
  });

  it('name every tool that was not kept in the notice, including a companion left out with its host', async () => {
    const heavyBash = IN_RANK_ORDER.map((tool) => (tool.name === 'Bash' ? ranked('Bash', 1, 20_000) : tool));
    const built = await buildWith([...heavyBash].reverse(), 1_536);
    const kept = new Set(namesOf(built.tools));
    expect(kept.has('Bash')).toBe(false);
    expect(kept.has('BashOutput')).toBe(false);
    expect(kept.has('KillBash')).toBe(false);
    const notice = droppedNoticeOf(built);
    expect(notice).toContain('BashOutput (with Bash)');
    expect(notice).toContain('KillBash (with Bash)');
    for (const name of namesOf(heavyBash).filter((name) => !kept.has(name))) expect(notice).toContain(name);
  });

  it('refuses two candidates with the same fit rank', async () => {
    const duplicated = [...IN_RANK_ORDER.slice(0, 7), ranked('Delta', 6, 800)];
    await expect(buildWith(duplicated, 1_536)).rejects.toThrow(/fitRank/);
  });

  it('refuses a candidate without a fit rank', async () => {
    const unranked: FunctionTool = { type: 'function', name: 'Delta', description: 'x', parameters: { type: 'object', properties: {} } };
    await expect(buildWith([...IN_RANK_ORDER.slice(0, 7), unranked], 1_536)).rejects.toThrow(/fitRank/);
  });
});

describe('a window that holds Bash and exactly one more tool', () => {
  const BASH_FIRST: RankedTool[] = [ranked('Bash', 0, 800), ranked('BashOutput', 1, 1), ranked('KillBash', 2, 1), ranked('Alpha', 3, 800), ranked('Beta', 4, 800)];
  const BASH_AND_ONE = BASH_FIRST.slice(0, 4);

  const windowHoldingAll = async (tools: readonly FunctionTool[]): Promise<number> => {
    for (let window = 1_024; window <= 16_384; window += 8) {
      const built = await buildWith(tools, window).catch(() => undefined);
      if (built !== undefined && built.tools.length === tools.length && droppedNoticeOf(built) === undefined) return window;
    }
    throw new Error('no window up to 16384 holds the tools');
  };

  it('keeps Bash with both companions and the next tool by rank, and names the rest in the notice', async () => {
    const window = await windowHoldingAll(BASH_AND_ONE);
    const built = await buildWith([...BASH_FIRST].reverse(), window);
    expect(new Set(namesOf(built.tools))).toEqual(new Set(['Bash', 'BashOutput', 'KillBash', 'Alpha']));
    const notice = droppedNoticeOf(built);
    expect(notice).toContain('Beta');
    for (const kept of ['Bash', 'BashOutput', 'KillBash', 'Alpha']) expect(notice).not.toMatch(new RegExp(`\\b${kept}\\b`));
  });

  it('keeps those tools in the order they arrived in', async () => {
    const window = await windowHoldingAll(BASH_AND_ONE);
    const built = await buildWith([...BASH_FIRST].reverse(), window);
    expect(namesOf(built.tools)).toEqual(['Alpha', 'KillBash', 'BashOutput', 'Bash']);
  });
});
