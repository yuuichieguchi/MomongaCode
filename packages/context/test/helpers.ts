import { canonicalJson } from '@momonga/foundation';
import type {
  Capabilities,
  ContentPart,
  CountTokensRequest,
  CountTokensResult,
  FunctionTool,
  InputItem,
  MessageInputItem,
} from '@momonga/protocol';
import {
  createTokenMeter,
  type BlobPort,
  type BuildContextInput,
  type BuildContextPorts,
  type DeepReadonly,
  type ContextSources,
  type HistoryItem,
  type InstructionReader,
  type TokenCounter,
  type TokenMeter,
  type TouchedPath,
} from '@momonga/context';

export const MODEL = 'test-model';
export const HOME = '/home/u';
export const PROJECT = '/proj';
export const USER_AGENTS = '/home/u/.momonga/AGENTS.md';
export const ROOT_AGENTS = '/proj/AGENTS.md';

export const capabilitiesFor = (
  contextWindow: number,
  overrides: Partial<Capabilities> = {},
): Capabilities => ({
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
  ...overrides,
});

export const tokensOfText = (text: string): number => Math.ceil(text.length / 4);

export const tokensOfItem = (item: DeepReadonly<InputItem>): number => tokensOfText(canonicalJson(item));

export const tokensOfItems = (items: readonly DeepReadonly<InputItem>[]): number =>
  items.reduce((sum, item) => sum + tokensOfItem(item), 0);

export const tokensOfTool = (tool: FunctionTool): number => tokensOfText(canonicalJson(tool));

export const tokensOfTools = (tools: readonly FunctionTool[]): number =>
  tools.reduce((sum, tool) => sum + tokensOfTool(tool), 0);

export type FakeCounter = TokenCounter & { calls: CountTokensRequest[] };

export const fakeCounter = (errorBound = 0, method: CountTokensResult['method'] = 'exact'): FakeCounter => {
  const calls: CountTokensRequest[] = [];
  return {
    calls,
    count: async (request) => {
      calls.push(request);
      const instructionTokens =
        request.instructions === undefined || request.instructions === null ? 0 : tokensOfText(request.instructions);
      const inputTokens =
        typeof request.input === 'string' ? tokensOfText(request.input) : tokensOfItems(request.input);
      const toolTokens = (request.tools ?? []).reduce((sum, tool) => sum + tokensOfTool(tool), 0);
      return { input_tokens: instructionTokens + toolTokens + inputTokens, method, error_bound: errorBound };
    },
  };
};

export type FakeBlobs = BlobPort & { puts: Array<{ text: string; mediaType: string }> };

export const fakeBlobs = (): FakeBlobs => {
  const puts: Array<{ text: string; mediaType: string }> = [];
  return {
    puts,
    put: async (text, options) => {
      puts.push({ text, mediaType: options.mediaType });
      return { handle: `blob-${puts.length}` };
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

export const call = (seq: number, callId: string): HistoryItem => ({
  seq,
  item: { type: 'function_call', id: `h${seq}`, call_id: callId, name: 'Read', arguments: '{}' },
});

export const output = (seq: number, callId: string, text: string, handle?: string): HistoryItem => ({
  seq,
  item: { type: 'function_call_output', id: `h${seq}`, call_id: callId, output: text },
  ...(handle === undefined ? {} : { handle }),
});

export const SYSTEM_PROMPT = 'You are MomongaCode.';
export const TASK: MessageInputItem = { type: 'message', role: 'user', content: 'Do the task.' };

export const sourcesWith = (overrides: Partial<ContextSources> = {}): ContextSources => ({
  systemPrompt: SYSTEM_PROMPT,
  tools: [],
  task: TASK,
  activatedSkills: [],
  history: [],
  ...overrides,
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
  options: { files?: Parameters<typeof fakeReader>[0]; counterErrorBound?: number } = {},
): Harness => {
  const counter = fakeCounter(options.counterErrorBound ?? 0);
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
  model: MODEL,
  sources: sourcesWith(),
  evicted: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
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
