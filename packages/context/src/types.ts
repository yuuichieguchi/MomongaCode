import type {
  Capabilities,
  CompactionInputItem,
  CountTokensRequest,
  CountTokensResult,
  FunctionTool,
  InputItem,
  MessageInputItem,
} from '@momonga/protocol';

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer E)[]
    ? readonly DeepReadonly<E>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type HistoryItem = {
  seq: number;
  item: DeepReadonly<InputItem>;
  handle?: string;
};

export type ActivatedSkill = { name: string; content: string };

export type ContextSummary = { item: DeepReadonly<CompactionInputItem | MessageInputItem>; replacedThroughSeq: number };

export type ContextSources = {
  systemPrompt: string;
  tools: readonly FunctionTool[];
  task: DeepReadonly<MessageInputItem>;
  activatedSkills: readonly ActivatedSkill[];
  history: readonly HistoryItem[];
  summary?: ContextSummary;
};

export type TokenCounter = {
  count(request: CountTokensRequest): Promise<CountTokensResult>;
};

export type BlobPort = {
  put(text: string, options: { mediaType: string }): Promise<{ handle: string }>;
};

export type InstructionReader = {
  read(path: string): Promise<{ realPath: string; text: string } | undefined>;
  exists(path: string): Promise<boolean>;
  realpath(path: string): Promise<string | undefined>;
};

export type TouchedPath = { path: string; kind: 'file' | 'directory' };

export type MeterRequest = {
  input: readonly InputItem[];
  tools: readonly FunctionTool[];
  instructions?: string;
};

export type MeterCount = {
  inputTokens: number;
  inputDigest: string;
  errorBound: number;
};

export type UsageObservation = {
  inputDigest: string;
  inputTokens: number;
};

export type TokenMeter = {
  count(request: MeterRequest): Promise<MeterCount>;
  countItem(item: InputItem): Promise<number>;
  observe(observation: UsageObservation): void;
  relativeError(): number;
};

export type TokenMeterOptions = {
  counter: TokenCounter;
  model: string;
  capabilities: Capabilities;
};

export type BuildContextPorts = {
  meter: TokenMeter;
  blobs: BlobPort;
  instructions: InstructionReader;
};

export type BuildContextInput = {
  capabilities: Capabilities;
  model: string;
  sources: ContextSources;
  evicted: ReadonlySet<string>;
  touchedPaths: readonly TouchedPath[];
  trusted: boolean;
  projectRoot: string;
  home: string;
  expectedPinnedDigest?: string;
  keepRecentTurns?: number;
  compactAt?: number;
};

export type InstructionScope = 'user' | 'root' | 'nested';

export type LoadedInstruction = {
  path: string;
  realPath: string;
  scope: InstructionScope;
  truncated: boolean;
  text: string;
  textSha256: string;
};

export type NoticeCode =
  | 'root_instructions_untrusted'
  | 'instructions_outside_project'
  | 'nested_instructions_untrusted'
  | 'instructions_dropped'
  | 'recent_turns_shrunk';

export type ContextNotice = { code: NoticeCode; message: string };

export type EvictionKind = 'omitted' | 'truncated';

export type ContextEviction = { callId: string; handle: string; kind: EvictionKind };

export type ContextBudget = { W: number; R: number; I: number; margin: number };

export type BuiltContext = {
  input: InputItem[];
  tools: FunctionTool[];
  maxOutputTokens: number;
  inputTokens: number;
  budget: ContextBudget;
  prefixDigest: string;
  pinnedDigest: string;
  inputDigest: string;
  evictions: ContextEviction[];
  needsCompaction: boolean;
  compactThroughSeq?: number;
  notices: ContextNotice[];
  loadedInstructions: LoadedInstruction[];
};
