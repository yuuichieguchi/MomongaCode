import type { ReasoningEffort } from './capabilities.ts';
import type { ConditionState, VerificationOutcome } from './completion.ts';
import type { SummaryFidelity, SummarySource } from './context-record.ts';
import type { MemoryStatus, MemoryView } from './memory.ts';
import { parseCanon } from './model-ref.ts';
import { reportedCachedTokensOf } from './open-responses.ts';
import type { CacheMissCause } from './prefix-events.ts';
import type { PublicRunEvent, PublicStreamEvent } from './run-api.ts';
import type { PermissionMode, RunStatus, SideEffect, StopReason, ToolKind } from './run-types.ts';
import { isOpaqueEvent } from './run-api.ts';
import type { TokenAnatomy } from './token-anatomy.ts';

export const INSPECTOR_TABS = ['overview', 'context', 'memory', 'usage', 'execution'] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

export const INSPECTOR_EVENT_BUFFER_LIMIT = 500;
export const INSPECTOR_REQUEST_BUFFER_LIMIT = 200;
export const INSPECTOR_TOOL_BUFFER_LIMIT = 300;
export const INSPECTOR_MEMORY_LIFECYCLE_LIMIT = 200;
export const INSPECTOR_COMPACTION_BUFFER_LIMIT = 50;

export type InspectorSessionSummary = {
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly provider: string;
  readonly effort?: ReasoningEffort;
  readonly permissionMode: PermissionMode;
  readonly sandbox: string | null;
  readonly contextWindow: number | null;
};

export type InspectorAgentState = {
  readonly runId: string | null;
  readonly status: RunStatus | 'IDLE';
  readonly phase: string;
  readonly step: number;
  readonly attempt: number;
  readonly waitingForModel: boolean;
  readonly waitingForTool: boolean;
  readonly waitingForApproval: boolean;
  readonly waitingForElicitation: boolean;
  readonly retrying: boolean;
  readonly retryCode?: string;
  readonly retryAt?: number;
  readonly stopReason?: StopReason;
  readonly error?: string;
  readonly startedAt?: number;
  readonly updatedAt: number;
};

export const CONTEXT_CATEGORY_KEYS = [
  'system',
  'instructions',
  'skills',
  'governing',
  'tools',
  'memories',
  'summary',
  'workingState',
  'history.user',
  'history.assistant',
  'history.toolCalls',
  'history.toolOutputs',
  'notices',
  'framing',
] as const;

export type ContextCategoryKey = (typeof CONTEXT_CATEGORY_KEYS)[number];

export const CONTEXT_CATEGORY_LABELS: Readonly<Record<ContextCategoryKey, string>> = {
  system: 'System Prompt',
  instructions: 'Instructions',
  skills: 'Skills',
  governing: 'Rules',
  tools: 'Tool Definitions',
  memories: 'Retrieved Memories',
  summary: 'Compaction Summary',
  workingState: 'Working State',
  'history.user': 'User Messages',
  'history.assistant': 'Assistant Messages',
  'history.toolCalls': 'Tool Calls',
  'history.toolOutputs': 'Tool Results',
  notices: 'Notices',
  framing: 'Framing',
};

export type InspectorContextCategory = {
  readonly key: ContextCategoryKey;
  readonly label: string;
  readonly tokens: number;
  readonly share: number;
};

export type InspectorContextItem = {
  readonly id: string;
  readonly category: ContextCategoryKey;
  readonly label: string;
  readonly tokens: number;
  readonly share: number;
  readonly addedAt?: number;
  readonly seq?: number;
  readonly source: string;
  readonly cached: 'prefix' | 'dynamic' | 'unknown';
  readonly preview: string;
  readonly callId?: string;
  readonly handle?: string;
  readonly sizeBytes?: number;
  readonly evicted?: boolean;
  readonly truncated?: boolean;
  readonly excludable: boolean;
};

export type InspectorCompactionEntry = {
  readonly id: string;
  readonly seq: number;
  readonly reason: 'manual' | 'auto' | 'inherited';
  readonly source: SummarySource | 'unknown';
  readonly tokensBefore: number | null;
  readonly tokensAfter: number | null;
  readonly tokensAfterEstimated?: boolean;
  readonly savedTokens: number | null;
  readonly ratio: number | null;
  readonly durationMs: number | null;
  readonly replacedThroughSeq: number;
  readonly summaryPreview: string;
  readonly preservedInfo: readonly string[];
  readonly fidelity?: SummaryFidelity;
  readonly rejected: boolean;
  readonly error?: string;
  readonly createdAt: number;
  readonly costUsd: number | null;
};

export type InspectorContextSuggestion = {
  readonly id: string;
  readonly message: string;
  readonly savingsTokens?: number;
  readonly action?: 'compact' | 'exclude_tool_output';
  readonly callId?: string;
};

export type InspectorContextSnapshot = {
  readonly currentTokens: number | null;
  readonly contextWindow: number | null;
  readonly utilization: number | null;
  readonly anatomy: TokenAnatomy | null;
  readonly categories: readonly InspectorContextCategory[];
  readonly items: readonly InspectorContextItem[];
  readonly compactions: readonly InspectorCompactionEntry[];
  readonly suggestions: readonly InspectorContextSuggestion[];
  readonly evictedCallIds: readonly string[];
  readonly toolDefinitionTokens: Readonly<Record<string, number>>;
};

export type InspectorActiveMemory = {
  readonly id: string;
  readonly kind: string;
  readonly scope: string;
  readonly origin: string;
  readonly state: string;
  readonly status: MemoryStatus;
  readonly summary: string;
  readonly text: string;
  readonly tokens: number;
  readonly createdAt: number;
  readonly keptAt: number;
  readonly contributedAt: number | null;
  readonly evidence: { readonly files: readonly string[]; readonly commit?: string; readonly checks: number };
  readonly adoptionReason: string;
  readonly pinned: boolean;
  readonly excluded: boolean;
};

export type InspectorRetrievalCandidate = {
  readonly id: string;
  readonly summary: string;
  readonly kind: string;
  readonly status: MemoryStatus;
  readonly matched: boolean;
  readonly tier: number;
  readonly rank: number;
  readonly tokens: number;
  readonly decision: 'included' | 'excluded';
  readonly reason: string;
  readonly pinned: boolean;
  readonly sessionExcluded: boolean;
};

export type InspectorMemoryRetrievalTrace = {
  readonly query: string;
  readonly terms: readonly string[];
  readonly executedAt: number;
  readonly latencyMs: number | null;
  readonly budgetTokens: number | null;
  readonly usedTokens: number | null;
  readonly matchCapped: boolean;
  readonly touchedCap: number | null;
  readonly moreAvailable: boolean;
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly candidates: readonly InspectorRetrievalCandidate[];
};

export type InspectorMemoryLifecycleKind =
  | 'recalled'
  | 'injected'
  | 'created'
  | 'updated'
  | 'judged'
  | 'accepted'
  | 'rejected'
  | 'retired'
  | 'restored'
  | 'duplicate'
  | 'superseded'
  | 'contributed'
  | 'session_excluded'
  | 'session_included'
  | 'session_pinned'
  | 'session_unpinned';

export type InspectorMemoryLifecycleEvent = {
  readonly id: string;
  readonly at: number;
  readonly kind: InspectorMemoryLifecycleKind;
  readonly memoryId: string;
  readonly summary: string;
  readonly detail?: string;
};

export type InspectorMemorySnapshot = {
  readonly active: readonly InspectorActiveMemory[];
  readonly retrievalTrace: InspectorMemoryRetrievalTrace | null;
  readonly lifecycle: readonly InspectorMemoryLifecycleEvent[];
  readonly sessionControls: { readonly excludedIds: readonly string[]; readonly pinnedIds: readonly string[] };
  readonly allMemories: readonly MemoryView[];
};

export type InspectorUsageTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
};

export type InspectorModelUsage = {
  readonly model: string;
  readonly provider: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly costUsd: number | null;
  readonly costEstimated: boolean;
  readonly unpricedCalls: number;
};

export type InspectorPurposeUsage = {
  readonly purpose: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
};

export type InspectorRequestStatus = 'running' | 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'rejected';

export type InspectorRequestEntry = {
  readonly id: string;
  readonly runId: string;
  readonly step: number;
  readonly attempt: number;
  readonly purpose: string;
  readonly model: string;
  readonly provider: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly latencyMs: number | null;
  readonly firstEventMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly costUsd: number | null;
  readonly costEstimated: boolean;
  readonly unpricedReason?: string;
  readonly status: InspectorRequestStatus;
  readonly error?: string;
};

export type InspectorUsageSnapshot = {
  readonly totals: InspectorUsageTotals;
  readonly cache: {
    readonly hitRatio: number | null;
    readonly cacheReadNotReportedCalls: number;
    readonly inconsistentUsageCalls: number;
    readonly cacheBreaks: Partial<Record<CacheMissCause, number>>;
    readonly cacheMissCauses: Partial<Record<CacheMissCause, number>>;
    readonly estimatedSavingsUsd: number | null;
    readonly savingsBasis: 'estimated_from_price_table' | 'unavailable';
  };
  readonly cost: {
    readonly totalUsd: number | null;
    readonly isEstimated: boolean;
    readonly unpricedCalls: number;
    readonly unpricedReasons: readonly string[];
    readonly compactionCostUsd: number | null;
    readonly byModel: readonly InspectorModelUsage[];
    readonly byPurpose: readonly InspectorPurposeUsage[];
  };
  readonly requests: readonly InspectorRequestEntry[];
};

export type InspectorToolStatus =
  | 'requested'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'reconciled';

export type InspectorToolExecution = {
  readonly callId: string;
  readonly runId: string;
  readonly step: number;
  readonly name: string;
  readonly title: string;
  readonly kind: ToolKind;
  readonly sideEffect?: SideEffect;
  readonly status: InspectorToolStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly argsSummary: string;
  readonly outputSummary: string;
  readonly outputBytes: number | null;
  readonly truncated: boolean;
  readonly handle?: string;
  readonly error?: string;
  readonly permission: {
    readonly basis?: string;
    readonly decision?: string;
    readonly classifierVerdict?: string;
    readonly classifierConfidence?: string;
    readonly denialSource?: string;
    readonly denialReason?: string;
  };
  readonly sandbox: string | null;
};

export type InspectorConditionState = ConditionState | 'running';

export type InspectorCompletionCondition = {
  readonly id: string;
  readonly command: string;
  readonly when?: string;
  readonly source?: string;
  readonly state: InspectorConditionState;
  readonly rounds: number;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly outputPreview?: string;
  readonly handle?: string;
};

export type InspectorPlanItem = {
  readonly content: string;
  readonly priority: 'high' | 'medium' | 'low';
  readonly status: 'pending' | 'in_progress' | 'completed';
};

export type InspectorExecutionSnapshot = {
  readonly toolCalls: readonly InspectorToolExecution[];
  readonly toolSummary: {
    readonly total: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly running: number;
    readonly awaitingApproval: number;
    readonly denied: number;
  };
  readonly completionConditions: readonly InspectorCompletionCondition[];
  readonly requirements: readonly string[];
  readonly plan: readonly InspectorPlanItem[];
};

export type InspectorDiagnosticSeverity = 'info' | 'warning' | 'critical';

export type InspectorDiagnosticCategory = 'context' | 'tool' | 'compaction' | 'cache' | 'memory' | 'latency' | 'usage';

export type InspectorDiagnostic = {
  readonly id: string;
  readonly severity: InspectorDiagnosticSeverity;
  readonly category: InspectorDiagnosticCategory;
  readonly message: string;
  readonly evidence: string;
  readonly suggestedAction: string;
};

export type InspectorDiagnosticThresholds = {
  readonly contextWarningRatio: number;
  readonly contextCriticalRatio: number;
  readonly largeToolOutputRatio: number;
  readonly frequentCompactionsCount: number;
  readonly repeatedToolCallsCount: number;
  readonly repeatedErrorsCount: number;
  readonly lowCacheHitRatio: number;
  readonly minCacheCallsForDiagnostic: number;
  readonly highMemoryShareRatio: number;
  readonly slowRequestLatencyMs: number;
  readonly tokenSpikeFactor: number;
  readonly minRequestsForSpike: number;
};

export const SLOW_REQUEST_LATENCY_MS = 30_000;

export const DEFAULT_DIAGNOSTIC_THRESHOLDS: InspectorDiagnosticThresholds = {
  contextWarningRatio: 0.75,
  contextCriticalRatio: 0.9,
  largeToolOutputRatio: 0.15,
  frequentCompactionsCount: 3,
  repeatedToolCallsCount: 3,
  repeatedErrorsCount: 2,
  lowCacheHitRatio: 0.3,
  minCacheCallsForDiagnostic: 3,
  highMemoryShareRatio: 0.25,
  slowRequestLatencyMs: SLOW_REQUEST_LATENCY_MS,
  tokenSpikeFactor: 2.5,
  minRequestsForSpike: 3,
};

export type InspectorSnapshotMeta = {
  readonly capturedAt: number;
  readonly eventCount: number;
  readonly droppedEvents: number;
  readonly bufferLimit: number;
  readonly liveConnected: boolean;
};

export type InspectorSnapshot = {
  readonly session: InspectorSessionSummary;
  readonly agent: InspectorAgentState;
  readonly context: InspectorContextSnapshot;
  readonly memory: InspectorMemorySnapshot;
  readonly usage: InspectorUsageSnapshot;
  readonly execution: InspectorExecutionSnapshot;
  readonly diagnostics: readonly InspectorDiagnostic[];
  readonly meta: InspectorSnapshotMeta;
};

export type InspectorContextExcludeRequest = { readonly callId: string; readonly excluded: boolean };
export type InspectorMemoryControlAction = 'exclude' | 'include' | 'pin' | 'unpin';
export type InspectorMemoryControlRequest = { readonly memoryId: string; readonly action: InspectorMemoryControlAction };
export type InspectorMemorySearchRequest = { readonly query: string };
export type InspectorMemorySearchResponse = { readonly trace: InspectorMemoryRetrievalTrace };
export type EditMemoryRequest = { readonly text: string };

const previewSlice = (text: string, maxChars = 160): string => {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= maxChars ? single : `${single.slice(0, maxChars - 1)}…`;
};

const summarizeArgs = (raw: unknown): string => {
  if (raw === undefined) return '';
  if (typeof raw === 'string') return previewSlice(raw, 120);
  try {
    return previewSlice(JSON.stringify(raw), 120);
  } catch {
    return '[unserializable arguments]';
  }
};

const valueForCategory = (anatomy: TokenAnatomy, key: ContextCategoryKey): number => {
  switch (key) {
    case 'system':
      return anatomy.layers.system;
    case 'instructions':
      return anatomy.layers.instructions;
    case 'skills':
      return anatomy.layers.skills;
    case 'governing':
      return anatomy.layers.governing;
    case 'tools':
      return anatomy.layers.tools;
    case 'memories':
      return anatomy.layers.memories;
    case 'summary':
      return anatomy.layers.summary;
    case 'workingState':
      return anatomy.layers.workingState;
    case 'history.user':
      return anatomy.layers.history.user;
    case 'history.assistant':
      return anatomy.layers.history.assistant;
    case 'history.toolCalls':
      return anatomy.layers.history.toolCalls;
    case 'history.toolOutputs':
      return anatomy.layers.history.toolOutputs;
    case 'notices':
      return anatomy.layers.notices;
    case 'framing':
      return anatomy.layers.framing ?? 0;
  }
};

export const buildContextCategories = (anatomy: TokenAnatomy): InspectorContextCategory[] => {
  const total = anatomy.total;
  const raw = CONTEXT_CATEGORY_KEYS.map((key) => ({
    key,
    label: CONTEXT_CATEGORY_LABELS[key],
    tokens: Math.max(0, valueForCategory(anatomy, key)),
  }));
  const sum = raw.reduce((acc, entry) => acc + entry.tokens, 0);
  const delta = total - sum;
  if (delta !== 0 && total > 0) {
    const framingIndex = raw.findIndex((entry) => entry.key === 'framing');
    if (framingIndex >= 0) {
      const current = raw[framingIndex]!;
      raw[framingIndex] = { ...current, tokens: Math.max(0, current.tokens + delta) };
    }
  }
  const denominator = raw.reduce((acc, entry) => acc + entry.tokens, 0);
  return raw.map((entry) => ({
    ...entry,
    share: denominator > 0 ? entry.tokens / denominator : 0,
  }));
};

const medianOf = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1]! + sorted[mid]!) / 2);
};

export const evaluateDiagnostics = (
  snapshot: Pick<InspectorSnapshot, 'context' | 'memory' | 'usage' | 'execution'>,
  overrides: Partial<InspectorDiagnosticThresholds> = {},
): InspectorDiagnostic[] => {
  const t: InspectorDiagnosticThresholds = { ...DEFAULT_DIAGNOSTIC_THRESHOLDS, ...overrides };
  const findings: InspectorDiagnostic[] = [];

  const { utilization, currentTokens, contextWindow, items, compactions, categories } = snapshot.context;
  if (utilization !== null && currentTokens !== null && contextWindow !== null) {
    const pct = (utilization * 100).toFixed(1);
    if (utilization >= t.contextCriticalRatio) {
      findings.push({
        id: 'context-critical',
        severity: 'critical',
        category: 'context',
        message: `Context window critically full (${pct}%)`,
        evidence: `${currentTokens} / ${contextWindow} tokens used`,
        suggestedAction: 'Run manual compaction or exclude large tool outputs in Context Explorer.',
      });
    } else if (utilization >= t.contextWarningRatio) {
      findings.push({
        id: 'context-warning',
        severity: 'warning',
        category: 'context',
        message: `Context window pressure (${pct}%)`,
        evidence: `${currentTokens} / ${contextWindow} tokens used`,
        suggestedAction: 'Review top consumers in Context Inspector or prepare compaction.',
      });
    }
  }

  const toolOutputItems = items.filter((item) => item.category === 'history.toolOutputs' && !item.evicted);
  const totalContext = currentTokens ?? categories.reduce((sum, cat) => sum + cat.tokens, 0);
  if (totalContext > 0) {
    for (const item of toolOutputItems) {
      const share = item.tokens / totalContext;
      if (share >= t.largeToolOutputRatio) {
        findings.push({
          id: `large-tool-output:${item.id}`,
          severity: 'warning',
          category: 'context',
          message: `Large tool output consuming ${(share * 100).toFixed(1)}% of context`,
          evidence: `${item.label}: ${item.tokens} / ${totalContext} tokens`,
          suggestedAction: item.callId !== undefined ? `Exclude tool output ${item.callId} from session context or run compaction.` : 'Run compaction to summarize old tool output.',
        });
      }
    }
  }

  const activeCompactions = compactions.filter((c) => !c.rejected);
  if (activeCompactions.length >= t.frequentCompactionsCount) {
    findings.push({
      id: 'frequent-compactions',
      severity: 'warning',
      category: 'compaction',
      message: `Frequent context compactions (${activeCompactions.length} in session)`,
      evidence: `${activeCompactions.length} compactions recorded`,
      suggestedAction: 'Exclude bulky tool outputs or split work into a fresh session.',
    });
  }

  const calls = snapshot.execution.toolCalls;
  if (calls.length >= t.repeatedToolCallsCount) {
    let streak = 1;
    let lastName = calls[calls.length - 1]!.name;
    let lastArgs = calls[calls.length - 1]!.argsSummary;
    for (let i = calls.length - 2; i >= 0; i -= 1) {
      const entry = calls[i]!;
      if (entry.name === lastName && entry.argsSummary === lastArgs) streak += 1;
      else break;
    }
    if (streak >= t.repeatedToolCallsCount) {
      findings.push({
        id: `repeated-tool:${lastName}`,
        severity: 'warning',
        category: 'tool',
        message: `Repeated identical tool call: ${lastName} (${streak} times)`,
        evidence: `Last ${streak} calls used the same tool and arguments`,
        suggestedAction: 'Inspect Execution tab for loop or missing information, then steer or stop the run.',
      });
    }
  }

  const failedTools = calls.filter((c) => c.status === 'failed' && c.error !== undefined && c.error !== '');
  if (failedTools.length >= t.repeatedErrorsCount) {
    const errorCounts = new Map<string, number>();
    for (const call of failedTools) {
      const key = previewSlice(call.error ?? '', 80);
      errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
    }
    for (const [errorText, count] of errorCounts) {
      if (count >= t.repeatedErrorsCount) {
        findings.push({
          id: `repeated-error:${errorText}`,
          severity: 'warning',
          category: 'tool',
          message: `Repeated error occurred ${count} times`,
          evidence: errorText,
          suggestedAction: 'Check permissions, missing dependencies, or tool inputs in Execution Inspector.',
        });
      }
    }
  }

  const { hitRatio } = snapshot.usage.cache;
  const completedRequests = snapshot.usage.requests.filter((r) => r.status === 'completed' || r.status === 'incomplete');
  const cacheReportedRequests = completedRequests.filter((r) => r.cachedInputTokens !== null);
  if (hitRatio !== null && cacheReportedRequests.length >= t.minCacheCallsForDiagnostic && hitRatio < t.lowCacheHitRatio) {
    findings.push({
      id: 'low-cache-efficiency',
      severity: 'warning',
      category: 'cache',
      message: `Low prompt cache hit ratio (${(hitRatio * 100).toFixed(1)}%)`,
      evidence: `${cacheReportedRequests.length} reported request(s) averaged ${(hitRatio * 100).toFixed(1)}% cache hit`,
      suggestedAction: 'Inspect Cache Analysis for prefix breaks (e.g. changing instructions, tools, or evicted items).',
    });
  }

  const memoryCategory = categories.find((c) => c.key === 'memories');
  if (memoryCategory !== undefined && memoryCategory.share >= t.highMemoryShareRatio && memoryCategory.tokens > 0) {
    findings.push({
      id: 'memory-context-share',
      severity: 'info',
      category: 'memory',
      message: `Memories consume ${(memoryCategory.share * 100).toFixed(1)}% of context`,
      evidence: `${memoryCategory.tokens} tokens across ${snapshot.memory.active.length} active memory note(s)`,
      suggestedAction: 'Exclude unnecessary memories in Memory Inspector for this session.',
    });
  }

  const slowRequests = completedRequests.filter((r) => r.latencyMs !== null && r.latencyMs >= t.slowRequestLatencyMs);
  if (slowRequests.length > 0) {
    const worst = slowRequests.reduce((a, b) => ((b.latencyMs ?? 0) > (a.latencyMs ?? 0) ? b : a));
    findings.push({
      id: 'slow-model-request',
      severity: 'warning',
      category: 'latency',
      message: `Slow model request (${((worst.latencyMs ?? 0) / 1000).toFixed(1)}s)`,
      evidence: `${slowRequests.length} request(s) exceeded ${(t.slowRequestLatencyMs / 1000).toFixed(0)}s (step ${worst.step}, ${worst.model})`,
      suggestedAction: 'Check Request Timeline in Usage Inspector or switch to a faster model.',
    });
  }

  const requestInputs = completedRequests.map((r) => r.inputTokens).filter((v): v is number => v !== null && v > 0);
  if (requestInputs.length >= t.minRequestsForSpike) {
    const latest = requestInputs[requestInputs.length - 1]!;
    const priorMedian = medianOf(requestInputs.slice(0, -1));
    if (priorMedian !== null && priorMedian > 0 && latest >= priorMedian * t.tokenSpikeFactor) {
      findings.push({
        id: 'token-spike',
        severity: 'warning',
        category: 'usage',
        message: `Input token spike (${latest} tokens vs median ${Math.round(priorMedian)})`,
        evidence: `Latest request is ${(latest / priorMedian).toFixed(1)}x the prior median`,
        suggestedAction: 'Inspect Context Explorer to identify newly added large items.',
      });
    }
  }

  return findings;
};

export const emptyInspectorSnapshot = (options: {
  session?: Partial<InspectorSessionSummary>;
  now: number;
  bufferLimit?: number;
}): InspectorSnapshot => {
  const model = options.session?.model ?? '';
  const parsed = model === '' ? undefined : parseCanon(model);
  return {
    session: {
      id: options.session?.id ?? '',
      cwd: options.session?.cwd ?? '',
      model,
      provider: options.session?.provider ?? parsed?.provider ?? 'unknown',
      ...(options.session?.effort === undefined ? {} : { effort: options.session.effort }),
      permissionMode: options.session?.permissionMode ?? 'manual',
      sandbox: options.session?.sandbox ?? null,
      contextWindow: options.session?.contextWindow ?? null,
    },
    agent: {
      runId: null,
      status: 'IDLE',
      phase: 'idle',
      step: 0,
      attempt: 0,
      waitingForModel: false,
      waitingForTool: false,
      waitingForApproval: false,
      waitingForElicitation: false,
      retrying: false,
      updatedAt: options.now,
    },
    context: {
      currentTokens: null,
      contextWindow: options.session?.contextWindow ?? null,
      utilization: null,
      anatomy: null,
      categories: [],
      items: [],
      compactions: [],
      suggestions: [],
      evictedCallIds: [],
      toolDefinitionTokens: {},
    },
    memory: {
      active: [],
      retrievalTrace: null,
      lifecycle: [],
      sessionControls: { excludedIds: [], pinnedIds: [] },
      allMemories: [],
    },
    usage: {
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        uncachedInputTokens: null,
        reasoningTokens: null,
      },
      cache: {
        hitRatio: null,
        cacheReadNotReportedCalls: 0,
        inconsistentUsageCalls: 0,
        cacheBreaks: {},
        cacheMissCauses: {},
        estimatedSavingsUsd: null,
        savingsBasis: 'unavailable',
      },
      cost: {
        totalUsd: null,
        isEstimated: false,
        unpricedCalls: 0,
        unpricedReasons: [],
        compactionCostUsd: null,
        byModel: [],
        byPurpose: [],
      },
      requests: [],
    },
    execution: {
      toolCalls: [],
      toolSummary: { total: 0, succeeded: 0, failed: 0, running: 0, awaitingApproval: 0, denied: 0 },
      completionConditions: [],
      requirements: [],
      plan: [],
    },
    diagnostics: [],
    meta: {
      capturedAt: options.now,
      eventCount: 0,
      droppedEvents: 0,
      bufferLimit: options.bufferLimit ?? INSPECTOR_EVENT_BUFFER_LIMIT,
      liveConnected: true,
    },
  };
};

export type InspectorAccumulatorOptions = {
  readonly redact?: (text: string) => string;
  readonly now: () => number;
  readonly thresholds?: Partial<InspectorDiagnosticThresholds>;
  readonly bufferLimit?: number;
  readonly requestLimit?: number;
  readonly toolLimit?: number;
  readonly lifecycleLimit?: number;
  readonly compactionLimit?: number;
};

export type InspectorAccumulator = {
  snapshot(): InspectorSnapshot;
  version(): number;
  subscribe(listener: () => void): () => void;
  resetForSession(session: Partial<InspectorSessionSummary>): void;
  mergeServerSnapshot(server: InspectorSnapshot): void;
  ingestEvent(event: PublicStreamEvent): void;
  setLiveConnected(connected: boolean): void;
};

const clampPush = <T>(list: T[], item: T, limit: number): T[] => {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
  return list;
};

export const createInspectorAccumulator = (options: InspectorAccumulatorOptions): InspectorAccumulator => {
  const redact = options.redact ?? ((value: string) => value);
  const bufferLimit = options.bufferLimit ?? INSPECTOR_EVENT_BUFFER_LIMIT;
  const requestLimit = options.requestLimit ?? INSPECTOR_REQUEST_BUFFER_LIMIT;
  const toolLimit = options.toolLimit ?? INSPECTOR_TOOL_BUFFER_LIMIT;
  const lifecycleLimit = options.lifecycleLimit ?? INSPECTOR_MEMORY_LIFECYCLE_LIMIT;
  const compactionLimit = options.compactionLimit ?? INSPECTOR_COMPACTION_BUFFER_LIMIT;
  const listeners = new Set<() => void>();
  let state: InspectorSnapshot = emptyInspectorSnapshot({ now: options.now(), bufferLimit });
  let ver = 0;
  const seenEventKeys = new Set<string>();
  const eventKeyRing: string[] = [];

  const notify = (): void => {
    ver += 1;
    for (const listener of [...listeners]) listener();
  };

  const withDiagnostics = (next: InspectorSnapshot): InspectorSnapshot => ({
    ...next,
    diagnostics: evaluateDiagnostics(next, options.thresholds),
  });

  const recordEventSeen = (event: PublicRunEvent): boolean => {
    const key = 'seq' in event && event.seq !== undefined ? `run:${event.runId}:${event.seq}` : `sess:${event.id}:${event.type}:${event.createdAt}`;
    if (seenEventKeys.has(key)) return false;
    seenEventKeys.add(key);
    eventKeyRing.push(key);
    let dropped = 0;
    while (eventKeyRing.length > bufferLimit) {
      const oldest = eventKeyRing.shift();
      if (oldest !== undefined) seenEventKeys.delete(oldest);
      dropped += 1;
    }
    state = {
      ...state,
      meta: {
        ...state.meta,
        eventCount: state.meta.eventCount + 1,
        droppedEvents: state.meta.droppedEvents + dropped,
      },
    };
    return true;
  };

  const recomputeUsage = (requests: readonly InspectorRequestEntry[], prevUsage: InspectorUsageSnapshot): InspectorUsageSnapshot => {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let cachedSum = 0;
    let cachedCount = 0;
    let cacheWriteSum = 0;
    let cacheWriteCount = 0;
    let reasoningSum = 0;
    let reasoningCount = 0;
    let reportedInputForCache = 0;
    let cacheReadForHitRatio = 0;
    let cacheNotReported = 0;
    let inconsistent = 0;
    let costSum = 0;
    let pricedCount = 0;
    let costEstimated = false;
    let unpricedCalls = 0;
    const unpricedReasons = new Set<string>();
    let compactionCost = 0;
    let compactionPriced = false;

    const byModelMap = new Map<string, {
      model: string;
      provider: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cachedSum: number;
      cachedCount: number;
      cacheWriteSum: number;
      cacheWriteCount: number;
      reasoningSum: number;
      reasoningCount: number;
      costSum: number;
      pricedCount: number;
      costEstimated: boolean;
      unpricedCalls: number;
    }>();
    const byPurposeMap = new Map<string, { purpose: string; calls: number; inputTokens: number; outputTokens: number; costSum: number; pricedCount: number }>();

    for (const req of requests) {
      if (req.status === 'running') continue;
      const inp = req.inputTokens ?? 0;
      const out = req.outputTokens ?? 0;
      inputTokens += inp;
      outputTokens += out;
      totalTokens += inp + out;

      if (req.cachedInputTokens !== null) {
        cachedSum += req.cachedInputTokens;
        cachedCount += 1;
        const cw = req.cacheWriteInputTokens ?? 0;
        if (req.cachedInputTokens + cw > inp) {
          inconsistent += 1;
        } else {
          reportedInputForCache += inp;
          cacheReadForHitRatio += req.cachedInputTokens;
        }
      } else {
        cacheNotReported += 1;
      }

      if (req.cacheWriteInputTokens !== null) {
        cacheWriteSum += req.cacheWriteInputTokens;
        cacheWriteCount += 1;
      }
      if (req.reasoningTokens !== null) {
        reasoningSum += req.reasoningTokens;
        reasoningCount += 1;
      }

      if (req.costUsd !== null) {
        costSum += req.costUsd;
        pricedCount += 1;
        if (req.costEstimated) costEstimated = true;
        if (req.purpose === 'compaction') {
          compactionCost += req.costUsd;
          compactionPriced = true;
        }
      } else if (req.unpricedReason !== undefined) {
        unpricedCalls += 1;
        unpricedReasons.add(req.unpricedReason);
      }

      const modelKey = `${req.provider}/${req.model}`;
      const m = byModelMap.get(modelKey) ?? {
        model: req.model,
        provider: req.provider,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedSum: 0,
        cachedCount: 0,
        cacheWriteSum: 0,
        cacheWriteCount: 0,
        reasoningSum: 0,
        reasoningCount: 0,
        costSum: 0,
        pricedCount: 0,
        costEstimated: false,
        unpricedCalls: 0,
      };
      m.calls += 1;
      m.inputTokens += inp;
      m.outputTokens += out;
      if (req.cachedInputTokens !== null) {
        m.cachedSum += req.cachedInputTokens;
        m.cachedCount += 1;
      }
      if (req.cacheWriteInputTokens !== null) {
        m.cacheWriteSum += req.cacheWriteInputTokens;
        m.cacheWriteCount += 1;
      }
      if (req.reasoningTokens !== null) {
        m.reasoningSum += req.reasoningTokens;
        m.reasoningCount += 1;
      }
      if (req.costUsd !== null) {
        m.costSum += req.costUsd;
        m.pricedCount += 1;
        if (req.costEstimated) m.costEstimated = true;
      } else if (req.unpricedReason !== undefined) {
        m.unpricedCalls += 1;
      }
      byModelMap.set(modelKey, m);

      const p = byPurposeMap.get(req.purpose) ?? { purpose: req.purpose, calls: 0, inputTokens: 0, outputTokens: 0, costSum: 0, pricedCount: 0 };
      p.calls += 1;
      p.inputTokens += inp;
      p.outputTokens += out;
      if (req.costUsd !== null) {
        p.costSum += req.costUsd;
        p.pricedCount += 1;
      }
      byPurposeMap.set(req.purpose, p);
    }

    const uncachedInputTokens = cachedCount > 0 && inconsistent === 0 ? Math.max(0, reportedInputForCache - cacheReadForHitRatio - cacheWriteSum) : null;
    const hitRatio = reportedInputForCache > 0 && inconsistent === 0 ? cacheReadForHitRatio / reportedInputForCache : null;

    return {
      totals: {
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens: cachedCount > 0 ? cachedSum : null,
        cacheReadTokens: cachedCount > 0 ? cachedSum : null,
        cacheWriteTokens: cacheWriteCount > 0 ? cacheWriteSum : null,
        uncachedInputTokens,
        reasoningTokens: reasoningCount > 0 ? reasoningSum : null,
      },
      cache: {
        ...prevUsage.cache,
        hitRatio,
        cacheReadNotReportedCalls: cacheNotReported,
        inconsistentUsageCalls: inconsistent,
      },
      cost: {
        totalUsd: pricedCount > 0 ? costSum : null,
        isEstimated: costEstimated,
        unpricedCalls,
        unpricedReasons: [...unpricedReasons],
        compactionCostUsd: compactionPriced ? compactionCost : prevUsage.cost.compactionCostUsd,
        byModel: [...byModelMap.values()].map((m) => ({
          model: m.model,
          provider: m.provider,
          calls: m.calls,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cachedInputTokens: m.cachedCount > 0 ? m.cachedSum : null,
          cacheWriteTokens: m.cacheWriteCount > 0 ? m.cacheWriteSum : null,
          reasoningTokens: m.reasoningCount > 0 ? m.reasoningSum : null,
          costUsd: m.pricedCount > 0 ? m.costSum : null,
          costEstimated: m.costEstimated,
          unpricedCalls: m.unpricedCalls,
        })),
        byPurpose: [...byPurposeMap.values()].map((p) => ({
          purpose: p.purpose,
          calls: p.calls,
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          costUsd: p.pricedCount > 0 ? p.costSum : null,
        })),
      },
      requests,
    };
  };

  const summarizeTools = (tools: readonly InspectorToolExecution[]) => ({
    total: tools.length,
    succeeded: tools.filter((t) => t.status === 'completed' || t.status === 'reconciled').length,
    failed: tools.filter((t) => t.status === 'failed').length,
    running: tools.filter((t) => t.status === 'running' || t.status === 'requested').length,
    awaitingApproval: tools.filter((t) => t.status === 'awaiting_approval' || t.status === 'awaiting_input').length,
    denied: tools.filter((t) => t.status === 'denied').length,
  });

  const applyRunEvent = (event: PublicRunEvent): boolean => {
    let changed = true;
    const at = event.createdAt;
    switch (event.type) {
      case 'run.started': {
        state = {
          ...state,
          agent: {
            ...state.agent,
            runId: event.runId,
            status: 'RUNNING',
            phase: 'started',
            attempt: event.attempt,
            retrying: false,
            waitingForModel: false,
            waitingForTool: false,
            waitingForApproval: false,
            waitingForElicitation: false,
            startedAt: at,
            updatedAt: at,
          },
        };
        break;
      }
      case 'run.status': {
        const terminal = event.to === 'COMPLETED' || event.to === 'STOPPED' || event.to === 'FAILED' || event.to === 'CANCELLED';
        state = {
          ...state,
          agent: {
            ...state.agent,
            runId: event.runId,
            status: event.to,
            phase: event.to.toLowerCase(),
            waitingForModel: terminal ? false : state.agent.waitingForModel,
            waitingForTool: event.to === 'WAITING_TOOL',
            waitingForApproval: event.to === 'WAITING_HUMAN',
            ...(terminal ? { retrying: false } : {}),
            ...(event.reason === undefined ? {} : { stopReason: event.reason as StopReason }),
            updatedAt: at,
          },
        };
        break;
      }
      case 'attempt.failed': {
        state = {
          ...state,
          agent: {
            ...state.agent,
            attempt: event.attempt,
            retrying: true,
            retryCode: event.code,
            retryAt: event.retryAt,
            phase: 'retrying',
            updatedAt: at,
          },
        };
        break;
      }
      case 'agent.thought.delta': {
        if (state.agent.phase === 'thinking') return false;
        state = { ...state, agent: { ...state.agent, phase: 'thinking', updatedAt: at } };
        break;
      }
      case 'agent.message.delta': {
        if (state.agent.phase === 'responding') return false;
        state = { ...state, agent: { ...state.agent, phase: 'responding', updatedAt: at } };
        break;
      }
      case 'model.requested': {
        const requests = [...state.usage.requests];
        const reqId = `${event.runId}:${event.step}:${event.attempt}`;
        const model = state.session.model;
        const provider = state.session.provider;
        if (!requests.some((r) => r.id === reqId)) {
          clampPush(
            requests,
            {
              id: reqId,
              runId: event.runId,
              step: event.step,
              attempt: event.attempt,
              purpose: 'run',
              model,
              provider,
              startedAt: at,
              endedAt: null,
              latencyMs: null,
              firstEventMs: null,
              inputTokens: null,
              outputTokens: null,
              cachedInputTokens: null,
              cacheWriteInputTokens: null,
              reasoningTokens: null,
              costUsd: null,
              costEstimated: false,
              status: 'running',
            },
            requestLimit,
          );
        }
        let nextContext = state.context;
        if (event.anatomy !== undefined) {
          const cw = state.context.contextWindow;
          const categories = buildContextCategories(event.anatomy);
          nextContext = {
            ...nextContext,
            currentTokens: event.anatomy.total,
            utilization: cw !== null && cw > 0 ? event.anatomy.total / cw : null,
            anatomy: event.anatomy,
            categories,
            toolDefinitionTokens: event.anatomy.tools,
          };
        }
        const nextCacheBreaks = { ...state.usage.cache.cacheBreaks };
        if (event.prefix !== undefined && (event.prefix.toolsChanged || event.prefix.causes.length > 0)) {
          for (const cause of event.prefix.causes) {
            nextCacheBreaks[cause] = (nextCacheBreaks[cause] ?? 0) + 1;
          }
        }
        state = {
          ...state,
          agent: {
            ...state.agent,
            step: event.step,
            attempt: event.attempt,
            waitingForModel: true,
            retrying: false,
            phase: 'waiting_model',
            updatedAt: at,
          },
          context: nextContext,
          usage: {
            ...state.usage,
            cache: { ...state.usage.cache, cacheBreaks: nextCacheBreaks },
            requests,
          },
        };
        break;
      }
      case 'model.responded': {
        const reqId = `${event.runId}:${event.step}:${event.attempt}`;
        const requests = [...state.usage.requests];
        const idx = requests.findIndex((r) => r.id === reqId);
        const usage = event.response.usage;
        const momonga = event.response.momonga;
        const cachedTokens = reportedCachedTokensOf(usage, momonga) ?? null;
        const cacheWriteTokens = momonga?.cacheWriteInputTokens ?? null;
        const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? null;
        const costUsd = momonga?.cost?.amount ?? null;
        const unpricedReason = momonga?.unpriced?.reason;
        const target = event.target ?? state.session.model;
        const parsed = parseCanon(target);
        const updatedReq: InspectorRequestEntry = {
          id: reqId,
          runId: event.runId,
          step: event.step,
          attempt: event.attempt,
          purpose: 'run',
          model: target,
          provider: parsed?.provider ?? state.session.provider,
          startedAt: idx >= 0 ? requests[idx]!.startedAt : at,
          endedAt: at,
          latencyMs: event.response.timing?.durationMs ?? (idx >= 0 ? Math.max(0, at - requests[idx]!.startedAt) : null),
          firstEventMs: event.response.timing?.firstEventMs ?? null,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cachedInputTokens: cachedTokens,
          cacheWriteInputTokens: cacheWriteTokens,
          reasoningTokens,
          costUsd,
          costEstimated: false,
          ...(unpricedReason === undefined ? {} : { unpricedReason }),
          status: event.response.status === 'incomplete' ? 'incomplete' : 'completed',
        };
        if (idx >= 0) requests[idx] = updatedReq;
        else clampPush(requests, updatedReq, requestLimit);

        state = {
          ...state,
          agent: {
            ...state.agent,
            waitingForModel: false,
            phase: 'processing_response',
            updatedAt: at,
          },
          usage: recomputeUsage(requests, state.usage),
        };
        break;
      }
      case 'model.rejected': {
        const reqId = `${event.runId}:${event.step}:${event.attempt}`;
        const requests = state.usage.requests.map((r) =>
          r.id === reqId ? { ...r, status: 'rejected' as const, endedAt: at, error: event.reason } : r,
        );
        state = {
          ...state,
          agent: { ...state.agent, waitingForModel: false, updatedAt: at },
          usage: { ...state.usage, requests },
        };
        break;
      }
      case 'usage.charged': {
        const requests = [...state.usage.requests];
        const target = event.target ?? state.session.model;
        const parsed = parseCanon(target);
        clampPush(
          requests,
          {
            id: `charge:${event.runId}:${event.seq}`,
            runId: event.runId,
            step: event.step,
            attempt: 1,
            purpose: event.purpose,
            model: target,
            provider: parsed?.provider ?? state.session.provider,
            startedAt: at,
            endedAt: at,
            latencyMs: event.timing?.durationMs ?? null,
            firstEventMs: event.timing?.firstEventMs ?? null,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cachedInputTokens: event.cachedInputTokens ?? null,
            cacheWriteInputTokens: event.cacheWriteInputTokens ?? null,
            reasoningTokens: null,
            costUsd: event.cost?.amount ?? null,
            costEstimated: false,
            ...(event.unpriced === undefined ? {} : { unpricedReason: event.unpriced.reason }),
            status: 'completed',
          },
          requestLimit,
        );
        state = { ...state, usage: recomputeUsage(requests, state.usage) };
        break;
      }
      case 'tool.call': {
        const toolCalls = [...state.execution.toolCalls];
        if (!toolCalls.some((t) => t.callId === event.callId)) {
          clampPush(
            toolCalls,
            {
              callId: event.callId,
              runId: event.runId,
              step: event.step,
              name: event.name,
              title: redact(event.title),
              kind: event.kind,
              ...(event.sideEffect === undefined ? {} : { sideEffect: event.sideEffect }),
              status: 'requested',
              startedAt: at,
              endedAt: null,
              durationMs: null,
              argsSummary: redact(summarizeArgs(event.rawInput)),
              outputSummary: '',
              outputBytes: null,
              truncated: false,
              permission: {},
              sandbox: state.session.sandbox,
            },
            toolLimit,
          );
        }
        state = {
          ...state,
          agent: { ...state.agent, phase: 'tool_pending', updatedAt: at },
          execution: { ...state.execution, toolCalls, toolSummary: summarizeTools(toolCalls) },
        };
        break;
      }
      case 'tool.permission.requested': {
        const toolCalls = state.execution.toolCalls.map((t) =>
          t.callId === event.callId ? { ...t, status: 'awaiting_approval' as const } : t,
        );
        state = {
          ...state,
          agent: { ...state.agent, waitingForApproval: true, phase: 'waiting_approval', updatedAt: at },
          execution: { ...state.execution, toolCalls, toolSummary: summarizeTools(toolCalls) },
        };
        break;
      }
      case 'tool.permission.classified': {
        const toolCalls = state.execution.toolCalls.map((t) =>
          t.callId === event.callId
            ? {
                ...t,
                permission: {
                  ...t.permission,
                  decision: event.outcome,
                  ...(event.verdict === undefined ? {} : { classifierVerdict: event.verdict }),
                  ...(event.confidence === undefined ? {} : { classifierConfidence: event.confidence }),
                },
              }
            : t,
        );
        state = { ...state, execution: { ...state.execution, toolCalls } };
        break;
      }
      case 'tool.permission.resolved': {
        state = {
          ...state,
          agent: { ...state.agent, waitingForApproval: false, updatedAt: at },
        };
        break;
      }
      case 'tool.elicitation.requested': {
        const toolCalls = state.execution.toolCalls.map((t) =>
          t.callId === event.callId ? { ...t, status: 'awaiting_input' as const } : t,
        );
        state = {
          ...state,
          agent: { ...state.agent, waitingForElicitation: true, phase: 'waiting_input', updatedAt: at },
          execution: { ...state.execution, toolCalls, toolSummary: summarizeTools(toolCalls) },
        };
        break;
      }
      case 'tool.elicitation.resolved':
      case 'tool.elicitation.cancelled': {
        state = {
          ...state,
          agent: { ...state.agent, waitingForElicitation: false, updatedAt: at },
        };
        break;
      }
      case 'tool.started': {
        const toolCalls = state.execution.toolCalls.map((t) =>
          t.callId === event.callId
            ? {
                ...t,
                status: 'running' as const,
                startedAt: at,
                permission: { ...t.permission, ...(event.basis === undefined ? {} : { basis: event.basis }) },
              }
            : t,
        );
        state = {
          ...state,
          agent: { ...state.agent, waitingForTool: true, phase: 'running_tool', updatedAt: at },
          execution: { ...state.execution, toolCalls, toolSummary: summarizeTools(toolCalls) },
        };
        break;
      }
      case 'tool.completed': {
        const toolCalls = state.execution.toolCalls.map((t) => {
          if (t.callId !== event.callId) return t;
          const status: InspectorToolStatus = event.denial !== undefined ? 'denied' : event.status === 'completed' ? 'completed' : 'failed';
          return {
            ...t,
            status,
            endedAt: at,
            durationMs: Math.max(0, at - t.startedAt),
            outputSummary: redact(previewSlice(event.output, 160)),
            outputBytes: event.output.length,
            truncated: event.truncated === true,
            ...(event.handle === undefined ? {} : { handle: event.handle }),
            ...(event.status === 'failed' ? { error: redact(previewSlice(event.output, 160)) } : {}),
            permission: {
              ...t.permission,
              ...(event.denial === undefined ? {} : { denialSource: event.denial.source, denialReason: redact(event.denial.reason) }),
            },
          };
        });
        const anyRunning = toolCalls.some((t) => t.status === 'running');
        state = {
          ...state,
          agent: { ...state.agent, waitingForTool: anyRunning, updatedAt: at },
          execution: { ...state.execution, toolCalls, toolSummary: summarizeTools(toolCalls) },
        };
        break;
      }
      case 'tool.reconciled': {
        const toolCalls = state.execution.toolCalls.map((t) =>
          t.callId === event.callId
            ? {
                ...t,
                status: 'reconciled' as const,
                endedAt: at,
                durationMs: Math.max(0, at - t.startedAt),
                outputSummary: redact(previewSlice(event.output, 160)),
              }
            : t,
        );
        state = { ...state, execution: { ...state.execution, toolCalls, toolSummary: summarizeTools(toolCalls) } };
        break;
      }
      case 'context.compacting': {
        state = { ...state, agent: { ...state.agent, phase: 'compacting', updatedAt: at } };
        break;
      }
      case 'context.compacted':
      case 'context.inherited_compacted': {
        const before = event.tokensBefore ?? null;
        const after = event.tokensAfter ?? null;
        const saved = before !== null && after !== null ? Math.max(0, before - after) : null;
        const ratio = before !== null && before > 0 && after !== null ? after / before : null;
        const compactions = [...state.context.compactions];
        clampPush(
          compactions,
          {
            id: `${event.runId}:${event.seq}`,
            seq: event.seq,
            reason: event.type === 'context.inherited_compacted' ? 'inherited' : 'auto',
            source: event.type === 'context.compacted' ? (event.source ?? 'unknown') : 'unknown',
            tokensBefore: before,
            tokensAfter: after,
            ...(event.tokensAfterEstimated === undefined ? {} : { tokensAfterEstimated: event.tokensAfterEstimated }),
            savedTokens: saved,
            ratio,
            durationMs: null,
            replacedThroughSeq: event.replacedThroughSeq,
            summaryPreview: redact(previewSlice(event.summary, 180)),
            preservedInfo: event.type === 'context.compacted' && event.fidelity !== undefined ? [`${event.fidelity.retained} identifiers retained`, `sections: ${event.fidelity.sections}`] : [],
            ...(event.type === 'context.compacted' && event.fidelity !== undefined ? { fidelity: event.fidelity } : {}),
            rejected: false,
            createdAt: at,
            costUsd: null,
          },
          compactionLimit,
        );
        const cw = state.context.contextWindow;
        state = {
          ...state,
          context: {
            ...state.context,
            ...(after !== null ? { currentTokens: after, utilization: cw !== null && cw > 0 ? after / cw : null } : {}),
            compactions,
          },
        };
        break;
      }
      case 'context.compaction_rejected': {
        const compactions = [...state.context.compactions];
        clampPush(
          compactions,
          {
            id: `rejected:${event.runId}:${event.seq}`,
            seq: event.seq,
            reason: 'auto',
            source: 'unknown',
            tokensBefore: null,
            tokensAfter: null,
            savedTokens: null,
            ratio: null,
            durationMs: null,
            replacedThroughSeq: 0,
            summaryPreview: '',
            preservedInfo: [],
            rejected: true,
            error: 'Compaction summary rejected by server',
            createdAt: at,
            costUsd: null,
          },
          compactionLimit,
        );
        state = { ...state, context: { ...state.context, compactions } };
        break;
      }
      case 'context.truncated': {
        if (event.kind !== 'omitted') {
          changed = false;
          break;
        }
        const evicted = state.context.evictedCallIds.includes(event.callId)
          ? state.context.evictedCallIds
          : [...state.context.evictedCallIds, event.callId];
        const items = state.context.items.map((item) =>
          item.callId === event.callId ? { ...item, evicted: true } : item,
        );
        state = { ...state, context: { ...state.context, evictedCallIds: evicted, items } };
        break;
      }
      case 'context.memories_loaded': {
        const byId = new Map(state.memory.allMemories.map((m) => [m.id, m]));
        const active: InspectorActiveMemory[] = event.memories.map((loaded) => {
          const full = byId.get(loaded.id);
          return {
            id: loaded.id,
            kind: full?.kind ?? 'fact',
            scope: full?.scope ?? 'unknown',
            origin: full?.origin ?? 'unknown',
            state: full?.state ?? 'active',
            status: loaded.status,
            summary: redact(previewSlice(full?.text ?? loaded.id, 100)),
            text: redact(full?.text ?? ''),
            tokens: 0,
            createdAt: full?.createdAt ?? at,
            keptAt: full?.keptAt ?? at,
            contributedAt: full?.contributedAt ?? null,
            evidence: {
              files: loaded.files ?? [],
              ...(loaded.commit === undefined ? {} : { commit: loaded.commit }),
              checks: full?.evidence.filter((e) => e.kind === 'check').length ?? 0,
            },
            adoptionReason: state.memory.sessionControls.pinnedIds.includes(loaded.id) ? 'pinned for session' : 'recalled within memory budget',
            pinned: state.memory.sessionControls.pinnedIds.includes(loaded.id),
            excluded: state.memory.sessionControls.excludedIds.includes(loaded.id),
          };
        });
        const lifecycle = [...state.memory.lifecycle];
        for (const loaded of event.memories) {
          clampPush(
            lifecycle,
            {
              id: `inj:${event.runId}:${event.seq}:${loaded.id}`,
              at,
              kind: 'injected',
              memoryId: loaded.id,
              summary: `Injected into context (${loaded.status})`,
            },
            lifecycleLimit,
          );
        }
        state = { ...state, memory: { ...state.memory, active, lifecycle } };
        break;
      }
      case 'verification.started': {
        const list = [...state.execution.completionConditions];
        const idx = list.findIndex((c) => c.id === event.conditionId);
        const updated: InspectorCompletionCondition = idx >= 0
          ? { ...list[idx]!, state: 'running', rounds: event.round }
          : { id: event.conditionId, command: redact(event.command), state: 'running', rounds: event.round };
        if (idx >= 0) list[idx] = updated;
        else list.push(updated);
        state = { ...state, execution: { ...state.execution, completionConditions: list } };
        break;
      }
      case 'verification.completed': {
        const list = [...state.execution.completionConditions];
        const idx = list.findIndex((c) => c.id === event.conditionId);
        const outcome: VerificationOutcome = event.outcome;
        const updated: InspectorCompletionCondition = {
          ...(idx >= 0 ? list[idx]! : { id: event.conditionId, command: redact(event.command) }),
          state: outcome,
          rounds: event.round,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
          durationMs: event.durationMs,
          outputPreview: redact(previewSlice(event.output, 160)),
          ...(event.handle === undefined ? {} : { handle: event.handle }),
        };
        if (idx >= 0) list[idx] = updated;
        else list.push(updated);
        state = { ...state, execution: { ...state.execution, completionConditions: list } };
        break;
      }
      case 'plan.updated': {
        state = {
          ...state,
          execution: {
            ...state.execution,
            plan: event.entries.map((e) => ({ ...e, content: redact(e.content) })),
          },
        };
        break;
      }
      case 'mode.changed': {
        if (event.mode !== 'unknown') {
          state = { ...state, session: { ...state.session, permissionMode: event.mode } };
        }
        break;
      }
      case 'model.changed': {
        const parsed = parseCanon(event.model);
        state = {
          ...state,
          session: {
            ...state.session,
            model: event.model,
            provider: parsed?.provider ?? state.session.provider,
          },
        };
        break;
      }
      case 'memory.judged': {
        const lifecycle = [...state.memory.lifecycle];
        clampPush(
          lifecycle,
          {
            id: `judged:${event.id}:${event.memoryId}`,
            at,
            kind: 'judged',
            memoryId: event.memoryId,
            summary: 'Memory reviewed by classifier',
          },
          lifecycleLimit,
        );
        state = { ...state, memory: { ...state.memory, lifecycle } };
        break;
      }
      default:
        changed = false;
        break;
    }
    if (changed) {
      state = withDiagnostics({
        ...state,
        meta: { ...state.meta, capturedAt: at },
      });
    }
    return changed;
  };

  return {
    snapshot: () => state,
    version: () => ver,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resetForSession: (session) => {
      seenEventKeys.clear();
      eventKeyRing.length = 0;
      state = withDiagnostics(emptyInspectorSnapshot({ session, now: options.now(), bufferLimit }));
      notify();
    },
    mergeServerSnapshot: (server) => {
      state = withDiagnostics({
        ...server,
        meta: {
          ...server.meta,
          eventCount: Math.max(server.meta.eventCount, state.meta.eventCount),
          droppedEvents: Math.max(server.meta.droppedEvents, state.meta.droppedEvents),
          bufferLimit,
          liveConnected: state.meta.liveConnected,
        },
      });
      notify();
    },
    ingestEvent: (event) => {
      if (isOpaqueEvent(event)) return;
      if (!recordEventSeen(event)) return;
      if (applyRunEvent(event)) notify();
    },
    setLiveConnected: (connected) => {
      if (state.meta.liveConnected === connected) return;
      state = { ...state, meta: { ...state.meta, liveConnected: connected } };
      notify();
    },
  };
};
