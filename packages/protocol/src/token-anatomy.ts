export const ANATOMY_FLAT_LAYERS = ['system', 'tools', 'instructions', 'skills', 'governing', 'memories', 'summary', 'workingState'] as const;

export const ANATOMY_HISTORY_LAYERS = ['user', 'assistant', 'toolCalls', 'toolOutputs'] as const;

export type TokenAnatomyLayers = {
  system: number;
  tools: number;
  instructions: number;
  skills: number;
  governing: number;
  memories: number;
  summary: number;
  workingState: number;
  history: { user: number; assistant: number; toolCalls: number; toolOutputs: number };
  notices: number;
  framing?: number;
};

export type TokenAnatomy = {
  estimated: true;
  total: number;
  layers: TokenAnatomyLayers;
  tools: Record<string, number>;
};

export const anatomyLayerEntries = (layers: TokenAnatomyLayers): [string, number][] => [
  ...ANATOMY_FLAT_LAYERS.map((name): [string, number] => [name, layers[name]]),
  ...ANATOMY_HISTORY_LAYERS.map((name): [string, number] => [`history.${name}`, layers.history[name]]),
  ['notices', layers.notices],
  ...(layers.framing === undefined ? [] : [['framing', layers.framing] as [string, number]]),
];

export type ModelCost = { amount: number; currency: 'USD'; priceVersion: string };

export type CallTiming = { firstEventMs?: number; durationMs: number };

export type BilledTokensView = {
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export type TimingSummaryView = { median: number; p95: number; n: number };

export type UnpricedCallView = { runId: string; provider: string; model: string; step?: number; reason: string };

export type CostBreakdownView = {
  calls: number;
  layers: { estimated: true; shares: Record<string, number>; tokens: Record<string, number>; callsWithoutAnatomy: number };
  billed: BilledTokensView;
  cacheHitRatio: number | null;
  timeToFirstToken: TimingSummaryView | null;
  duration: TimingSummaryView | null;
  cost: { amount: number | null; currency: 'USD'; unpricedCalls: number };
  unpriced: UnpricedCallView[];
};

export type BreakdownCallInput = {
  runId: string;
  step: number;
  anatomy?: TokenAnatomy;
  timing?: CallTiming;
};
