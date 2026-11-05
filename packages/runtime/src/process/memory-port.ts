import { recallOrder } from '@momonga/memory';
import type { MemoryRecord, MemoryScope, MemoryView } from '@momonga/protocol';
import { MEMORY_SEARCH_RESULT_LIMIT, ToolExecutionError, createMemoryTools } from '@momonga/tools';
import type { MemoryStorePort } from '@momonga/tools';
import type { MemoryVisibility, RuntimeStore, Session } from '@momonga/store';
import { bindMemoryEvidence, createEvidencePorts, readGitHead } from '../memory/evidence.ts';
import type { EvidenceRun } from '../memory/evidence.ts';
import { termsOfQuery } from '../memory/recall-query.ts';
import { memoryViewOf } from '../memory/views.ts';
import type { MemoryPort, SettingsPort } from '../ports.ts';

export type MemoryPortOptions = {
  store: Pick<RuntimeStore, 'memories' | 'journalFacts'>;
  settings: Pick<SettingsPort, 'trusted' | 'verification'>;
  evidenceRun: (session: Session) => EvidenceRun;
};

export const createMemoryPort = ({ store, settings, evidenceRun }: MemoryPortOptions): MemoryPort => ({
  load: async (session, signal) => {
    const trusted = settings.trusted(session);
    const visibility: MemoryVisibility = trusted ? { trusted: true, project: session.cwd } : { trusted: false };
    const run = evidenceRun(session);
    const evidenceOptionsFor = (bound: AbortSignal) => ({ project: session.cwd, trusted, run, signal: bound });
    const viewsOf = (records: readonly MemoryRecord[], bound: AbortSignal): Promise<MemoryView[]> => {
      const ports = createEvidencePorts(evidenceOptionsFor(bound));
      return Promise.all(records.map((record) => memoryViewOf(record, { project: session.cwd, trusted, ports })));
    };
    const originOf = trusted ? 'trusted' : 'untrusted';
    const replaceable = (ids: readonly string[], scope: MemoryScope): void => {
      const project = scope === 'project' ? session.cwd : null;
      const known = new Set(
        store.memories
          .search(visibility, [], { include: 'all' })
          .filter((memory) => memory.scope === scope && memory.project === project && (memory.origin === originOf || memory.origin === 'untrusted'))
          .map((memory) => memory.id),
      );
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length > 0) throw new ToolExecutionError(`${unknown.join(', ')} ${unknown.length === 1 ? 'is not a saved memory' : 'are not saved memories'} you can replace`);
    };
    const toolPort: MemoryStorePort = {
      save: async ({ scope, text, runId, step, callId, kind, paths, supersedes, signal: bound }) => {
        replaceable(supersedes ?? [], scope);
        const { commands: verificationCommands } = await settings.verification(session);
        const evidence = await bindMemoryEvidence({
          runId,
          paths: paths ?? [],
          project: session.cwd,
          trusted,
          journal: (resolved) => store.journalFacts.evidence({ runId, paths: resolved, verificationCommands }, bound),
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
      search: async (terms, { include, signal: bound }) => {
        const views = await viewsOf(store.memories.search(visibility, terms, { include }), bound);
        const ordered = recallOrder(views, new Set(views.map((memory) => memory.id)));
        store.memories.markUsed(ordered.slice(0, MEMORY_SEARCH_RESULT_LIMIT).map((memory) => memory.id));
        return ordered;
      },
    };
    const recalled = await viewsOf(store.memories.recall(visibility), signal);
    return {
      memories: recalled,
      rank: (query) => recallOrder(recalled, store.memories.matchingIds(visibility, termsOfQuery(query))),
      tools: createMemoryTools({ port: toolPort, trusted }),
      markUsed: (ids) => store.memories.markUsed(ids),
    };
  },
});
