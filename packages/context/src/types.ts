import type {
  Capabilities,
  CompactionInputItem,
  CountTokensRequest,
  CountTokensResult,
  FunctionTool,
  GoverningFactView,
  InputItem,
  MemoryView,
  MessageInputItem,
  TokenAnatomy,
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

export type ContextGoverning = {
  active: readonly DeepReadonly<GoverningFactView>[];
  conflicts: readonly { target: string; ids: readonly string[] }[];
};

export type ContextSources = {
  systemPrompt: string;
  tools: readonly FunctionTool[];
  task: DeepReadonly<MessageInputItem>;
  taskSeq: number;
  skillCatalog?: string;
  activatedSkills: readonly ActivatedSkill[];
  governing?: ContextGoverning;
  memories?: readonly DeepReadonly<MemoryView>[];
  history: readonly HistoryItem[];
  summary?: ContextSummary;
  workingState?: string;
  projectedWorkingState?: string;
};

export type TokenCounter = {
  count(request: CountTokensRequest): Promise<CountTokensResult>;
};

export type BlobPort = {
  handleFor(content: string): string;
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

export type ItemCountContext = { callNames: Readonly<Record<string, string>>; withTools: boolean };

export type TokenMeter = {
  count(request: MeterRequest): Promise<MeterCount>;
  countItem(item: InputItem, context: ItemCountContext): Promise<number>;
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
  keepRecentSteps?: number;
  level?: number;
  itemCap?: number;
  memoryShare?: number;
  pinnedTokens?: number;
  compactAt?: number;
  tools?: 'none';
  trailing?: readonly InputItem[];
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
  | 'governing_conflict'
  | 'memories_dropped'
  | 'tools_dropped'
  | 'recent_turns_shrunk'
  | 'recent_steps_shrunk';

export type ContextNotice = { code: NoticeCode; message: string };

export type EvictionKind = 'omitted' | 'truncated';

export type ContextEviction = { callId: string; handle: string; kind: EvictionKind };

export type ContextBudget = { W: number; R: number; I: number; margin: number };

export type ProtectionLevel = { keepTurns: number; keepSteps: number };

export type PinnedBreakdown = { systemPrompt: number; tools: number; instructions: number; governing: number; task: number };

export type CompactionPlan = { throughSeq: number; input: InputItem[]; summaryTokenCap: number; pinnedText: string };

export type CompactionBlockReason =
  | 'no_step_boundary_outside_protection'
  | 'protected_step_exceeds_room'
  | 'deficit_not_closed'
  | 'region_exceeds_summary_input_budget';

export type CompactionBlock = { reason: CompactionBlockReason; message: string };

export type PinnedMeasure = { pinnedTokens: number; ceiling: number; room: number; itemCap: number; summaryCap: number };

export type BuiltContext = {
  input: InputItem[];
  tools: FunctionTool[];
  maxOutputTokens: number;
  inputTokens: number;
  anatomy: TokenAnatomy;
  budget: ContextBudget;
  prefixDigest: string;
  pinnedDigest: string;
  inputDigest: string;
  evictions: ContextEviction[];
  compaction?: CompactionPlan;
  notices: ContextNotice[];
  loadedInstructions: LoadedInstruction[];
  loadedMemoryIds: string[];
  loadedGoverning: LoadedGoverning;
};

export type LoadedGoverning = { active: { id: string; textSha256: string }[]; conflicts: { target: string; ids: string[] }[] };
