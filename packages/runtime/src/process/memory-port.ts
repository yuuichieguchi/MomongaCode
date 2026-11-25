import type { Clock } from '@momonga/foundation';
import { ESTIMATED_ERROR_BOUND_RATIO, sizingRatioFor, tokensForText } from '@momonga/protocol';
import type { InspectorMemoryRetrievalTrace, InspectorRetrievalCandidate, MemoryRecord, MemoryScope, MemoryView } from '@momonga/protocol';
import { inputCeilingFor, memoryBudgetFor } from '@momonga/context';
import { recallOrder } from '@momonga/memory';
import { MEMORY_MATCH_LIMIT } from '@momonga/store';
import type { MemoryVisibility, RecallCursor, RuntimeStore } from '@momonga/store';
import { ToolExecutionError, createMemoryTools } from '@momonga/tools';
import type { MemoryStorePort } from '@momonga/tools';
import { bindMemoryEvidence, createEvidencePorts, readGitHead, runFactsOf } from '../memory/evidence.ts';
import type { EvidencePortsOptions, EvidenceRun } from '../memory/evidence.ts';
import type { EvidencePorts } from '@momonga/memory';
import { termsOfQuery } from '../memory/recall-query.ts';
import { withValidity } from '../memory/validity-view.ts';
import { createRecordViews } from '../memory/views.ts';
import type { MemoryPort, RecallCapacity, SettingsPort } from '../ports.ts';
import { MEMORY_PAGE_ROWS } from './constants.ts';

export type MemoryPortOptions = {
  platform: NodeJS.Platform;
  store: Pick<RuntimeStore, 'memories' | 'journalFacts' | 'trust'>;
  settings: Pick<SettingsPort, 'trusted'>;
  evidenceRun: (project: string) => EvidenceRun;
  evidencePorts?: (options: EvidencePortsOptions) => EvidencePorts;
  clock?: Clock;
};

export const recallPrefixBudgetOf = (capacity: RecallCapacity): number => memoryBudgetFor(inputCeilingFor(capacity.capabilities), capacity.memoryShare);

export const recallPrefixTokensOf = (text: string, capacity: RecallCapacity): number =>
  Math.floor(tokensForText(text) / (1 + Math.max(sizingRatioFor(capacity.capabilities), ESTIMATED_ERROR_BOUND_RATIO)));

const visibleTo = (memory: MemoryRecord, visibility: MemoryVisibility): boolean =>
  visibility.trusted ? (memory.scope === 'user' && memory.origin === 'trusted') || (memory.scope === 'project' && memory.project === visibility.project) : memory.scope === 'user';

export const createMemoryPort = ({ platform, store, settings, evidenceRun, evidencePorts = createEvidencePorts, clock }: MemoryPortOptions): MemoryPort => ({
  load: async (session, signal) => {
    const trusted = await settings.trusted(session, signal);
    const visibility: MemoryVisibility = trusted ? { trusted: true, project: session.cwd } : { trusted: false };
    const run = evidenceRun(session.cwd);
    const recordViews = createRecordViews({ store, evidenceRun, evidencePorts });
    const evidenceOptionsFor = (bound: AbortSignal) => ({ project: session.cwd, trusted, run, signal: bound });
    const through = store.memories.watermark();
    const checked = new Map<string, MemoryView>();
    const readings = new WeakMap<AbortSignal, ReturnType<typeof recordViews.reading>>();
    const viewsOf = async (records: readonly MemoryRecord[], bound: AbortSignal): Promise<MemoryView[]> => {
      const known = readings.get(bound);
      const reading = known ?? recordViews.reading(bound);
      readings.set(bound, reading);
      const views: MemoryView[] = [];
      for (const record of records) {
        const seen = checked.get(record.id);
        if (seen !== undefined) {
          views.push(seen);
          continue;
        }
        const view = await reading.viewOf(record);
        checked.set(record.id, view);
        views.push(view);
      }
      return views;
    };
    const originOf = trusted ? 'trusted' : 'untrusted';
    const replaceable = (ids: readonly string[], scope: MemoryScope): void => {
      const project = scope === 'project' ? session.cwd : null;
      const unknown = ids.filter((id) => {
        const memory = store.memories.get(id);
        return !(
          memory !== undefined &&
          visibleTo(memory, visibility) &&
          memory.scope === scope &&
          memory.project === project &&
          (memory.origin === originOf || memory.origin === 'untrusted')
        );
      });
      if (unknown.length > 0) throw new ToolExecutionError(`${unknown.join(', ')} ${unknown.length === 1 ? 'is not a saved memory' : 'are not saved memories'} you can replace`);
    };
    const toolPort: MemoryStorePort = {
      save: async ({ scope, text, runId, step, callId, kind, paths, supersedes, signal: bound }) => {
        replaceable(supersedes ?? [], scope);
        const evidence = await bindMemoryEvidence({
          platform,
          scope,
          paths: paths ?? [],
          project: scope === 'project' ? session.cwd : null,
          trusted,
          facts: async (resolved) => runFactsOf(runId, await store.journalFacts.evidence({ runId, paths: resolved }, bound)),
          head: () => readGitHead(evidenceOptionsFor(bound)),
        });
        const saved = await store.memories.save({
          scope,
          origin: trusted ? 'trusted' : 'untrusted',
          project: scope === 'project' ? session.cwd : null,
          text,
          runId,
          step,
          callId,
          evidence,
          ...(kind === undefined ? {} : { kind }),
          ...(supersedes === undefined ? {} : { supersedes }),
        });
        const [view] = await viewsOf([saved.memory], bound);
        if (view === undefined) throw new Error(`memory ${saved.memory.id} produced no view`);
        return { memory: view, created: saved.created };
      },
      search: async (terms, { include, limit, signal: bound }) => {
        const views = await viewsOf(store.memories.search(visibility, terms, { include, limit }), bound);
        const ordered = recallOrder(views, new Set(views.map((memory) => memory.id)));
        return include === 'all' ? ordered.map((view) => withValidity(store, view)) : ordered;
      },
    };
    let prefix: MemoryView[] = [];
    let pinnedOutside: MemoryView[] = [];
    let more = false;
    let capped = false;
    let touchedBound: number | undefined;
    let trace: InspectorMemoryRetrievalTrace | undefined;
    return {
      prepare: async ({ query, capacity, pinnedIds = [], excludeIds = [], prioritizeIds = [], touchedCap }) => {
        const startMs = clock?.now();
        const budget = recallPrefixBudgetOf(capacity);
        const terms = termsOfQuery(query);
        const excludedSet = new Set(excludeIds);
        const prioritizedSet = new Set(prioritizeIds);
        const pinnedSet = new Set(pinnedIds);
        const matchedSet = typeof store.memories.matchingIds === 'function' ? store.memories.matchingIds(visibility, terms) : new Set<string>();
        const read: MemoryView[] = [];
        const candidates: InspectorRetrievalCandidate[] = [];
        const seenCandidateIds = new Set<string>();
        let tokens = 0;
        let after: RecallCursor | null = null;
        let hasMore = false;
        let matchCapped = false;

        const addCandidate = (
          entry: { readonly id: string; readonly text: string; readonly kind: unknown; readonly status: MemoryView['status'] },
          tier: number,
          itemTokens: number,
          decision: 'included' | 'excluded',
          reason: string,
        ): void => {
          if (seenCandidateIds.has(entry.id)) return;
          seenCandidateIds.add(entry.id);
          candidates.push({
            id: entry.id,
            summary: entry.text.replace(/\s+/g, ' ').trim().slice(0, 100),
            kind: String(entry.kind),
            status: entry.status,
            matched: matchedSet.has(entry.id),
            tier,
            rank: candidates.length + 1,
            tokens: itemTokens,
            decision,
            reason,
            pinned: pinnedSet.has(entry.id) || prioritizedSet.has(entry.id),
            sessionExcluded: excludedSet.has(entry.id),
          });
        };

        const addExcludedRecord = (record: MemoryRecord, tier: number, reason: string): void => {
          const status: MemoryView['status'] =
            record.observedStatus === null || record.observedStatus === 'unknown' ? 'unbound' : record.observedStatus;
          addCandidate(
            { id: record.id, text: record.text, kind: record.kind, status },
            tier,
            recallPrefixTokensOf(record.text, capacity),
            'excluded',
            reason,
          );
        };

        // Session-prioritized memories are evaluated first within budget.
        for (const id of prioritizeIds) {
          if (excludedSet.has(id) || seenCandidateIds.has(id)) continue;
          const record = store.memories.get(id);
          if (record === undefined || !visibleTo(record, visibility) || record.state !== 'active' || record.retiredAt !== null) continue;
          const [view] = await viewsOf([record], signal);
          if (view === undefined) continue;
          const itemTokens = recallPrefixTokensOf(record.text, capacity);
          read.push(view);
          tokens += itemTokens;
          addCandidate(view, 0, itemTokens, 'included', 'session_prioritized');
        }

        reading: for (;;) {
          const page = store.memories.recallPage(visibility, { terms, after, limit: MEMORY_PAGE_ROWS, through });
          matchCapped = page.matchCapped;
          for (const [index, record] of page.memories.entries()) {
            if (seenCandidateIds.has(record.id)) continue;
            const itemTokens = recallPrefixTokensOf(record.text, capacity);
            const tier = matchedSet.has(record.id) ? 1 : 2;
            if (excludedSet.has(record.id)) {
              addExcludedRecord(record, tier, 'session_excluded');
              continue;
            }
            if (tokens < budget || read.length === 0) {
              const [view] = await viewsOf([record], signal);
              if (view === undefined) throw new Error(`memory ${record.id} produced no view`);
              read.push(view);
              tokens += itemTokens;
              addCandidate(view, tier, itemTokens, 'included', matchedSet.has(record.id) ? 'query_match' : 'recency_fill');
            } else {
              addExcludedRecord(record, tier, 'budget_exceeded');
              for (const tail of page.memories.slice(index + 1, index + 9)) {
                if (seenCandidateIds.has(tail.id)) continue;
                const tailTier = matchedSet.has(tail.id) ? 1 : 2;
                addExcludedRecord(tail, tailTier, excludedSet.has(tail.id) ? 'session_excluded' : 'budget_exceeded');
              }
              hasMore = index < page.memories.length - 1 || page.next !== null;
              break reading;
            }
            if (tokens >= budget) {
              for (const tail of page.memories.slice(index + 1, index + 9)) {
                if (seenCandidateIds.has(tail.id)) continue;
                const tailTier = matchedSet.has(tail.id) ? 1 : 2;
                addExcludedRecord(tail, tailTier, excludedSet.has(tail.id) ? 'session_excluded' : 'budget_exceeded');
              }
              hasMore = index < page.memories.length - 1 || page.next !== null;
              break reading;
            }
          }
          if (page.next === null) break;
          after = page.next;
        }
        const readIds = new Set(read.map((view) => view.id));
        const outside: MemoryRecord[] = [];
        for (const id of pinnedIds) {
          if (excludedSet.has(id)) continue;
          const record = readIds.has(id) ? undefined : store.memories.get(id);
          if (record !== undefined) outside.push(record);
        }
        pinnedOutside = await viewsOf(outside, signal);
        for (const view of pinnedOutside) {
          addCandidate(view, 0, recallPrefixTokensOf(view.text, capacity), 'included', 'cache_prefix_pinned');
        }
        prefix = read;
        more = hasMore;
        capped = matchCapped;
        touchedBound = touchedCap;
        const endMs = clock?.now();
        trace = {
          query,
          terms,
          executedAt: endMs ?? 0,
          latencyMs: startMs !== undefined && endMs !== undefined ? Math.max(0, endMs - startMs) : null,
          budgetTokens: budget,
          usedTokens: tokens,
          matchCapped,
          touchedCap: touchedCap ?? null,
          moreAvailable: hasMore,
          candidateCount: candidates.length,
          selectedCount: candidates.filter((c) => c.decision === 'included').length,
          candidates,
        };
      },
      ranked: () => [...prefix, ...pinnedOutside],
      hasMore: () => more,
      matchCap: () => (capped ? MEMORY_MATCH_LIMIT : undefined),
      touchedCap: () => touchedBound,
      lastTrace: () => trace,
      tools: createMemoryTools({ port: toolPort, trusted }),
    };
  },
});
