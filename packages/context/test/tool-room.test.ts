import { describe, expect, it } from 'vitest';
import { PinnedOverflowError, buildContext, inputCeilingFor, MIN_ROOM_TOKENS } from '@momonga/context';
import type { FunctionTool } from '@momonga/protocol';
import { capabilitiesFor, harness, inputFor, sourcesWith, tokensOfTools } from './helpers.ts';

const toolNamed = (name: string, descriptionChars: number): FunctionTool => ({
  type: 'function',
  name,
  description: 'x'.repeat(descriptionChars),
  parameters: { type: 'object', properties: {} },
});

const ranked = (tool: FunctionTool, fitRank: number): FunctionTool & { fitRank: number } => ({ ...tool, fitRank });

const TOOLS = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => toolNamed(name, 800));

const builtWith = async (contextWindow: number) => {
  const capabilities = capabilitiesFor(contextWindow, { maxOutputTokens: 1024 });
  const { ports } = harness(capabilities);
  return { capabilities, built: await buildContext(inputFor(capabilities, { sources: sourcesWith({ tools: TOOLS }) }), ports) };
};

describe('the tools a target is offered', () => {
  it('are all of them, with their full descriptions, when the declared window has room', async () => {
    const { built } = await builtWith(128_000);
    expect(built.tools).toEqual(TOOLS);
    expect(built.notices.map((notice) => notice.code)).not.toContain('tools_dropped');
  });

  it('are the leading ones that leave the minimum conversation room when the declared window is small, with a notice for the rest', async () => {
    const { capabilities, built } = await builtWith(1_536);
    const ceiling = inputCeilingFor(capabilities);
    expect(built.tools.length).toBeGreaterThan(0);
    expect(built.tools.length).toBeLessThan(TOOLS.length);
    expect(built.tools).toEqual(TOOLS.slice(0, built.tools.length));
    expect(tokensOfTools(built.tools)).toBeLessThanOrEqual(ceiling - MIN_ROOM_TOKENS);
    expect(built.notices.map((notice) => notice.code)).toContain('tools_dropped');
  });

  it('are the same on every build of the same inputs', async () => {
    const first = await builtWith(1_536);
    const second = await builtWith(1_536);
    expect(second.built.tools).toEqual(first.built.tools);
    expect(second.built.pinnedDigest).toBe(first.built.pinnedDigest);
  });

  it('do not change with the length of the task, because the task is not part of the floor', async () => {
    const capabilities = capabilitiesFor(1_536, { maxOutputTokens: 1024 });
    const { ports } = harness(capabilities);
    const task = (text: string) => ({ type: 'message' as const, role: 'user' as const, content: text });
    const short = await buildContext(inputFor(capabilities, { sources: sourcesWith({ tools: TOOLS, task: task('Do the work.') }) }), ports);
    const longer = await buildContext(inputFor(capabilities, { sources: sourcesWith({ tools: TOOLS, task: task('Do the work. '.repeat(20)) }) }), ports);
    expect(longer.tools).toEqual(short.tools);
    expect(longer.notices.filter((notice) => notice.code === 'tools_dropped')).toEqual(short.notices.filter((notice) => notice.code === 'tools_dropped'));
  });

  describe('that serve another tool', () => {
    const SERVING = [...TOOLS, toolNamed('G', 1)];
    const hostOf = { G: 'F' };
    const builtFor = async (contextWindow: number, tools: readonly FunctionTool[], keepWithoutHost: boolean) => {
      const capabilities = capabilitiesFor(contextWindow, { maxOutputTokens: 1024 });
      const { ports } = harness(capabilities);
      return buildContext(inputFor(capabilities, { sources: sourcesWith({ tools }), companions: { hostOf, keepWithoutHost } }), ports);
    };
    const namesOf = (tools: readonly FunctionTool[]): string[] => tools.map((tool) => tool.name);

    it('are offered with the tool they serve', async () => {
      expect(namesOf((await builtFor(128_000, SERVING, false)).tools)).toEqual(namesOf(SERVING));
    });

    it('are not offered when the tool they serve is not a candidate and nothing keeps them', async () => {
      const withoutHost = SERVING.filter((tool) => tool.name !== 'F');
      expect(namesOf((await builtFor(128_000, withoutHost, false)).tools)).toEqual(['A', 'B', 'C', 'D', 'E']);
    });

    it('are offered without the tool they serve when something keeps them', async () => {
      const withoutHost = SERVING.filter((tool) => tool.name !== 'F');
      expect(namesOf((await builtFor(128_000, withoutHost, true)).tools)).toEqual(['A', 'B', 'C', 'D', 'E', 'G']);
    });

    it('are not offered when the declared window leaves no room for the tool they serve, although they would fit', async () => {
      const built = await builtFor(1_536, SERVING, false);
      expect(namesOf(built.tools)).not.toContain('F');
      expect(namesOf(built.tools)).not.toContain('G');
      expect(built.notices.filter((notice) => notice.code === 'tools_dropped').map((notice) => notice.message)).toEqual([
        expect.stringContaining('G (with F)'),
      ]);
    });

    it('stay offered when the declared window leaves no room for the tool they serve and something keeps them', async () => {
      const built = await builtFor(1_536, SERVING, true);
      expect(namesOf(built.tools)).not.toContain('F');
      expect(namesOf(built.tools)).toContain('G');
    });

    it('follow the tool they serve by the fit rank, not by the order the candidates come in', async () => {
      const capabilities = capabilitiesFor(1_536, { maxOutputTokens: 1024 });
      const { ports } = harness(capabilities);
      const companionFirst = [ranked(toolNamed('G', 1), 6), ...TOOLS.map((tool, index) => ranked(tool, index))];
      const built = await buildContext(
        inputFor(capabilities, { sources: sourcesWith({ tools: companionFirst }), companions: { hostOf: { G: 'A' }, keepWithoutHost: false } }),
        ports,
      );
      expect(namesOf(built.tools)).toContain('A');
      expect(namesOf(built.tools)).toContain('G');
    });

    it('keep the order the candidates came in when all fit, because the offered order is the cached prefix', async () => {
      const capabilities = capabilitiesFor(128_000, { maxOutputTokens: 1024 });
      const { ports } = harness(capabilities);
      const companionFirst = [ranked(toolNamed('G', 1), 6), ...TOOLS.map((tool, index) => ranked(tool, index))];
      const built = await buildContext(
        inputFor(capabilities, { sources: sourcesWith({ tools: companionFirst }), companions: { hostOf: { G: 'A' }, keepWithoutHost: false } }),
        ports,
      );
      const offered = namesOf(built.tools);
      expect(offered).toEqual(namesOf(companionFirst).filter((name) => offered.includes(name)));
      expect(offered[0]).toBe('G');
    });

    it('are dropped with a host that comes later in the candidates when the floor drops that host', async () => {
      const capabilities = capabilitiesFor(1_536, { maxOutputTokens: 1024 });
      const { ports } = harness(capabilities);
      const built = await buildContext(
        inputFor(capabilities, { sources: sourcesWith({ tools: [ranked(toolNamed('G', 1), 6), ...TOOLS.map((tool, index) => ranked(tool, index))] }), companions: { hostOf: { G: 'F' }, keepWithoutHost: false } }),
        ports,
      );
      expect(namesOf(built.tools)).not.toContain('F');
      expect(namesOf(built.tools)).not.toContain('G');
    });
  });

  it('leave a task that does not fit to the overflow path instead of dropping tools to make room for it', async () => {
    const capabilities = capabilitiesFor(8_000, { maxOutputTokens: 1024 });
    const { ports } = harness(capabilities);
    const task = { type: 'message' as const, role: 'user' as const, content: 'long task '.repeat(6_000) };
    const attempt = buildContext(inputFor(capabilities, { sources: sourcesWith({ tools: TOOLS, task }) }), ports);
    await expect(attempt).rejects.toBeInstanceOf(PinnedOverflowError);
  });
});
