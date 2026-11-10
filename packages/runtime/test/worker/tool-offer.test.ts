import { describe, expect, it } from 'vitest';
import type { FunctionTool, PermissionMode } from '@momonga/protocol';
import { createToolRegistry, defineTool, extendToolSet } from '@momonga/tools';
import type { AnyTool, ToolSet } from '@momonga/tools';
import { LOAD_TOOLS_TOOL_NAME, offerFor } from '../../src/worker/tool-offer.ts';

type Spec = { name: string; description: string; sideEffect: 'read_only' | 'write'; tier?: 'essential' | 'common' | 'optional'; companionOf?: string };

const toolOf = (spec: Spec): AnyTool => {
  const body = {
    name: spec.name,
    description: spec.description,
    ...(spec.tier === undefined ? {} : { tier: spec.tier }),
    ...(spec.companionOf === undefined ? {} : { companionOf: spec.companionOf }),
    inputSchema: { type: 'object', properties: { value: { type: 'string', description: `The value that ${spec.name} works on` } }, required: ['value'], additionalProperties: false },
    timeoutMs: 1_000,
    title: () => spec.name,
    execute: async () => ({ status: 'completed' as const, output: spec.name }),
  };
  return spec.sideEffect === 'write'
    ? defineTool<Record<string, unknown>>({
        ...body,
        kind: 'edit',
        sideEffect: 'write',
        subjectKind: 'path',
        subject: (input) => ({ kind: 'path', tool: spec.name, paths: [String(input['value'])], access: 'write' }),
      })
    : defineTool<Record<string, unknown>>({ ...body, kind: 'read', sideEffect: 'read_only', subject: () => ({ kind: 'none', tool: spec.name }) });
};

const ALPHA: Spec = { name: 'Alpha', description: 'Reads the alpha.\nIt also explains the alpha in detail.', sideEffect: 'read_only' };
const BETA: Spec = { name: 'Beta', description: 'Writes the beta.', sideEffect: 'write' };
const GAMMA: Spec = { name: 'Gamma', description: 'Finds the gamma.', sideEffect: 'read_only', tier: 'optional' };
const READ_OUTPUT: Spec = { name: 'ReadOutput', description: 'Reads a stored output.', sideEffect: 'read_only', tier: 'essential' };
const HOST: Spec = { name: 'Host', description: 'Runs a host command.', sideEffect: 'read_only' };
const SIDE: Spec = { name: 'Side', description: 'Reads the output of a host job.', sideEffect: 'read_only', companionOf: 'Host' };

const UNIVERSE = [ALPHA, BETA, GAMMA, READ_OUTPUT];

const toolSetOf = async (specs: readonly Spec[], only?: readonly string[]): Promise<ToolSet> => {
  const registry = createToolRegistry();
  for (const spec of specs) registry.register(toolOf(spec));
  const loader: Spec = { name: LOAD_TOOLS_TOOL_NAME, description: 'Loads tools.', sideEffect: 'read_only', tier: 'essential' };
  return extendToolSet(await registry.snapshot(only === undefined ? {} : { only }), toolOf(loader));
};

const namesOf = (tools: readonly FunctionTool[]): string[] => tools.map((tool) => tool.name);

const withoutLoader = (tools: readonly FunctionTool[]): FunctionTool[] => tools.filter((tool) => tool.name !== LOAD_TOOLS_TOOL_NAME);

const loaderOf = (tools: readonly FunctionTool[]): FunctionTool | undefined => tools.find((tool) => tool.name === LOAD_TOOLS_TOOL_NAME);

const enumOf = (loader: FunctionTool | undefined): unknown => {
  const parameters = loader?.parameters as { properties?: { names?: { type?: string; items?: { enum?: unknown } } }; required?: unknown } | undefined;
  return parameters?.properties?.names?.items?.enum;
};

const subsetsOf = <T,>(items: readonly T[]): T[][] =>
  items.reduce<T[][]>((subsets, item) => subsets.flatMap((subset) => [subset, [...subset, item]]), [[]]);

const sorted = (names: Iterable<string>): string[] => [...names].sort();

describe('the offer without deferral', () => {
  it('is the visible list unchanged when the run pinned no deferred set', async () => {
    const toolSet = await toolSetOf(UNIVERSE);
    const visible = toolSet.forModel({ mode: 'manual', rules: [] });

    const offer = offerFor({ toolSet, visible, deferred: undefined, loaded: [], keepCompanionsWithoutHost: false, required: new Set<string>() });

    expect(offer.tools).toEqual(visible);
    expect(offer.catalog).toEqual([]);
  });

  it('offers no loader when the pinned deferred set is empty', async () => {
    const toolSet = await toolSetOf(UNIVERSE);
    const visible = toolSet.forModel({ mode: 'manual', rules: [] });

    const offer = offerFor({ toolSet, visible, deferred: [], loaded: [], keepCompanionsWithoutHost: false, required: new Set<string>() });

    expect(offer.tools).toEqual(withoutLoader(visible));
    expect(offer.catalog).toEqual([]);
  });
});

describe('the deferred tools and the loader (T3, 5.1 and 5.2)', () => {
  it('withholds the deferred tools and offers LoadTools at its comparator place among the others', async () => {
    const toolSet = await toolSetOf(UNIVERSE);
    const visible = toolSet.forModel({ mode: 'manual', rules: [] });

    const offer = offerFor({ toolSet, visible, deferred: ['Beta', 'Gamma'], loaded: [], keepCompanionsWithoutHost: false, required: new Set<string>() });

    expect(namesOf(offer.tools)).toEqual([LOAD_TOOLS_TOOL_NAME, 'ReadOutput', 'Alpha']);
    expect(offer.catalog).toEqual(['Beta', 'Gamma']);
    expect(offer.tools.filter((tool: FunctionTool) => tool.name !== LOAD_TOOLS_TOOL_NAME)).toEqual(visible.filter((tool) => tool.name === 'ReadOutput' || tool.name === 'Alpha'));
  });

  it('gives LoadTools an array of names whose enum is the catalog', async () => {
    const toolSet = await toolSetOf(UNIVERSE);
    const visible = toolSet.forModel({ mode: 'manual', rules: [] });

    const offer = offerFor({ toolSet, visible, deferred: ['Alpha', 'Beta'], loaded: [], keepCompanionsWithoutHost: false, required: new Set<string>() });
    const loader = loaderOf(offer.tools);

    expect(loader?.type).toBe('function');
    expect(enumOf(loader)).toEqual(['Alpha', 'Beta']);
    expect((loader?.parameters as { required?: unknown }).required).toEqual(['names']);
    expect((loader?.parameters as { properties: { names: { type: string } } }).properties.names.type).toBe('array');
  });

  it('describes each catalog tool on one line, as its name and the first line of its description', async () => {
    const toolSet = await toolSetOf(UNIVERSE);
    const visible = toolSet.forModel({ mode: 'manual', rules: [] });

    const offer = offerFor({ toolSet, visible, deferred: ['Alpha', 'Beta'], loaded: [], keepCompanionsWithoutHost: false, required: new Set<string>() });
    const lines = (loaderOf(offer.tools)?.description ?? '').split('\n');

    expect(lines).toContain('Alpha: Reads the alpha.');
    expect(lines).toContain('Beta: Writes the beta.');
    expect(lines.filter((line) => line.startsWith('Alpha:') || line.startsWith('Beta:') || line.startsWith('Gamma:'))).toHaveLength(2);
    expect(lines.some((line) => line.includes('explains the alpha in detail'))).toBe(false);
  });

  it('appends loaded definitions after the whole first list in load order, keeps the full catalog and the loader', async () => {
    const toolSet = await toolSetOf(UNIVERSE);
    const visible = toolSet.forModel({ mode: 'manual', rules: [] });
    const definitionOf = (name: string) => visible.find((tool) => tool.name === name);

    const offer = offerFor({ toolSet, visible, deferred: ['Beta', 'Gamma'], loaded: ['Gamma', 'Beta'], keepCompanionsWithoutHost: false, required: new Set<string>() });

    expect(namesOf(offer.tools)).toEqual([LOAD_TOOLS_TOOL_NAME, 'ReadOutput', 'Alpha', 'Gamma', 'Beta']);
    expect(offer.tools[3]).toEqual(definitionOf('Gamma'));
    expect(offer.tools[4]).toEqual(definitionOf('Beta'));
    expect(offer.catalog).toEqual(['Beta', 'Gamma']);
    expect(enumOf(loaderOf(offer.tools))).toEqual(['Beta', 'Gamma']);
  });

  it('offers a loaded tool only while the snapshot still holds it (4.6)', async () => {
    const toolSet = await toolSetOf([ALPHA, BETA, READ_OUTPUT]);
    const visible = toolSet.forModel({ mode: 'manual', rules: [] });

    const offer = offerFor({ toolSet, visible, deferred: ['Beta', 'Gamma'], loaded: ['Gamma'], keepCompanionsWithoutHost: false, required: new Set<string>() });

    expect(namesOf(offer.tools)).toEqual([LOAD_TOOLS_TOOL_NAME, 'ReadOutput', 'Alpha']);
    expect(offer.catalog).toEqual(['Beta']);
  });
});

describe('what is never deferred (5.4)', () => {
  it('keeps an essential tool such as ReadOutput offered even when the pin lists it (T3-4)', async () => {
    const toolSet = await toolSetOf(UNIVERSE);
    const visible = toolSet.forModel({ mode: 'manual', rules: [] });

    const offer = offerFor({ toolSet, visible, deferred: ['ReadOutput'], loaded: [], keepCompanionsWithoutHost: false, required: new Set<string>() });

    expect(namesOf(offer.tools)).toEqual(namesOf(withoutLoader(visible)));
    expect(offer.catalog).toEqual([]);
  });

  it('never lists the loader in its own catalog', async () => {
    const toolSet = await toolSetOf(UNIVERSE);
    const visible = toolSet.forModel({ mode: 'manual', rules: [] });

    const offer = offerFor({ toolSet, visible, deferred: [LOAD_TOOLS_TOOL_NAME, 'Gamma'], loaded: [], keepCompanionsWithoutHost: false, required: new Set<string>() });

    expect(offer.catalog).toEqual(['Gamma']);
    expect(namesOf(offer.tools).filter((name) => name === LOAD_TOOLS_TOOL_NAME)).toHaveLength(1);
  });

  it('defers nothing that plan mode hides: Beta is neither offered nor in the catalog', async () => {
    const toolSet = await toolSetOf(UNIVERSE);
    const visible = toolSet.forModel({ mode: 'plan', rules: [] });

    const offer = offerFor({ toolSet, visible, deferred: ['Beta', 'Gamma'], loaded: ['Beta'], keepCompanionsWithoutHost: false, required: new Set<string>() });

    expect(namesOf(offer.tools)).toEqual([LOAD_TOOLS_TOOL_NAME, 'ReadOutput', 'Alpha']);
    expect(offer.catalog).toEqual(['Gamma']);
  });
});

describe('a companion follows its host (5.4)', () => {
  const companionCase = async (deferred: readonly string[], loaded: readonly string[], keepCompanionsWithoutHost: boolean) => {
    const toolSet = await toolSetOf([ALPHA, HOST, SIDE]);
    const visible = toolSet.forModel({ mode: 'manual', rules: [] });
    return offerFor({ toolSet, visible, deferred, loaded, keepCompanionsWithoutHost, required: new Set<string>() });
  };

  it('is withheld with a deferred host and is not in the catalog itself', async () => {
    const offer = await companionCase(['Host'], [], false);

    expect(namesOf(offer.tools)).toEqual([LOAD_TOOLS_TOOL_NAME, 'Alpha']);
    expect(offer.catalog).toEqual(['Host']);
  });

  it('returns with its host when the host is loaded', async () => {
    const offer = await companionCase(['Host'], ['Host'], false);

    expect(sorted(namesOf(offer.tools))).toEqual(sorted(['Alpha', LOAD_TOOLS_TOOL_NAME, 'Host', 'Side']));
  });

  it('stays offered when the pin lists it but not its host', async () => {
    const offer = await companionCase(['Side'], [], false);

    expect(namesOf(offer.tools)).toEqual(['Alpha', 'Host', 'Side']);
    expect(offer.catalog).toEqual([]);
  });

  it('stays offered while a job of the session runs at claim start, even with its host deferred', async () => {
    const offer = await companionCase(['Host', 'Side'], [], true);

    expect(namesOf(offer.tools)).toEqual([LOAD_TOOLS_TOOL_NAME, 'Alpha', 'Side']);
    expect(offer.catalog).toEqual(['Host']);
  });
});

describe('T3-3 for child runs, by exhaustive enumeration', () => {
  const MODES: readonly PermissionMode[] = ['manual', 'plan'];
  const NAMES = UNIVERSE.map((spec) => spec.name);
  const ESSENTIAL = new Set(['ReadOutput']);

  it('offers a subset of the visible tools plus the loader, whose catalog is the parent deferred set within the visible candidates', async () => {
    let cases = 0;
    for (const parentDeferred of subsetsOf(NAMES)) {
      for (const agentTools of [undefined, ...subsetsOf(NAMES).filter((subset) => subset.length > 0)]) {
        const toolSet = await toolSetOf(UNIVERSE, agentTools);
        for (const mode of MODES) {
          const visible = toolSet.forModel({ mode, rules: [] });
          const visibleNames = new Set(namesOf(withoutLoader(visible)));
          const expectedCatalog = sorted(parentDeferred.filter((name) => visibleNames.has(name) && !ESSENTIAL.has(name)));
          for (const loaded of subsetsOf(NAMES)) {
            const offer = offerFor({ toolSet, visible, deferred: sorted(parentDeferred), loaded, keepCompanionsWithoutHost: false, required: new Set<string>() });
            const offered = namesOf(offer.tools);
            const label = JSON.stringify({ parentDeferred, agentTools, mode, loaded });

            expect(sorted(offer.catalog), label).toEqual(expectedCatalog);
            expect(offered.filter((name) => name !== LOAD_TOOLS_TOOL_NAME).every((name) => visibleNames.has(name)), label).toBe(true);
            expect(offered.includes(LOAD_TOOLS_TOOL_NAME), label).toBe(expectedCatalog.length > 0);
            expect(sorted(enumOf(loaderOf(offer.tools)) as string[] | undefined ?? []), label).toEqual(expectedCatalog);
            const expectedOffered = [...visibleNames].filter((name) => !expectedCatalog.includes(name) || loaded.includes(name));
            expect(sorted(offered.filter((name) => name !== LOAD_TOOLS_TOOL_NAME)), label).toEqual(sorted(expectedOffered));
            expect(new Set(offered).size, label).toBe(offered.length);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(16 * 16 * 2 * 16);
  });
});
