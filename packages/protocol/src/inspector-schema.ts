import { anything, boolean, closed, enumOf, integer, nonNegativeInteger, nullable, root, storedEnumOf, string } from './schema-helpers.ts';
import type { JsonSchema } from './schema-helpers.ts';
import { REASONING_EFFORTS } from './capabilities.ts';
import { CONDITION_STATES } from './completion.ts';
import { SUMMARY_SOURCES } from './context-record.ts';
import { MEMORY_STATUSES } from './memory.ts';
import { CACHE_MISS_CAUSES } from './prefix-events.ts';
import { PERMISSION_MODES, RUN_STATUSES, SIDE_EFFECTS, STOP_REASONS, TOOL_KINDS } from './run-types.ts';

export const INSPECTOR_MEMORY_CONTROL_ACTIONS = ['exclude', 'include', 'pin', 'unpin'] as const;

const nullableNumber = nullable({ type: 'number' });
const nullableNonNegativeInteger = nullable(nonNegativeInteger);

const contextCategoryKey = enumOf([
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
]);

const causeCountsSchema = closed(
  Object.fromEntries(CACHE_MISS_CAUSES.map((cause) => [cause, nonNegativeInteger])),
  [],
);

export const INSPECTOR_REQUEST_SCHEMAS = {
  InspectorContextExcludeRequest: root(closed({ callId: { type: 'string', minLength: 1 }, excluded: boolean }, ['callId', 'excluded'])),
  InspectorMemoryControlRequest: root(
    closed({ memoryId: { type: 'string', minLength: 1 }, action: enumOf(INSPECTOR_MEMORY_CONTROL_ACTIONS) }, ['memoryId', 'action']),
  ),
  InspectorMemorySearchRequest: root(closed({ query: string }, ['query'])),
  EditMemoryRequest: root(closed({ text: { type: 'string', minLength: 1 } }, ['text'])),
} as const satisfies Record<string, JsonSchema>;

export const inspectorSnapshotSchema = (memoryViewSchema: JsonSchema, tokenAnatomySchema: JsonSchema, summaryFidelitySchema: JsonSchema): JsonSchema =>
  root(
    closed(
      {
        session: closed(
          {
            id: string,
            cwd: string,
            model: string,
            provider: string,
            effort: storedEnumOf(REASONING_EFFORTS),
            permissionMode: enumOf(PERMISSION_MODES),
            sandbox: nullable(string),
            contextWindow: nullableNonNegativeInteger,
          },
          ['id', 'cwd', 'model', 'provider', 'permissionMode', 'sandbox', 'contextWindow'],
        ),
        agent: closed(
          {
            runId: nullable(string),
            status: enumOf([...RUN_STATUSES, 'IDLE']),
            phase: string,
            step: nonNegativeInteger,
            attempt: nonNegativeInteger,
            waitingForModel: boolean,
            waitingForTool: boolean,
            waitingForApproval: boolean,
            waitingForElicitation: boolean,
            retrying: boolean,
            retryCode: string,
            retryAt: integer,
            stopReason: enumOf(STOP_REASONS),
            error: string,
            startedAt: integer,
            updatedAt: integer,
          },
          ['runId', 'status', 'phase', 'step', 'attempt', 'waitingForModel', 'waitingForTool', 'waitingForApproval', 'waitingForElicitation', 'retrying', 'updatedAt'],
        ),
        context: closed(
          {
            currentTokens: nullableNonNegativeInteger,
            contextWindow: nullableNonNegativeInteger,
            utilization: nullableNumber,
            anatomy: nullable(tokenAnatomySchema),
            categories: {
              type: 'array',
              items: closed({ key: contextCategoryKey, label: string, tokens: nonNegativeInteger, share: { type: 'number', minimum: 0 } }, ['key', 'label', 'tokens', 'share']),
            },
            items: {
              type: 'array',
              items: closed(
                {
                  id: string,
                  category: contextCategoryKey,
                  label: string,
                  tokens: nonNegativeInteger,
                  share: { type: 'number', minimum: 0 },
                  addedAt: integer,
                  seq: nonNegativeInteger,
                  source: string,
                  cached: enumOf(['prefix', 'dynamic', 'unknown']),
                  preview: string,
                  callId: string,
                  handle: string,
                  sizeBytes: nonNegativeInteger,
                  evicted: boolean,
                  truncated: boolean,
                  excludable: boolean,
                },
                ['id', 'category', 'label', 'tokens', 'share', 'source', 'cached', 'preview', 'excludable'],
              ),
            },
            compactions: {
              type: 'array',
              items: closed(
                {
                  id: string,
                  seq: nonNegativeInteger,
                  reason: enumOf(['manual', 'auto', 'inherited']),
                  source: enumOf([...SUMMARY_SOURCES, 'unknown']),
                  tokensBefore: nullableNonNegativeInteger,
                  tokensAfter: nullableNonNegativeInteger,
                  tokensAfterEstimated: boolean,
                  savedTokens: nullableNonNegativeInteger,
                  ratio: nullableNumber,
                  durationMs: nullableNonNegativeInteger,
                  replacedThroughSeq: nonNegativeInteger,
                  summaryPreview: string,
                  preservedInfo: { type: 'array', items: string },
                  fidelity: summaryFidelitySchema,
                  rejected: boolean,
                  error: string,
                  createdAt: integer,
                  costUsd: nullableNumber,
                },
                ['id', 'seq', 'reason', 'source', 'tokensBefore', 'tokensAfter', 'savedTokens', 'ratio', 'durationMs', 'replacedThroughSeq', 'summaryPreview', 'preservedInfo', 'rejected', 'createdAt', 'costUsd'],
              ),
            },
            suggestions: {
              type: 'array',
              items: closed(
                {
                  id: string,
                  message: string,
                  savingsTokens: nonNegativeInteger,
                  action: enumOf(['compact', 'exclude_tool_output']),
                  callId: string,
                },
                ['id', 'message'],
              ),
            },
            evictedCallIds: { type: 'array', items: string },
            toolDefinitionTokens: { type: 'object', additionalProperties: nonNegativeInteger },
          },
          ['currentTokens', 'contextWindow', 'utilization', 'anatomy', 'categories', 'items', 'compactions', 'suggestions', 'evictedCallIds', 'toolDefinitionTokens'],
        ),
        memory: closed(
          {
            active: {
              type: 'array',
              items: closed(
                {
                  id: string,
                  kind: string,
                  scope: string,
                  origin: string,
                  state: string,
                  status: enumOf(MEMORY_STATUSES),
                  summary: string,
                  text: string,
                  tokens: nonNegativeInteger,
                  createdAt: integer,
                  keptAt: integer,
                  contributedAt: nullable(integer),
                  evidence: closed({ files: { type: 'array', items: string }, commit: string, checks: nonNegativeInteger }, ['files', 'checks']),
                  adoptionReason: string,
                  pinned: boolean,
                  excluded: boolean,
                },
                ['id', 'kind', 'scope', 'origin', 'state', 'status', 'summary', 'text', 'tokens', 'createdAt', 'keptAt', 'contributedAt', 'evidence', 'adoptionReason', 'pinned', 'excluded'],
              ),
            },
            retrievalTrace: nullable(
              closed(
                {
                  query: string,
                  terms: { type: 'array', items: string },
                  executedAt: integer,
                  latencyMs: nullableNonNegativeInteger,
                  budgetTokens: nullableNonNegativeInteger,
                  usedTokens: nullableNonNegativeInteger,
                  matchCapped: boolean,
                  touchedCap: nullableNonNegativeInteger,
                  moreAvailable: boolean,
                  candidateCount: nonNegativeInteger,
                  selectedCount: nonNegativeInteger,
                  candidates: {
                    type: 'array',
                    items: closed(
                      {
                        id: string,
                        summary: string,
                        kind: string,
                        status: enumOf(MEMORY_STATUSES),
                        matched: boolean,
                        tier: nonNegativeInteger,
                        rank: nonNegativeInteger,
                        tokens: nonNegativeInteger,
                        decision: enumOf(['included', 'excluded']),
                        reason: string,
                        pinned: boolean,
                        sessionExcluded: boolean,
                      },
                      ['id', 'summary', 'kind', 'status', 'matched', 'tier', 'rank', 'tokens', 'decision', 'reason', 'pinned', 'sessionExcluded'],
                    ),
                  },
                },
                ['query', 'terms', 'executedAt', 'latencyMs', 'budgetTokens', 'usedTokens', 'matchCapped', 'touchedCap', 'moreAvailable', 'candidateCount', 'selectedCount', 'candidates'],
              ),
            ),
            lifecycle: {
              type: 'array',
              items: closed(
                {
                  id: string,
                  at: integer,
                  kind: string,
                  memoryId: string,
                  summary: string,
                  detail: string,
                },
                ['id', 'at', 'kind', 'memoryId', 'summary'],
              ),
            },
            sessionControls: closed({ excludedIds: { type: 'array', items: string }, pinnedIds: { type: 'array', items: string } }, ['excludedIds', 'pinnedIds']),
            allMemories: { type: 'array', items: memoryViewSchema },
          },
          ['active', 'retrievalTrace', 'lifecycle', 'sessionControls', 'allMemories'],
        ),
        usage: closed(
          {
            totals: closed(
              {
                inputTokens: nonNegativeInteger,
                outputTokens: nonNegativeInteger,
                totalTokens: nonNegativeInteger,
                cachedInputTokens: nullableNonNegativeInteger,
                cacheReadTokens: nullableNonNegativeInteger,
                cacheWriteTokens: nullableNonNegativeInteger,
                uncachedInputTokens: nullableNonNegativeInteger,
                reasoningTokens: nullableNonNegativeInteger,
              },
              ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'uncachedInputTokens', 'reasoningTokens'],
            ),
            cache: closed(
              {
                hitRatio: nullableNumber,
                cacheReadNotReportedCalls: nonNegativeInteger,
                inconsistentUsageCalls: nonNegativeInteger,
                cacheBreaks: causeCountsSchema,
                cacheMissCauses: causeCountsSchema,
                estimatedSavingsUsd: nullableNumber,
                savingsBasis: enumOf(['estimated_from_price_table', 'unavailable']),
              },
              ['hitRatio', 'cacheReadNotReportedCalls', 'inconsistentUsageCalls', 'cacheBreaks', 'cacheMissCauses', 'estimatedSavingsUsd', 'savingsBasis'],
            ),
            cost: closed(
              {
                totalUsd: nullableNumber,
                isEstimated: boolean,
                unpricedCalls: nonNegativeInteger,
                unpricedReasons: { type: 'array', items: string },
                compactionCostUsd: nullableNumber,
                byModel: {
                  type: 'array',
                  items: closed(
                    {
                      model: string,
                      provider: string,
                      calls: nonNegativeInteger,
                      inputTokens: nonNegativeInteger,
                      outputTokens: nonNegativeInteger,
                      cachedInputTokens: nullableNonNegativeInteger,
                      cacheWriteTokens: nullableNonNegativeInteger,
                      reasoningTokens: nullableNonNegativeInteger,
                      costUsd: nullableNumber,
                      costEstimated: boolean,
                      unpricedCalls: nonNegativeInteger,
                    },
                    ['model', 'provider', 'calls', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'costEstimated', 'unpricedCalls'],
                  ),
                },
                byPurpose: {
                  type: 'array',
                  items: closed(
                    { purpose: string, calls: nonNegativeInteger, inputTokens: nonNegativeInteger, outputTokens: nonNegativeInteger, costUsd: nullableNumber },
                    ['purpose', 'calls', 'inputTokens', 'outputTokens', 'costUsd'],
                  ),
                },
              },
              ['totalUsd', 'isEstimated', 'unpricedCalls', 'unpricedReasons', 'compactionCostUsd', 'byModel', 'byPurpose'],
            ),
            requests: {
              type: 'array',
              items: closed(
                {
                  id: string,
                  runId: string,
                  step: nonNegativeInteger,
                  attempt: integer,
                  purpose: string,
                  model: string,
                  provider: string,
                  startedAt: integer,
                  endedAt: nullable(integer),
                  latencyMs: nullableNonNegativeInteger,
                  firstEventMs: nullableNonNegativeInteger,
                  inputTokens: nullableNonNegativeInteger,
                  outputTokens: nullableNonNegativeInteger,
                  cachedInputTokens: nullableNonNegativeInteger,
                  cacheWriteInputTokens: nullableNonNegativeInteger,
                  reasoningTokens: nullableNonNegativeInteger,
                  costUsd: nullableNumber,
                  costEstimated: boolean,
                  unpricedReason: string,
                  status: enumOf(['running', 'completed', 'incomplete', 'failed', 'cancelled', 'rejected']),
                  error: string,
                },
                ['id', 'runId', 'step', 'attempt', 'purpose', 'model', 'provider', 'startedAt', 'endedAt', 'latencyMs', 'firstEventMs', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens', 'costUsd', 'costEstimated', 'status'],
              ),
            },
          },
          ['totals', 'cache', 'cost', 'requests'],
        ),
        execution: closed(
          {
            toolCalls: {
              type: 'array',
              items: closed(
                {
                  callId: string,
                  runId: string,
                  step: nonNegativeInteger,
                  name: string,
                  title: string,
                  kind: enumOf(TOOL_KINDS),
                  sideEffect: enumOf(SIDE_EFFECTS),
                  status: enumOf(['requested', 'awaiting_approval', 'awaiting_input', 'running', 'completed', 'failed', 'denied', 'reconciled']),
                  startedAt: integer,
                  endedAt: nullable(integer),
                  durationMs: nullableNonNegativeInteger,
                  argsSummary: string,
                  outputSummary: string,
                  outputBytes: nullableNonNegativeInteger,
                  truncated: boolean,
                  handle: string,
                  error: string,
                  permission: closed(
                    {
                      basis: string,
                      decision: string,
                      classifierVerdict: string,
                      classifierConfidence: string,
                      denialSource: string,
                      denialReason: string,
                    },
                    [],
                  ),
                  sandbox: nullable(string),
                },
                ['callId', 'runId', 'step', 'name', 'title', 'kind', 'status', 'startedAt', 'endedAt', 'durationMs', 'argsSummary', 'outputSummary', 'outputBytes', 'truncated', 'permission', 'sandbox'],
              ),
            },
            toolSummary: closed(
              {
                total: nonNegativeInteger,
                succeeded: nonNegativeInteger,
                failed: nonNegativeInteger,
                running: nonNegativeInteger,
                awaitingApproval: nonNegativeInteger,
                denied: nonNegativeInteger,
              },
              ['total', 'succeeded', 'failed', 'running', 'awaitingApproval', 'denied'],
            ),
            completionConditions: {
              type: 'array',
              items: closed(
                {
                  id: string,
                  command: string,
                  when: string,
                  source: string,
                  state: enumOf([...CONDITION_STATES, 'running']),
                  rounds: nonNegativeInteger,
                  exitCode: integer,
                  durationMs: nonNegativeInteger,
                  outputPreview: string,
                  handle: string,
                },
                ['id', 'command', 'state', 'rounds'],
              ),
            },
            requirements: { type: 'array', items: string },
            plan: {
              type: 'array',
              items: closed(
                { content: string, priority: enumOf(['high', 'medium', 'low']), status: enumOf(['pending', 'in_progress', 'completed']) },
                ['content', 'priority', 'status'],
              ),
            },
          },
          ['toolCalls', 'toolSummary', 'completionConditions', 'requirements', 'plan'],
        ),
        diagnostics: {
          type: 'array',
          items: closed(
            {
              id: string,
              severity: enumOf(['info', 'warning', 'critical']),
              category: enumOf(['context', 'tool', 'compaction', 'cache', 'memory', 'latency', 'usage']),
              message: string,
              evidence: string,
              suggestedAction: string,
            },
            ['id', 'severity', 'category', 'message', 'evidence', 'suggestedAction'],
          ),
        },
        meta: closed(
          {
            capturedAt: integer,
            eventCount: nonNegativeInteger,
            droppedEvents: nonNegativeInteger,
            bufferLimit: nonNegativeInteger,
            liveConnected: boolean,
          },
          ['capturedAt', 'eventCount', 'droppedEvents', 'bufferLimit', 'liveConnected'],
        ),
      },
      ['session', 'agent', 'context', 'memory', 'usage', 'execution', 'diagnostics', 'meta'],
    ),
  );

export const inspectorMemorySearchResponseSchema = (): JsonSchema =>
  root(
    closed(
      {
        trace: anything,
      },
      ['trace'],
    ),
  );
