import { canonicalPath } from '@momonga/foundation';
import type { Redactor } from '@momonga/foundation';
import { createHistoryTools, createReadDenial } from '@momonga/tools';
import type { HistoryStorePort, ReadDenial } from '@momonga/tools';
import { HISTORY_READ_PAGE_EVENTS } from '@momonga/store';
import type { HistoryVisibility, RuntimeStore } from '@momonga/store';
import type { HistoryPort, SettingsPort } from '../ports.ts';

export type HistoryPortOptions = {
  store: Pick<RuntimeStore, 'search'>;
  settings: Pick<SettingsPort, 'trusted' | 'rules'>;
  redactor: Redactor;
};

export const createHistoryPort = ({ store, settings, redactor }: HistoryPortOptions): HistoryPort => ({
  load: (session) => {
    const trusted = settings.trusted(session);
    const visibility: HistoryVisibility = { trusted, project: session.cwd };
    const denialFor = async (project: string): Promise<ReadDenial> => {
      const own = project === session.cwd;
      const rules = await settings.rules(own ? session : { ...session, cwd: project, additionalDirectories: [] });
      const roots = own ? [session.cwd, ...session.additionalDirectories] : [project];
      return createReadDenial({ rules, roots: roots.map(canonicalPath), cwd: project });
    };
    const toolPort: HistoryStorePort = {
      search: async (request) => {
        const projects = store.search.visibleProjects(visibility, request.scope);
        const denials = new Map(await Promise.all(projects.map(async (project) => [project, await denialFor(project)] as const)));
        return store.search.query(visibility, {
          ...request,
          readDenied: (target, project) => {
            const denial = denials.get(project);
            if (denial === undefined) throw new Error(`no read denial was built for project ${project}`);
            return denial(target);
          },
        });
      },
      read: (request) => {
        const result = store.search.readRange(visibility, { ...request, limit: HISTORY_READ_PAGE_EVENTS, redactor });
        if (result.kind === 'not_visible') return null;
        return { runId: result.runId, project: result.project, origin: result.origin, events: result.events, callPaths: result.callPaths, nextSeq: result.nextSeq };
      },
      projectOf: (runId) => store.search.projectOf(visibility, runId),
      readDenial: denialFor,
      redact: (text) => redactor.whole(text),
    };
    return { tools: createHistoryTools({ port: toolPort, trusted, project: session.cwd }) };
  },
});
