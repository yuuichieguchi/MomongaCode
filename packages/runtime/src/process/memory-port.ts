import { ESTIMATED_ERROR_BOUND_RATIO, sizingRatioFor, tokensForText } from '@momonga/protocol';
import type { MemoryRecord, MemoryScope, MemoryView } from '@momonga/protocol';
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
  store: Pick<RuntimeStore, 'memories' | 'journalFacts' | 'trust'>;
  settings: Pick<SettingsPort, 'trusted' | 'verification'>;
  evidenceRun: (project: string) => EvidenceRun;
  evidencePorts?: (options: EvidencePortsOptions) => EvidencePorts;
};

export const recallPrefixBudgetOf = (capacity: RecallCapacity): number => memoryBudgetFor(inputCeilingFor(capacity.capabilities), capacity.memoryShare);

export const recallPrefixTokensOf = (text: string, capacity: RecallCapacity): number =>
  Math.floor(tokensForText(text) / (1 + Math.max(sizingRatioFor(capacity.capabilities), ESTIMATED_ERROR_BOUND_RATIO)));

const visibleTo = (memory: MemoryRecord, visibility: MemoryVisibility): boolean =>
  visibility.trusted ? (memory.scope === 'user' && memory.origin === 'trusted') || (memory.scope === 'project' && memory.project === visibility.project) : memory.scope === 'user';

export const createMemoryPort = ({ store, settings, evidenceRun, evidencePorts = createEvidencePorts }: MemoryPortOptions): MemoryPort => ({
  load: async (session, signal) => {
    const trusted = settings.trusted(session);
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
        const { commands: verificationCommands } = await settings.verification(session);
        const evidence = await bindMemoryEvidence({
          scope,
          paths: paths ?? [],
          project: scope === 'project' ? session.cwd : null,
          trusted,
          facts: async (resolved) => runFactsOf(runId, await store.journalFacts.evidence({ runId, paths: resolved, verificationCommands }, bound)),
          head: () => readGitHead(evidenceOptionsFor(bound)),
        });
        const saved = store.memories.save({
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
    return {
      prepare: async ({ query, capacity, pinnedIds = [] }) => {
        const budget = recallPrefixBudgetOf(capacity);
        const terms = termsOfQuery(query);
        const read: MemoryView[] = [];
        let tokens = 0;
        let after: RecallCursor | null = null;
        let hasMore = false;
        let matchCapped = false;
        reading: for (;;) {
          const page = store.memories.recallPage(visibility, { terms, after, limit: MEMORY_PAGE_ROWS, through });
          matchCapped = page.matchCapped;
          for (const [index, record] of page.memories.entries()) {
            const [view] = await viewsOf([record], signal);
            if (view === undefined) throw new Error(`memory ${record.id} produced no view`);
            read.push(view);
            tokens += recallPrefixTokensOf(record.text, capacity);
            if (tokens >= budget) {
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
          const record = readIds.has(id) ? undefined : store.memories.get(id);
          if (record !== undefined) outside.push(record);
        }
        pinnedOutside = await viewsOf(outside, signal);
        prefix = read;
        more = hasMore;
        capped = matchCapped;
      },
      ranked: () => [...prefix, ...pinnedOutside],
      hasMore: () => more,
      matchCap: () => (capped ? MEMORY_MATCH_LIMIT : undefined),
      tools: createMemoryTools({ port: toolPort, trusted }),
    };
  },
});
