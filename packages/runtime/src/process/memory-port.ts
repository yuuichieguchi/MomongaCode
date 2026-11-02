import { MEMORY_SEARCH_RESULT_LIMIT, createMemoryTools } from '@momonga/tools';
import type { MemoryStorePort } from '@momonga/tools';
import type { RuntimeStore } from '@momonga/store';
import type { MemoryPort, SettingsPort } from '../ports.ts';

export type MemoryPortOptions = { store: Pick<RuntimeStore, 'memories'>; settings: Pick<SettingsPort, 'trusted'> };

export const createMemoryPort = ({ store, settings }: MemoryPortOptions): MemoryPort => ({
  load: (session) => {
    const trusted = settings.trusted(session);
    const project = trusted ? session.cwd : undefined;
    const toolPort: MemoryStorePort = {
      save: ({ scope, text, runId, step, callId }) =>
        store.memories.save({ scope, project: scope === 'project' ? session.cwd : null, text, runId, step, callId }),
      search: (terms) => {
        const found = store.memories.search(project, terms);
        store.memories.markUsed(found.slice(0, MEMORY_SEARCH_RESULT_LIMIT).map((memory) => memory.id));
        return found;
      },
    };
    return {
      memories: store.memories.recall(project),
      tools: createMemoryTools({ port: toolPort, trusted }),
      markUsed: (ids) => store.memories.markUsed(ids),
    };
  },
});
