import { recallOrder } from '@momonga/memory';
import type { MemoryRecord, MemoryView } from '@momonga/protocol';
import { MEMORY_SEARCH_RESULT_LIMIT, ToolExecutionError, createMemoryTools } from '@momonga/tools';
import type { MemoryStorePort } from '@momonga/tools';
import type { MemoryVisibility, RuntimeStore, Session } from '@momonga/store';
import { bindMemoryEvidence, createEvidencePorts, readGitHead } from '../memory/evidence.ts';
import type { EvidenceRun } from '../memory/evidence.ts';
import { termsOfQuery } from '../memory/recall-query.ts';
import { memoryViewOf } from '../memory/views.ts';
import type { MemoryPort, SettingsPort } from '../ports.ts';
import { readAllRunEvents } from './run-events.ts';

export type MemoryPortOptions = {
  store: Pick<RuntimeStore, 'memories' | 'readRunEvents'>;
  settings: Pick<SettingsPort, 'trusted' | 'verification'>;
  evidenceRun: (session: Session) => EvidenceRun;
};

export const createMemoryPort = ({ store, settings, evidenceRun }: MemoryPortOptions): MemoryPort => ({
  load: async (session) => {
    const trusted = settings.trusted(session);
    const visibility: MemoryVisibility = trusted ? { trusted: true, project: session.cwd } : { trusted: false };
    const evidenceOptions = { project: session.cwd, trusted, run: evidenceRun(session) };
    const ports = createEvidencePorts(evidenceOptions);
    const viewOf = (record: MemoryRecord): Promise<MemoryView> => memoryViewOf(record, { project: session.cwd, trusted, ports });
    const replaceable = (ids: readonly string[]): void => {
      const known = new Set(store.memories.search(visibility, [], { include: 'all' }).map((memory) => memory.id));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length > 0) throw new ToolExecutionError(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not saved memories you can replace`);
    };
    const toolPort: MemoryStorePort = {
      save: async ({ scope, text, runId, step, callId, kind, paths, supersedes }) => {
        replaceable(supersedes ?? []);
        const evidence =
          paths === undefined || paths.length === 0
            ? []
            : await bindMemoryEvidence({
                runId,
                events: readAllRunEvents(store, runId),
                paths,
                project: session.cwd,
                trusted,
                verificationCommands: (await settings.verification(session)).commands,
                head: () => readGitHead(evidenceOptions),
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
        return { memory: await viewOf(saved.memory), created: saved.created };
      },
      search: async (terms, { include }) => {
        const views = await Promise.all(store.memories.search(visibility, terms, { include }).map(viewOf));
        const ordered = recallOrder(views, new Set(views.map((memory) => memory.id)));
        store.memories.markUsed(ordered.slice(0, MEMORY_SEARCH_RESULT_LIMIT).map((memory) => memory.id));
        return ordered;
      },
    };
    const recalled = await Promise.all(store.memories.recall(visibility).map(viewOf));
    return {
      memories: recalled,
      rank: (query) => recallOrder(recalled, store.memories.matchingIds(visibility, termsOfQuery(query))),
      tools: createMemoryTools({ port: toolPort, trusted }),
      markUsed: (ids) => store.memories.markUsed(ids),
    };
  },
});
