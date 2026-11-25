import type { Context } from 'hono';
import { createRedactor, defineProductSchema, productErrorsText } from '@momonga/foundation';
import type { Clock, ProductValidator, Redactor } from '@momonga/foundation';
import {
  INSPECTOR_EVENT_BUFFER_LIMIT,
  INSPECTOR_MEMORY_LIFECYCLE_LIMIT,
  INSPECTOR_REQUEST_SCHEMAS,
  buildContextCategories,
  createInspectorAccumulator,
  evaluateDiagnostics,
  parseCanon,
  summarizeMemoryEvidence,
  toPublicRunEvent,
  tokensForText,
} from '@momonga/protocol';
import type {
  Capabilities,
  CostBreakdownView,
  InputItem,
  InspectorActiveMemory,
  InspectorContextExcludeRequest,
  InspectorContextItem,
  InspectorContextSuggestion,
  InspectorMemoryControlRequest,
  InspectorMemoryLifecycleEvent,
  InspectorMemoryRetrievalTrace,
  InspectorMemorySearchRequest,
  InspectorMemorySearchResponse,
  InspectorRetrievalCandidate,
  InspectorSnapshot,
  MemoryRecord,
  MemoryView,
  PublicRunEvent,
  RunEvent,
  RunState,
} from '@momonga/protocol';
import { MEMORY_MATCH_LIMIT } from '@momonga/store';
import type { MemoryVisibility, RecallCursor, RuntimeStore, Session } from '@momonga/store';
import { createRecordViews } from '../memory/views.ts';
import type { EvidenceRun } from '../memory/evidence.ts';
import { termsOfQuery } from '../memory/recall-query.ts';
import { MEMORY_PAGE_ROWS } from '../process/constants.ts';
import type { SandboxKind } from '../process/sandbox-kind.ts';
import type { Handler, RouteRegistrar } from './app.ts';
import { invalidRequest, notFound } from './errors.ts';
import { JSON_MEDIA_TYPES, readJson } from './request.ts';
import type { SessionInspectorState } from './session-inspector-state.ts';

export type InspectorRouteStore = Pick<
  RuntimeStore,
  | 'getSession'
  | 'listRuns'
  | 'load'
  | 'readRunEvents'
  | 'readModelCallEvents'
  | 'memories'
  | 'trust'
  | 'journalFacts'
  | 'contextCharges'
  | 'getRun'
>;

export type InspectorRouteDeps = {
  store: InspectorRouteStore;
  clock: Clock;
  redactor: Redactor;
  modelCapabilities: (model: string, signal: AbortSignal) => Promise<Capabilities>;
  runCostBreakdown: (
    runs: readonly { runId: string; sessionId: string }[],
    signal: AbortSignal,
    includeRunless: boolean,
  ) => Promise<{ breakdown: CostBreakdownView; text: string }>;
  evidenceRun: (project: string) => EvidenceRun;
  sandboxKind?: (signal: AbortSignal) => Promise<SandboxKind>;
  maxBodyBytes: number;
  closeSignal: AbortSignal;
  inspectorState: SessionInspectorState;
};

const validateExclude: ProductValidator<InspectorContextExcludeRequest> = defineProductSchema(
  'inspector/InspectorContextExcludeRequest',
  INSPECTOR_REQUEST_SCHEMAS.InspectorContextExcludeRequest,
);
const validateMemoryControl: ProductValidator<InspectorMemoryControlRequest> = defineProductSchema(
  'inspector/InspectorMemoryControlRequest',
  INSPECTOR_REQUEST_SCHEMAS.InspectorMemoryControlRequest,
);
const validateMemorySearch: ProductValidator<InspectorMemorySearchRequest> = defineProductSchema(
  'inspector/InspectorMemorySearchRequest',
  INSPECTOR_REQUEST_SCHEMAS.InspectorMemorySearchRequest,
);

const bodyOf = <T>(validate: ProductValidator<T>, value: unknown): T => {
  const verdict = validate(value);
  if (!verdict.valid) throw invalidRequest(productErrorsText(verdict.errors, 'body'));
  return verdict.value;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const previewText = (text: string, maxChars = 160): string => {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= maxChars ? single : `${single.slice(0, maxChars - 1)}…`;
};

const visibleTo = (memory: MemoryRecord, visibility: MemoryVisibility): boolean =>
  visibility.trusted
    ? (memory.scope === 'user' && memory.origin === 'trusted') || (memory.scope === 'project' && memory.project === visibility.project)
    : memory.scope === 'user';

const sessionRedactFn = (base: Redactor, session: Session): ((input: string) => string) => {
  const envCreds = Object.values(session.env).filter((value): value is string => typeof value === 'string' && value.length >= 8);
  const envRedactor = createRedactor({ credentials: envCreds });
  return (input: string) => envRedactor.text(base.text(input));
};

const textOfInputItem = (item: InputItem): string => {
  switch (item.type) {
    case 'message':
      return typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
    case 'function_call':
      return `${item.name}(${item.arguments})`;
    case 'function_call_output':
      return typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
    case 'compaction':
      return item.encrypted_content;
    default:
      return JSON.stringify(item);
  }
};

const requirementsOfEvents = (events: readonly RunEvent[]): string[] => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'run.started') continue;
    const completion = event.pins?.['completion'];
    if (typeof completion === 'object' && completion !== null && Array.isArray((completion as { requirements?: unknown }).requirements)) {
      return (completion as { requirements: unknown[] }).requirements.filter((item): item is string => typeof item === 'string');
    }
  }
  return [];
};

const readAllRunEvents = (store: InspectorRouteStore, runId: string): RunEvent[] => {
  const out: RunEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = store.readRunEvents(runId, afterSeq, 500);
    if (page.length === 0) break;
    out.push(...page);
    const last = page[page.length - 1]!;
    if (last.seq <= afterSeq || page.length < 500) break;
    afterSeq = last.seq;
  }
  return out;
};

const redactMemoryView = (view: MemoryView, redact: (text: string) => string): MemoryView => ({
  ...view,
  text: redact(view.text),
});

export const registerInspectorRoutes = (route: RouteRegistrar, deps: InspectorRouteDeps): void => {
  const views = createRecordViews({ store: deps.store, evidenceRun: deps.evidenceRun });

  const boundOf = (context: Context): AbortSignal => AbortSignal.any([deps.closeSignal, context.req.raw.signal]);

  const requireSession = (context: Context): Session => {
    const id = context.req.param('id') ?? '';
    const session = deps.store.getSession(id);
    if (session === undefined) throw notFound(`session ${id} does not exist`);
    return session;
  };

  const buildSnapshot = async (session: Session, signal: AbortSignal): Promise<InspectorSnapshot> => {
    const redact = sessionRedactFn(deps.redactor, session);
    const parsedModel = parseCanon(session.model);
    let capabilities: Capabilities | undefined;
    try {
      capabilities = await deps.modelCapabilities(session.model, signal);
    } catch {
      capabilities = undefined;
    }
    let sandbox: string | null = null;
    if (deps.sandboxKind !== undefined) {
      try {
        sandbox = await deps.sandboxKind(signal);
      } catch {
        sandbox = null;
      }
    }

    const contextWindow = capabilities?.contextWindow ?? null;
    const acc = createInspectorAccumulator({ now: () => deps.clock.now(), redact });
    acc.resetForSession({
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      provider: parsedModel?.provider ?? 'unknown',
      ...(session.effort !== null && session.effort !== 'unknown' ? { effort: session.effort } : {}),
      permissionMode: session.permissionMode === 'unknown' ? 'manual' : session.permissionMode,
      sandbox,
      contextWindow,
    });

    const runs = [...deps.store.listRuns(session.id)].sort((left, right) => left.createdAt - right.createdAt);
    const allRunEvents: RunEvent[] = [];
    for (const run of runs) {
      const events = readAllRunEvents(deps.store, run.id);
      allRunEvents.push(...events);
      for (const event of events) {
        acc.ingestEvent(toPublicRunEvent(event) as PublicRunEvent);
      }
    }

    const stateFromInspector = deps.inspectorState.getState(session.id, session.cwd);
    const excludedCallsSet = new Set(stateFromInspector.excludedCallIds);
    const excludedMemoriesSet = new Set(stateFromInspector.excludedMemoryIds);
    const pinnedMemoriesSet = new Set(stateFromInspector.pinnedMemoryIds);

    let trusted = false;
    try {
      trusted = (await deps.store.trust.decisionAsked(session.cwd, signal)).decision === 'trusted';
    } catch {
      trusted = false;
    }
    const visibility: MemoryVisibility = trusted ? { trusted: true, project: session.cwd } : { trusted: false };
    const visibleRecords = deps.store.memories
      .list()
      .filter((record) => visibleTo(record, visibility))
      .sort((left, right) => right.keptAt - left.keptAt || right.createdAt - left.createdAt);
    const visibleViews = (await views.viewsOf(visibleRecords, signal)).map((view) => redactMemoryView(view, redact));
    const viewById = new Map<string, MemoryView>(visibleViews.map((view) => [view.id, view]));

    const base = acc.snapshot();
    let runState: RunState | undefined;
    let latestAnatomy = base.context.anatomy;

    if (runs.length > 0) {
      const latestRun = runs[runs.length - 1]!;
      try {
        runState = (await deps.store.load(latestRun.id, signal)).state;
      } catch {
        runState = undefined;
      }
      try {
        const records = await deps.store.readModelCallEvents(latestRun.id);
        for (let i = records.length - 1; i >= 0; i -= 1) {
          const record = records[i]!;
          if (record.kind === 'requested' && record.anatomy !== undefined) {
            latestAnatomy = record.anatomy;
            break;
          }
        }
      } catch {
        // Leave anatomy as null if call records cannot be read.
      }
    }

    const categories = latestAnatomy !== null ? buildContextCategories(latestAnatomy) : [];
    const currentTokens = latestAnatomy !== null ? latestAnatomy.total : null;
    const utilization = currentTokens !== null && contextWindow !== null && contextWindow > 0 ? currentTokens / contextWindow : null;

    // Resolve active memories from loaded run state or pinned memories.
    const activeMemories: InspectorActiveMemory[] = [];
    if (runState?.memoriesLoaded !== undefined) {
      for (const loaded of runState.memoriesLoaded) {
        let view = viewById.get(loaded.id);
        if (view === undefined) {
          const rec = deps.store.memories.get(loaded.id);
          if (rec !== undefined) {
            view = redactMemoryView(await views.viewOf(rec, signal), redact);
          }
        }
        if (view === undefined) continue;
        const ev = summarizeMemoryEvidence(view.evidence);
        const traceCandidate = stateFromInspector.lastRetrievalTrace?.candidates.find((c) => c.id === view.id);
        activeMemories.push({
          id: view.id,
          kind: String(view.kind),
          scope: String(view.scope),
          origin: String(view.origin),
          state: String(view.state),
          status: view.status,
          summary: previewText(view.text, 100),
          text: view.text,
          tokens: tokensForText(view.text),
          createdAt: view.createdAt,
          keptAt: view.keptAt,
          contributedAt: view.contributedAt,
          evidence: {
            files: ev.files,
            ...(ev.commit === undefined ? {} : { commit: ev.commit }),
            checks: view.evidence.filter((item) => item.kind === 'check').length,
          },
          adoptionReason: traceCandidate?.reason ?? 'Recalled in session',
          pinned: pinnedMemoriesSet.has(view.id),
          excluded: excludedMemoriesSet.has(view.id),
        });
      }
    }

    // Build non-overlapping Context Explorer items from runState.
    const rawItems: Omit<InspectorContextItem, 'share'>[] = [];
    if (runState !== undefined) {
      const evictedSet = new Set<string>([...runState.evicted, ...excludedCallsSet]);
      for (const inst of runState.loadedInstructions) {
        const text = redact(inst.content);
        rawItems.push({
          id: `instruction:${inst.path}:${inst.seq}`,
          category: 'instructions',
          label: redact(inst.path),
          tokens: tokensForText(text),
          seq: inst.seq,
          source: redact(inst.path),
          cached: 'prefix',
          preview: previewText(text),
          excludable: false,
        });
      }
      for (const skill of runState.activatedSkills) {
        const text = redact(skill.content);
        rawItems.push({
          id: `skill:${skill.name}:${skill.seq}`,
          category: 'skills',
          label: `skill:${redact(skill.name)}`,
          tokens: tokensForText(text),
          seq: skill.seq,
          source: `skill:${redact(skill.name)}`,
          cached: 'prefix',
          preview: previewText(text),
          excludable: false,
        });
      }
      for (const mem of activeMemories) {
        rawItems.push({
          id: `memory:${mem.id}`,
          category: 'memories',
          label: `memory:${mem.kind}`,
          tokens: mem.tokens,
          addedAt: mem.keptAt,
          source: `memory:${mem.scope}`,
          cached: 'prefix',
          preview: mem.summary,
          excludable: false,
        });
      }
      if (runState.summary !== undefined) {
        const text = redact(runState.summary.summary);
        rawItems.push({
          id: `summary:${runState.summary.replacedThroughSeq}`,
          category: 'summary',
          label: `Compaction summary (through #${runState.summary.replacedThroughSeq})`,
          tokens: tokensForText(text),
          seq: runState.summary.replacedThroughSeq,
          source: 'compaction',
          cached: 'prefix',
          preview: previewText(text),
          excludable: false,
        });
      }
      for (const entry of runState.history) {
        if (runState.summary !== undefined && entry.seq <= runState.summary.replacedThroughSeq) continue;
        const text = redact(textOfInputItem(entry.item));
        const itemTokens = tokensForText(text);
        if (entry.item.type === 'message') {
          const category = entry.item.role === 'user' ? 'history.user' : 'history.assistant';
          rawItems.push({
            id: `msg:${entry.seq}`,
            category,
            label: `${entry.item.role} #${entry.seq}`,
            tokens: itemTokens,
            seq: entry.seq,
            source: entry.item.role,
            cached: 'dynamic',
            preview: previewText(text),
            excludable: false,
          });
        } else if (entry.item.type === 'function_call') {
          rawItems.push({
            id: `call:${entry.item.call_id}:${entry.seq}`,
            category: 'history.toolCalls',
            label: `${redact(entry.item.name)}() #${entry.seq}`,
            tokens: itemTokens,
            seq: entry.seq,
            source: redact(entry.item.name),
            cached: 'dynamic',
            preview: previewText(text),
            callId: entry.item.call_id,
            excludable: false,
          });
        } else if (entry.item.type === 'function_call_output') {
          const callId = entry.callId ?? entry.item.call_id;
          const isExcluded = evictedSet.has(callId);
          rawItems.push({
            id: `output:${callId}:${entry.seq}`,
            category: 'history.toolOutputs',
            label: `result:${callId} #${entry.seq}`,
            tokens: isExcluded ? 0 : itemTokens,
            seq: entry.seq,
            source: `tool:${callId}`,
            cached: 'dynamic',
            preview: isExcluded ? `[excluded/evicted${entry.handle === undefined ? '' : ` handle:${entry.handle}`}]` : previewText(text),
            callId,
            ...(entry.handle === undefined ? {} : { handle: entry.handle }),
            sizeBytes: Buffer.byteLength(text, 'utf8'),
            evicted: isExcluded,
            truncated: entry.handle !== undefined,
            excludable: true,
          });
        }
      }
    }

    const itemsTotal = rawItems.reduce((sum, item) => sum + item.tokens, 0);
    const shareDenominator = currentTokens !== null && currentTokens > 0 ? currentTokens : itemsTotal;
    const contextItems: InspectorContextItem[] = rawItems.map((item) => ({
      ...item,
      share: shareDenominator > 0 ? item.tokens / shareDenominator : 0,
    }));

    const evictedCallIds = [...new Set([...(runState?.evicted ?? []), ...stateFromInspector.excludedCallIds])];

    const suggestions: InspectorContextSuggestion[] = [];
    if (utilization !== null && utilization >= 0.75) {
      suggestions.push({
        id: 'suggest-compact',
        message: `Context usage is ${(utilization * 100).toFixed(1)}% — consider manual compaction.`,
        action: 'compact',
      });
    }
    if (shareDenominator > 0) {
      for (const item of contextItems) {
        if (item.category === 'history.toolOutputs' && !item.evicted && item.callId !== undefined && item.tokens / shareDenominator >= 0.1) {
          suggestions.push({
            id: `suggest-exclude:${item.callId}`,
            message: `${item.label} uses ${((item.tokens / shareDenominator) * 100).toFixed(1)}% of context (${item.tokens} tokens).`,
            savingsTokens: item.tokens,
            action: 'exclude_tool_output',
            callId: item.callId,
          });
        }
      }
    }

    // Merge lifecycle events from journal accumulator & inspector state.
    const lifecycleById = new Map<string, InspectorMemoryLifecycleEvent>();
    for (const ev of base.memory.lifecycle) lifecycleById.set(ev.id, ev);
    for (const ev of stateFromInspector.lifecycle) lifecycleById.set(ev.id, ev);
    const mergedLifecycle = [...lifecycleById.values()]
      .map((ev) => ({ ...ev, summary: redact(ev.summary), ...(ev.detail === undefined ? {} : { detail: redact(ev.detail) }) }))
      .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
      .slice(-INSPECTOR_MEMORY_LIFECYCLE_LIMIT);

    // Enrich Usage & Cache with server CostBreakdownView if gateway is reachable.
    let breakdown: CostBreakdownView | undefined;
    if (runs.length > 0) {
      try {
        const result = await deps.runCostBreakdown(
          runs.map((run) => ({ runId: run.id, sessionId: run.sessionId })),
          signal,
          false,
        );
        breakdown = result.breakdown;
      } catch {
        breakdown = undefined;
      }
    }

    const usageTotals =
      breakdown !== undefined && breakdown.calls > 0
        ? {
            inputTokens: Math.max(base.usage.totals.inputTokens, breakdown.billed.inputTokens),
            outputTokens: Math.max(base.usage.totals.outputTokens, breakdown.billed.outputTokens),
            totalTokens: Math.max(base.usage.totals.totalTokens, breakdown.billed.inputTokens + breakdown.billed.outputTokens),
            cachedInputTokens: breakdown.billed.cacheReadTokens ?? base.usage.totals.cachedInputTokens,
            cacheReadTokens: breakdown.billed.cacheReadTokens ?? base.usage.totals.cacheReadTokens,
            cacheWriteTokens: breakdown.billed.cacheWriteTokens ?? base.usage.totals.cacheWriteTokens,
            uncachedInputTokens: breakdown.billed.uncachedInputTokens ?? base.usage.totals.uncachedInputTokens,
            reasoningTokens: breakdown.billed.reasoningTokens > 0 || base.usage.totals.reasoningTokens === 0 ? breakdown.billed.reasoningTokens : base.usage.totals.reasoningTokens,
          }
        : base.usage.totals;

    const usageCache =
      breakdown !== undefined && breakdown.calls > 0
        ? {
            hitRatio: breakdown.cacheHitRatio ?? base.usage.cache.hitRatio,
            cacheReadNotReportedCalls: Math.max(base.usage.cache.cacheReadNotReportedCalls, breakdown.cacheReadNotReported),
            inconsistentUsageCalls: Math.max(base.usage.cache.inconsistentUsageCalls, breakdown.inconsistentUsage.length),
            cacheBreaks: Object.keys(breakdown.cacheBreaks).length > 0 ? breakdown.cacheBreaks : base.usage.cache.cacheBreaks,
            cacheMissCauses: Object.keys(breakdown.cacheMissCauses).length > 0 ? breakdown.cacheMissCauses : base.usage.cache.cacheMissCauses,
            estimatedSavingsUsd: base.usage.cache.estimatedSavingsUsd,
            savingsBasis: base.usage.cache.savingsBasis,
          }
        : base.usage.cache;

    const usageCost =
      breakdown !== undefined && breakdown.calls > 0
        ? {
            ...base.usage.cost,
            totalUsd: breakdown.cost.amount ?? base.usage.cost.totalUsd,
            unpricedCalls: Math.max(base.usage.cost.unpricedCalls, breakdown.cost.unpricedCalls),
            unpricedReasons:
              breakdown.unpriced.length > 0
                ? [...new Set([...base.usage.cost.unpricedReasons, ...breakdown.unpriced.map((entry) => redact(entry.reason))])]
                : base.usage.cost.unpricedReasons,
          }
        : base.usage.cost;

    const toolCallsWithSandbox = base.execution.toolCalls.map((call) => ({
      ...call,
      sandbox: call.sandbox ?? sandbox,
    }));

    const requirements = requirementsOfEvents(allRunEvents).map(redact);

    const assembled: InspectorSnapshot = {
      session: {
        ...base.session,
        sandbox,
        contextWindow,
      },
      agent: base.agent,
      context: {
        currentTokens,
        contextWindow,
        utilization,
        anatomy: latestAnatomy,
        categories,
        items: contextItems,
        compactions: base.context.compactions,
        suggestions,
        evictedCallIds,
        toolDefinitionTokens: base.context.toolDefinitionTokens,
      },
      memory: {
        active: activeMemories,
        retrievalTrace: stateFromInspector.lastRetrievalTrace,
        lifecycle: mergedLifecycle,
        sessionControls: {
          excludedIds: stateFromInspector.excludedMemoryIds,
          pinnedIds: stateFromInspector.pinnedMemoryIds,
        },
        allMemories: visibleViews,
      },
      usage: {
        totals: usageTotals,
        cache: usageCache,
        cost: usageCost,
        requests: base.usage.requests,
      },
      execution: {
        ...base.execution,
        toolCalls: toolCallsWithSandbox,
        requirements,
      },
      diagnostics: [],
      meta: {
        capturedAt: deps.clock.now(),
        eventCount: base.meta.eventCount,
        droppedEvents: base.meta.droppedEvents,
        bufferLimit: INSPECTOR_EVENT_BUFFER_LIMIT,
        liveConnected: true,
      },
    };

    return {
      ...assembled,
      diagnostics: evaluateDiagnostics(assembled),
    };
  };

  const getInspector: Handler = async (context) => {
    const session = requireSession(context);
    return json(await buildSnapshot(session, boundOf(context)));
  };

  const excludeContextItem: Handler = async (context) => {
    const session = requireSession(context);
    const body = bodyOf(validateExclude, await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    deps.inspectorState.setCallExcluded(session.id, body.callId, body.excluded);
    return json(await buildSnapshot(session, boundOf(context)));
  };

  const controlMemory: Handler = async (context) => {
    const session = requireSession(context);
    const body = bodyOf(validateMemoryControl, await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const memory = deps.store.memories.get(body.memoryId);
    if (memory === undefined) throw notFound(`memory ${body.memoryId} does not exist`);
    const redact = sessionRedactFn(deps.redactor, session);
    deps.inspectorState.applyMemoryControl(session.id, memory.id, previewText(redact(memory.text), 100), body.action);
    return json(await buildSnapshot(session, boundOf(context)));
  };

  const searchMemories: Handler = async (context) => {
    const session = requireSession(context);
    const signal = boundOf(context);
    const redact = sessionRedactFn(deps.redactor, session);
    const body = bodyOf(validateMemorySearch, await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const startMs = deps.clock.now();
    const trusted = (await deps.store.trust.decisionAsked(session.cwd, signal)).decision === 'trusted';
    const visibility: MemoryVisibility = trusted ? { trusted: true, project: session.cwd } : { trusted: false };
    const terms = termsOfQuery(body.query);
    const through = deps.store.memories.watermark();
    const matchedSet = typeof deps.store.memories.matchingIds === 'function' ? deps.store.memories.matchingIds(visibility, terms) : new Set<string>();
    const overrides = deps.inspectorState.getOverrides(session.id);
    const excludedSet = new Set(overrides.excludedMemoryIds);
    const pinnedSet = new Set(overrides.pinnedMemoryIds);

    const candidates: InspectorRetrievalCandidate[] = [];
    let after: RecallCursor | null = null;
    let matchCapped = false;
    let usedTokens = 0;

    for (;;) {
      const page = deps.store.memories.recallPage(visibility, { terms, after, limit: MEMORY_PAGE_ROWS, through });
      matchCapped = page.matchCapped;
      const pageViews = await views.viewsOf(page.memories, signal);
      for (const view of pageViews) {
        const text = redact(view.text);
        const tokens = tokensForText(text);
        const sessionExcluded = excludedSet.has(view.id);
        const matched = matchedSet.has(view.id);
        const tier = matched ? 1 : 2;
        const decision: 'included' | 'excluded' = sessionExcluded ? 'excluded' : matched || terms.length === 0 ? 'included' : 'excluded';
        const reason = sessionExcluded ? 'session_excluded' : matched ? 'query_match' : terms.length === 0 ? 'all_visible' : 'no_term_match';
        if (decision === 'included') usedTokens += tokens;
        candidates.push({
          id: view.id,
          summary: previewText(text, 100),
          kind: String(view.kind),
          status: view.status,
          matched,
          tier,
          rank: candidates.length + 1,
          tokens,
          decision,
          reason,
          pinned: pinnedSet.has(view.id),
          sessionExcluded,
        });
      }
      if (page.next === null || candidates.length >= MEMORY_MATCH_LIMIT) break;
      after = page.next;
    }

    const endMs = deps.clock.now();
    const trace: InspectorMemoryRetrievalTrace = {
      query: body.query,
      terms,
      executedAt: endMs,
      latencyMs: Math.max(0, endMs - startMs),
      budgetTokens: null,
      usedTokens,
      matchCapped,
      touchedCap: null,
      moreAvailable: after !== null,
      candidateCount: candidates.length,
      selectedCount: candidates.filter((c) => c.decision === 'included').length,
      candidates,
    };
    const response: InspectorMemorySearchResponse = { trace };
    return json(response);
  };

  route('/v1/sessions/:id/inspector', { GET: getInspector });
  route('/v1/sessions/:id/inspector/context/exclude', { POST: excludeContextItem }, { person: ['POST'] });
  route('/v1/sessions/:id/inspector/memory/control', { POST: controlMemory }, { person: ['POST'] });
  route('/v1/sessions/:id/inspector/memory/search', { POST: searchMemories });
};
