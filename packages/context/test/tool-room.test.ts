import { describe, expect, it } from 'vitest';
import { buildContext, inputCeilingFor, MIN_ROOM_TOKENS } from '@momonga/context';
import type { FunctionTool } from '@momonga/protocol';
import { capabilitiesFor, harness, inputFor, sourcesWith, tokensOfTools } from './helpers.ts';

const toolNamed = (name: string, descriptionChars: number): FunctionTool => ({
  type: 'function',
  name,
  description: 'x'.repeat(descriptionChars),
  parameters: { type: 'object', properties: {} },
});

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
});
