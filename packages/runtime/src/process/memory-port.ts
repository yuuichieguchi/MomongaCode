import { MEMORY_SEARCH_RESULT_LIMIT, createMemoryTools } from '@momonga/tools';
import type { MemoryStorePort } from '@momonga/tools';
import type { MemoryVisibility, RuntimeStore } from '@momonga/store';
import type { MemoryPort, SettingsPort } from '../ports.ts';

export type MemoryPortOptions = { store: Pick<RuntimeStore, 'memories'>; settings: Pick<SettingsPort, 'trusted'> };

export const createMemoryPort = ({ store, settings }: MemoryPortOptions): MemoryPort => ({
  load: (session) => {
    const trusted = settings.trusted(session);
    const visibility: MemoryVisibility = trusted ? { trusted: true, project: session.cwd } : { trusted: false };
    const toolPort: MemoryStorePort = {
      save: ({ scope, text, runId, step, callId }) =>
        store.memories.save({ scope, origin: trusted ? 'trusted' : 'untrusted', project: scope === 'project' ? session.cwd : null, text, runId, step, callId }),
      search: (terms) => {
        const found = store.memories.search(visibility, terms);
        store.memories.markUsed(found.slice(0, MEMORY_SEARCH_RESULT_LIMIT).map((memory) => memory.id));
        return found;
      },
    };
    return {
      memories: store.memories.recall(visibility),
      tools: createMemoryTools({ port: toolPort, trusted }),
      markUsed: (ids) => store.memories.markUsed(ids),
    };
  },
});
