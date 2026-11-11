import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { applyCapabilityOverride, errorBoundOfShape } from '@momonga/protocol';
import type {
  Capabilities,
  CapabilityOverride,
  ContentPart,
  CountTokensRequest,
  CountTokensResult,
  ErrorShape,
  FunctionTool,
  InputItem,
  MessageInputItem,
} from '@momonga/protocol';
import {
  ContextOverflowError,
  buildContext,
  createTokenMeter,
  type BlobPort,
  type BuildContextInput,
  type BuildContextPorts,
  type BuiltContext,
  type DeepReadonly,
  type ContextSources,
  type HistoryItem,
  type InstructionReader,
  type TokenCounter,
  type TokenMeter,
  type TouchedPath,
} from '@momonga/context';
import { testPaths } from '@momonga/testkit';
import { TEST_FENCE } from '@momonga/testkit';

export const MODEL = 'test-model';
export const HOME = '/home/u';
export const PROJECT = '/proj';
export const USER_AGENTS = '/home/u/.momonga/AGENTS.md';
export const ROOT_AGENTS = '/proj/AGENTS.md';

export const capabilitiesFor = (contextWindow: number, overrides: CapabilityOverride = {}): Capabilities =>
  applyCapabilityOverride(
    {
      contextWindow,
      maxOutputTokens: 4096,
      toolCalling: 'native',
      structuredOutput: 'none',
      streaming: true,
      stopSequences: false,
      imageInput: false,
      parallelToolCalls: false,
      schemaDialect: 'json-schema-2020-12',
      tokenCounting: 'exact',
      usageReported: true,
      maxConcurrency: 1,
      source: 'declared',
    },
    overrides,
  );

export const tokensOfText = (text: string): number => Math.ceil(text.length / 4);

const tokensOfFrozenItems = new WeakMap<object, number>();

export const tokensOfItem = (item: DeepReadonly<InputItem>): number => {
  const known = tokensOfFrozenItems.get(item);
  if (known !== undefined) return known;
  const tokens = tokensOfText(canonicalJson(item));
  if (Object.isFrozen(item)) tokensOfFrozenItems.set(item, tokens);
  return tokens;
};

export const tokensOfItems = (items: readonly DeepReadonly<InputItem>[]): number =>
  items.reduce((sum, item) => sum + tokensOfItem(item), 0);

export const tokensOfTool = (tool: FunctionTool): number => tokensOfText(canonicalJson(tool));

export const tokensOfTools = (tools: readonly FunctionTool[]): number =>
  tools.reduce((sum, tool) => sum + tokensOfTool(tool), 0);

export type FakeCounter = TokenCounter & { calls: CountTokensRequest[] };

const requestTokens = (request: CountTokensRequest): number => {
  const instructionTokens =
    request.instructions === undefined || request.instructions === null ? 0 : tokensOfText(request.instructions);
  const inputTokens = typeof request.input === 'string' ? tokensOfText(request.input) : tokensOfItems(request.input);
  const toolTokens = (request.tools ?? []).reduce((sum, tool) => sum + tokensOfTool(tool), 0);
  return instructionTokens + toolTokens + inputTokens;
};

export const shapeCounter = (shapeOf: (request: CountTokensRequest) => ErrorShape, method: CountTokensResult['method'] = 'estimated'): FakeCounter => {
  const calls: CountTokensRequest[] = [];
  return {
    calls,
    count: async (request) => {
      calls.push(request);
      const tokens = requestTokens(request);
      const shape = shapeOf(request);
      return { input_tokens: tokens, method, error_bound: errorBoundOfShape(shape, tokens), error_shape: shape };
    },
  };
};

export const fakeCounter = (errorBound = 0, method: CountTokensResult['method'] = 'exact'): FakeCounter =>
  shapeCounter(() => ({ ratio: 0, minimum: errorBound }), method);

export const ratioCounter = (ratio: number): FakeCounter => shapeCounter(() => ({ ratio, minimum: 0 }));

export const handleOf = (text: string): string => sha256Hex(text).slice(0, 6);

export type FakeBlobs = BlobPort & { puts: Array<{ text: string; mediaType: string }> };

export const fakeBlobs = (): FakeBlobs => {
  const puts: Array<{ text: string; mediaType: string }> = [];
  return {
    puts,
    handleFor: handleOf,
    put: async (text, options) => {
      puts.push({ text, mediaType: options.mediaType });
      return { handle: handleOf(text) };
    },
  };
};

export type FakeReader = InstructionReader & { reads: string[]; existsChecks: string[] };

export const fakeReader = (
  files: Record<string, string | { realPath: string; text: string }> = {},
): FakeReader => {
  const reads: string[] = [];
  const existsChecks: string[] = [];
  return {
    reads,
    existsChecks,
    platform: process.platform,
    contains: (directory, candidate) => testPaths().comparableContains(directory, candidate),
    read: async (filePath) => {
      reads.push(filePath);
      const entry = files[filePath];
      if (entry === undefined) return undefined;
      return typeof entry === 'string' ? { realPath: filePath, text: entry } : entry;
    },
    exists: async (filePath) => {
      existsChecks.push(filePath);
      return files[filePath] !== undefined;
    },
    realpath: async (filePath) => {
      const entry = files[filePath];
      return entry === undefined || typeof entry === 'string' ? filePath : entry.realPath;
    },
  };
};

export const touchedFile = (filePath: string): TouchedPath => ({ path: filePath, kind: 'file' });

export const touchedDirectory = (dirPath: string): TouchedPath => ({ path: dirPath, kind: 'directory' });

export const user = (seq: number, text: string): HistoryItem => ({
  seq,
  item: { type: 'message', id: `h${seq}`, role: 'user', content: text },
});

export const assistant = (seq: number, text: string): HistoryItem => ({
  seq,
  item: { type: 'message', id: `h${seq}`, role: 'assistant', content: text },
});

export const RAW_OUTPUT_TOOL = 'Peek';

export const call = (seq: number, callId: string): HistoryItem => ({
  seq,
  item: { type: 'function_call', id: `h${seq}`, call_id: callId, name: RAW_OUTPUT_TOOL, arguments: '{}' },
});

export const output = (seq: number, callId: string, text: string, handle?: string): HistoryItem => ({
  seq,
  item: { type: 'function_call_output', id: `h${seq}`, call_id: callId, output: text },
  ...(handle === undefined ? {} : { handle }),
});

export const argsCall = (seq: number, callId: string, chars: number): HistoryItem => ({
  seq,
  item: { type: 'function_call', id: `h${seq}`, call_id: callId, name: RAW_OUTPUT_TOOL, arguments: `{"p":"${'x'.repeat(chars)}"}` },
});

export const stepsOf = (chars: readonly number[]): HistoryItem[] =>
  chars.flatMap((size, index) => [argsCall(2 * index + 1, `c${index}`, size), output(2 * index + 2, `c${index}`, 'ok')]);

export const SYSTEM_PROMPT = 'You are MomongaCode.';
export const TASK: MessageInputItem = { type: 'message', role: 'user', content: 'Do the task.' };

export const DECLARED_READERS = { output_handle: 'ReadOutput', history_range: 'HistoryRead' } as const;

const rankedByPosition = (tools: readonly FunctionTool[]): FunctionTool[] =>
  tools.some((tool) => 'fitRank' in tool) ? [...tools] : tools.map((tool, index) => ({ ...tool, fitRank: index }));

export const sourcesWith = (overrides: Partial<ContextSources> = {}): ContextSources => ({
  systemPrompt: SYSTEM_PROMPT,
  tools: [],
  task: TASK,
  taskSeq: 0,
  activatedSkills: [],
  history: [],
  readers: DECLARED_READERS,
  ...overrides,
  ...(overrides.tools === undefined ? {} : { tools: rankedByPosition(overrides.tools) }),
});

export const READ_TOOL: FunctionTool = {
  type: 'function',
  name: 'Read',
  description: 'Read a file',
  parameters: { type: 'object', properties: {} },
};

export type Harness = {
  ports: BuildContextPorts;
  counter: FakeCounter;
  blobs: FakeBlobs;
  reader: FakeReader;
  meter: TokenMeter;
};

export const harness = (
  capabilities: Capabilities,
  options: { files?: Parameters<typeof fakeReader>[0]; counterErrorBound?: number; counter?: FakeCounter } = {},
): Harness => {
  const counter = options.counter ?? fakeCounter(options.counterErrorBound ?? 0);
  const blobs = fakeBlobs();
  const reader = fakeReader(options.files ?? {});
  const meter = createTokenMeter({ counter, model: MODEL, capabilities });
  return { ports: { meter, blobs, instructions: reader }, counter, blobs, reader, meter };
};

export const inputFor = (
  capabilities: Capabilities,
  overrides: Partial<BuildContextInput> = {},
): BuildContextInput => ({
  capabilities,
  fence: TEST_FENCE,
  model: MODEL,
  sources: sourcesWith(),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  harnessOutputTools: [RAW_OUTPUT_TOOL],
  ...overrides,
});

export const textOf = (content: string | ContentPart[]): string =>
  typeof content === 'string'
    ? content
    : content.map((part) => ('text' in part ? part.text : '')).join('');

export const outputTextOf = (items: readonly InputItem[], callId: string): string | undefined => {
  for (const item of items) {
    if (item.type === 'function_call_output' && item.call_id === callId) return textOf(item.output);
  }
  return undefined;
};

export const developerTexts = (items: readonly InputItem[]): string[] =>
  items.flatMap((item) => (item.type === 'message' && item.role === 'developer' ? [textOf(item.content)] : []));

export const idsOf = (items: readonly InputItem[]): Array<string | null | undefined> =>
  items.map((item) => item.id);

export const expectPairsWhole = (items: readonly InputItem[]): boolean => {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const item of items) {
    if (item.type === 'function_call') calls.add(item.call_id);
    if (item.type === 'function_call_output') {
      if (!calls.has(item.call_id)) return false;
      outputs.add(item.call_id);
    }
  }
  for (const id of calls) if (!outputs.has(id)) return false;
  return true;
};

export const omittedMarker = /^\[tool output omitted: (\d+) tokens; stored as (\S+); read it with ReadOutput\]$/;

export const truncatedMarker = /\[… (\d+) tokens omitted; full output stored as (\S+); read it with ReadOutput …\]/;

export const budgetFor = (contextWindow: number, maxOutputTokens = 4096, extraMargin = 0) => {
  const R = Math.min(maxOutputTokens, Math.max(256, Math.ceil(0.25 * contextWindow)), Math.floor(0.5 * contextWindow));
  const margin = Math.max(Math.ceil(0.02 * contextWindow), 32) + extraMargin;
  return { W: contextWindow, R, margin, I: contextWindow - R - margin };
};

export const itemCapFor = (inputBudget: number): number => Math.max(64, Math.floor(0.25 * inputBudget));

export const seeded = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return {
    next,
    int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)),
  };
};

export const overflowOf = async (input: BuildContextInput, ports: BuildContextPorts): Promise<ContextOverflowError> => {
  const error = await buildContext(input, ports).catch((caught: unknown) => caught);
  if (!(error instanceof ContextOverflowError)) throw new Error(`expected ContextOverflowError, received ${String(error)}`);
  return error;
};

export const buildThroughLevels = async (
  input: BuildContextInput,
  ports: BuildContextPorts,
): Promise<{ built: BuiltContext; level: number }> => {
  for (let level = 0; ; level += 1) {
    try {
      return { built: await buildContext({ ...input, level }, ports), level };
    } catch (error) {
      if (!(error instanceof ContextOverflowError) || error.lastLevel !== false || level >= 3) throw error;
    }
  }
};
