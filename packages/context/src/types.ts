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
  NoticeReduction,
  OutputFormatterName,
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
  omittedTokens?: number;
};

export type ActivatedSkill = { name: string; content: string };

export type ContextSummary = { item: DeepReadonly<CompactionInputItem | MessageInputItem>; replacedThroughSeq: number };

export type ContextGoverning = {
  active: readonly DeepReadonly<GoverningFactView>[];
  conflicts: readonly { target: string; ids: readonly string[] }[];
};

export type ReferenceReaders = Readonly<Record<string, string>>;

export type ContextSources = {
  systemPrompt: string;
  tools: readonly FunctionTool[];
  task: DeepReadonly<MessageInputItem>;
  taskSeq: number;
  skillCatalog?: string;
  mandate?: string;
  activatedSkills: readonly ActivatedSkill[];
  governing?: ContextGoverning;
  memories?: readonly DeepReadonly<MemoryView>[];
  moreMemories?: boolean;
  memoryMatchCap?: number;
  history: readonly HistoryItem[];
  summary?: ContextSummary;
  readers: ReferenceReaders;
  workingState?: (readers: ReferenceReaders) => string;
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
  contains(directory: string, candidate: string): Promise<boolean>;
};

export type TouchedPath = { path: string; kind: 'file' | 'directory' };

export type MeterRequest = {
  input: readonly InputItem[];
  tools: readonly FunctionTool[];
  instructions?: string;
  frozen?: readonly InputItem[];
  sent?: true;
};

export type MeterCount = {
  inputTokens: number;
  freshInputTokens: number;
  inputDigest: string;
  known: number;
  uncounted: number;
  overTolerance: number;
  underAt(tokens: number): number;
  freshUnderAt(tokens: number): number;
};

export type UsageObservation = {
  inputDigest: string;
  inputTokens: number;
};

export type MeterObservation = {
  inputDigest: string;
  itemCount: number;
  counted: number;
  reported: number;
  kept: number;
  known: number;
  uncounted: number;
  miss: number;
  contextWindow: number;
  tokenErrorRatio?: number;
  tokenCounting: Capabilities['tokenCounting'];
};

export type MeterMiss = { miss: number; uncounted: number };

export type MeterReport = {
  observation: MeterObservation;
  input: readonly InputItem[];
  tools: readonly FunctionTool[];
};

export type MeterMemory = {
  latest?: MeterReport;
  misses: readonly MeterMiss[];
};

export type ItemCountContext = { callNames: Readonly<Record<string, string>>; withTools: boolean };

export type TokenMeter = {
  count(request: MeterRequest): Promise<MeterCount>;
  countItem(item: InputItem, context: ItemCountContext): Promise<number>;
  observe(observation: UsageObservation): MeterObservation;
  restore(memory: MeterMemory): void;
};

export type TokenMeterOptions = {
  counter: TokenCounter;
  model: string;
  capabilities: Capabilities;
  observedCapacity?: boolean;
};

export type BuildContextPorts = {
  meter: TokenMeter;
  fallbackMeters?: readonly TokenMeter[];
  blobs: BlobPort;
  instructions: InstructionReader;
  compactionTarget?: () => Promise<Capabilities>;
};

export type Calibration = { tokenCounting: Capabilities['tokenCounting']; tokenErrorRatio?: number };

export type ContextArrival =
  | { kind: 'instructions'; path: string; content: string }
  | { kind: 'skill'; name: string; content: string };

export type BuildContextInput = {
  capabilities: Capabilities;
  calibration?: Calibration;
  model: string;
  sources: ContextSources;
  evicted: ReadonlySet<string>;
  recordedReferences: ReadonlySet<string>;
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
  toolsFrozen?: true;
  compactNow?: true;
  compactionFocus?: string;
  compactAt?: number;
  tools?: 'none';
  companions?: { hostOf: Readonly<Record<string, string>>; keepWithoutHost: boolean };
  trailing?: readonly InputItem[];
  layout?: 'cachePrefix';
  pinnedMemoryIds?: readonly string[];
  arrivals?: readonly ContextArrival[];
  observedCapacity?: true;
  forms?: ReadonlyMap<string, number>;
  renderedFull?: ReadonlySet<string>;
  outputFormatters?: readonly OutputFormatterName[] | undefined;
  harnessOutputTools?: readonly string[];
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

export type ContextNotice = { code: NoticeCode; message: string; reduction?: NoticeReduction };

export type EvictionKind = 'omitted' | 'truncated' | 'reference';

export type ContextEviction = { callId: string; handle: string; kind: EvictionKind; keptChars?: number; tokens?: number };

export type ContextBudget = { W: number; R: number; I: number; margin: number };

export type ProtectionLevel = { keepTurns: number; keepSteps: number };

export type PinnedBreakdown = { systemPrompt: number; tools: number; instructions: number; governing: number; task: number };

export type CompactionTokens = { input: number; replaced: number; workingStateGrowth: number; request: number };

export type CompactionPlan = {
  throughSeq: number;
  input: InputItem[];
  summaryTokenCap: number;
  focus?: string;
  pinnedText: string;
  notices: ContextNotice[];
  tokens: CompactionTokens;
  rebuilt: { before: InputItem[]; after: InputItem[]; tools: FunctionTool[] };
};

export type CompactionBlockReason =
  | 'no_step_boundary_outside_protection'
  | 'protected_step_exceeds_room'
  | 'deficit_not_closed'
  | 'region_exceeds_summary_input_budget';

export type CompactionBlock = { reason: CompactionBlockReason; message: string };

export type PinnedMeasure = { pinnedTokens: number; ceiling: number; room: number; itemCap: number; summaryCap: number };

export type ContextZones = {
  stableEnd: number;
  arrivalsStart: number;
  arrivalsEnd: number;
  fixedEnd: number;
  historyEnd: number;
  arrivalKeys: string[];
};

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
  compactionBlockedBy?: CompactionBlock;
  lastLevel: boolean;
  notices: ContextNotice[];
  loadedInstructions: LoadedInstruction[];
  loadedMemoryIds: string[];
  loadedGoverning: LoadedGoverning;
  zones: ContextZones;
  pinnedTokens: number;
};

export type LoadedGoverning = { active: { id: string; textSha256: string }[]; conflicts: { target: string; ids: string[] }[] };
