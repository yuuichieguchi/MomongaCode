import type { FunctionTool, InputItem, TokenAnatomy, TokenAnatomyLayers } from '@momonga/protocol';
import type { ItemCountContext, MeterCount, TokenMeter } from './types.ts';

export const LAYER_NAMES = [
  'system',
  'tools',
  'instructions',
  'skills',
  'governing',
  'memories',
  'summary',
  'workingState',
  'history.user',
  'history.assistant',
  'history.toolCalls',
  'history.toolOutputs',
  'notices',
] as const;

export type LayerName = (typeof LAYER_NAMES)[number];

export type TaggedItem = { item: InputItem; layer: Exclude<LayerName, 'tools'> };

export const historyLayerOf = (item: InputItem): Exclude<LayerName, 'tools'> => {
  switch (item.type) {
    case 'function_call':
      return 'history.toolCalls';
    case 'function_call_output':
      return 'history.toolOutputs';
    case 'reasoning':
    case 'compaction':
      return 'history.assistant';
    case 'message':
      if (item.role === 'user') return 'history.user';
      if (item.role === 'assistant') return 'history.assistant';
      return 'notices';
  }
};

const bodyOf = (counted: number, framing: number): number => Math.max(0, counted - framing);

const scaledDown = (values: readonly number[], target: number): number[] => {
  const sum = values.reduce((total, value) => total + value, 0);
  const exact = values.map((value) => (value * target) / sum);
  const floors = exact.map((value) => Math.floor(value));
  const missing = target - floors.reduce((total, value) => total + value, 0);
  const remainders = exact.map((value, index) => value - (floors[index] as number));
  const byRemainder = exact
    .map((_, index) => index)
    .toSorted((left, right) => (remainders[right] as number) - (remainders[left] as number) || left - right);
  for (const index of byRemainder.slice(0, missing)) floors[index] = (floors[index] as number) + 1;
  return floors;
};

export const anatomyOf = async (
  meter: TokenMeter,
  tools: readonly FunctionTool[],
  tagged: readonly TaggedItem[],
  total: MeterCount,
  contextOf: (item: InputItem) => ItemCountContext,
): Promise<TokenAnatomy> => {
  const [empty, toolCounts, itemCounts] = await Promise.all([
    meter.count({ input: [], tools: [] }).then((counted) => counted.inputTokens),
    Promise.all(tools.map((tool) => meter.count({ input: [], tools: [tool] }).then((counted) => counted.inputTokens))),
    Promise.all(tagged.map(({ item }) => meter.countItem(item, contextOf(item)))),
  ]);
  const units: { layer: LayerName; tool?: string; tokens: number }[] = [
    ...tools.map((tool, index) => ({ layer: 'tools' as const, tool: tool.name, tokens: bodyOf(toolCounts[index] as number, empty) })),
    ...tagged.map(({ layer }, index) => ({ layer, tokens: itemCounts[index] as number })),
  ];
  const isolated = units.reduce((sum, unit) => sum + unit.tokens, 0);
  const overshoot = isolated > total.inputTokens;
  const emptyShare = Math.min(empty, total.inputTokens);
  const scaled = overshoot ? scaledDown(units.map((unit) => unit.tokens), total.inputTokens - emptyShare) : units.map((unit) => unit.tokens);
  const framing = overshoot ? emptyShare : total.inputTokens - isolated;
  const tokens = new Map<LayerName, number>(LAYER_NAMES.map((name) => [name, 0]));
  const toolTokens: Record<string, number> = {};
  for (const [index, unit] of units.entries()) {
    const value = scaled[index] as number;
    tokens.set(unit.layer, (tokens.get(unit.layer) as number) + value);
    if (unit.tool !== undefined) toolTokens[unit.tool] = value;
  }
  const layer = (name: LayerName): number => tokens.get(name) as number;
  const layers: TokenAnatomyLayers = {
    system: layer('system'),
    tools: layer('tools'),
    instructions: layer('instructions'),
    skills: layer('skills'),
    governing: layer('governing'),
    memories: layer('memories'),
    summary: layer('summary'),
    workingState: layer('workingState'),
    history: {
      user: layer('history.user'),
      assistant: layer('history.assistant'),
      toolCalls: layer('history.toolCalls'),
      toolOutputs: layer('history.toolOutputs'),
    },
    notices: layer('notices'),
    ...(framing === 0 ? {} : { framing }),
  };
  return { estimated: true, total: total.inputTokens, layers, tools: toolTokens };
};
