import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { FunctionTool } from '@momonga/protocol';
import { extendToolSet } from '@momonga/tools';
import type { ToolSet } from '@momonga/tools';
import { makeTool, toolSetOf } from '../packages/tools/test/harness.ts';
import { capabilitiesFor, harness, inputFor, sourcesWith } from '../packages/context/test/helpers.ts';
import { LOAD_TOOLS_TOOL_NAME, offerFor } from '../packages/runtime/src/worker/tool-offer.ts';

const LONG = 'x'.repeat(800);

const deferringSet = async (): Promise<ToolSet> =>
  extendToolSet(
    await toolSetOf(
      makeTool('Gamma', { tier: 'optional', description: LONG }),
      makeTool('Delta', { tier: 'optional', description: LONG }),
      makeTool('Read', { tier: 'essential', description: LONG }),
      makeTool('Beta', { tier: 'optional', description: LONG }),
      makeTool('Alpha', { tier: 'optional', description: LONG }),
    ),
    makeTool(LOAD_TOOLS_TOOL_NAME, { tier: 'essential' }),
  );

const offerOf = (set: ToolSet, deferred: readonly string[] | undefined, loaded: readonly string[]): FunctionTool[] =>
  offerFor({ toolSet: set, visible: set.forModel({ mode: 'default', rules: [] }), deferred, loaded, keepCompanionsWithoutHost: false, required: new Set<string>() }).tools;

const keptAt = async (offered: readonly FunctionTool[], contextWindow: number) => {
  const capabilities = capabilitiesFor(contextWindow, { maxOutputTokens: 1024 });
  const { ports } = harness(capabilities);
  const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ tools: offered }) }), ports);
  return built.tools.map((tool) => tool.name);
};

const windowKeeping = async (offered: readonly FunctionTool[], wanted: readonly string[]): Promise<number> => {
  for (let window = 1_024; window <= 16_384; window += 8) {
    const kept = await keptAt(offered, window).catch(() => undefined);
    if (kept !== undefined && kept.length === wanted.length && wanted.every((name) => kept.includes(name))) return window;
  }
  throw new Error(`no window up to 16384 keeps exactly ${wanted.join(', ')}`);
};

const withoutLoader = (names: readonly string[]): string[] => names.filter((name) => name !== LOAD_TOOLS_TOOL_NAME);

describe('decision 52: the order of the tools shown to the model', () => {
  it('shows the first list in comparator order when everything fits', async () => {
    const set = await deferringSet();
    expect(await keptAt(offerOf(set, undefined, []), 128_000)).toEqual([LOAD_TOOLS_TOOL_NAME, 'Read', 'Alpha', 'Beta', 'Delta', 'Gamma']);
  });

  it('shows the first list in comparator order when tools are dropped, leaving out the tools last in that order', async () => {
    const set = await deferringSet();
    const offered = offerOf(set, undefined, []);
    const window = await windowKeeping(offered, [LOAD_TOOLS_TOOL_NAME, 'Read', 'Alpha', 'Beta']);
    expect(await keptAt(offered, window)).toEqual([LOAD_TOOLS_TOOL_NAME, 'Read', 'Alpha', 'Beta']);
  });

  it('appends loaded tools at the end in load order, and a tool loaded earlier keeps its position on later turns', async () => {
    const set = await deferringSet();
    const firstTurn = withoutLoader(await keptAt(offerOf(set, ['Alpha', 'Beta'], []), 128_000));
    const secondTurn = withoutLoader(await keptAt(offerOf(set, ['Alpha', 'Beta'], ['Beta']), 128_000));
    const thirdTurn = withoutLoader(await keptAt(offerOf(set, ['Alpha', 'Beta'], ['Beta', 'Alpha']), 128_000));
    expect(firstTurn).toEqual(['Read', 'Delta', 'Gamma']);
    expect(secondTurn).toEqual(['Read', 'Delta', 'Gamma', 'Beta']);
    expect(thirdTurn).toEqual(['Read', 'Delta', 'Gamma', 'Beta', 'Alpha']);
  });

  it('shows the first list under deferral, the loader included, in comparator order', async () => {
    const set = await deferringSet();
    expect(await keptAt(offerOf(set, ['Alpha', 'Beta'], []), 128_000)).toEqual([LOAD_TOOLS_TOOL_NAME, 'Read', 'Delta', 'Gamma']);
  });

  it('shows the first list under deferral, the loader included, in comparator order when a tool is dropped', async () => {
    const set = await deferringSet();
    const offered = offerOf(set, ['Alpha', 'Beta'], []);
    const window = await windowKeeping(offered, [LOAD_TOOLS_TOOL_NAME, 'Read', 'Delta']);
    expect(await keptAt(offered, window)).toEqual([LOAD_TOOLS_TOOL_NAME, 'Read', 'Delta']);
  });

  it('appends loaded definitions after the whole first list, the loader included, in load order', async () => {
    const set = await deferringSet();
    expect(await keptAt(offerOf(set, ['Alpha', 'Beta'], ['Beta', 'Alpha']), 128_000)).toEqual([LOAD_TOOLS_TOOL_NAME, 'Read', 'Delta', 'Gamma', 'Beta', 'Alpha']);
  });

  it('keeps the whole offered order, the loader included, when a drop happens with loaded tools', async () => {
    const set = await deferringSet();
    const offered = offerOf(set, ['Alpha', 'Beta'], ['Beta', 'Alpha']);
    const window = await windowKeeping(offered, [LOAD_TOOLS_TOOL_NAME, 'Read', 'Alpha', 'Beta', 'Delta']);
    expect(await keptAt(offered, window)).toEqual([LOAD_TOOLS_TOOL_NAME, 'Read', 'Delta', 'Beta', 'Alpha']);
  });

  it('drops the tools last in comparator order when loaded tools are offered', async () => {
    const set = await deferringSet();
    const offered = offerOf(set, ['Alpha', 'Beta'], ['Beta', 'Alpha']);
    const window = await windowKeeping(offered, [LOAD_TOOLS_TOOL_NAME, 'Read', 'Alpha', 'Beta', 'Delta']);
    expect(new Set(await keptAt(offered, window))).toEqual(new Set([LOAD_TOOLS_TOOL_NAME, 'Read', 'Alpha', 'Beta', 'Delta']));
  });

  it('keeps the offered order of the remaining tools when a drop happens with loaded tools', async () => {
    const set = await deferringSet();
    const offered = offerOf(set, ['Alpha', 'Beta'], ['Beta', 'Alpha']);
    const window = await windowKeeping(offered, [LOAD_TOOLS_TOOL_NAME, 'Read', 'Alpha', 'Beta', 'Delta']);
    expect(withoutLoader(await keptAt(offered, window))).toEqual(['Read', 'Delta', 'Beta', 'Alpha']);
  });
});
