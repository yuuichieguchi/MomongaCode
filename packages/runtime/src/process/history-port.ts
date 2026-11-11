import { hostPaths, mapAsync } from '@momonga/foundation';
import type { Clock, Redactor, RuleEnforcement } from '@momonga/foundation';
import { permissionRulesFor } from '../governance/rules.ts';
import { createHistoryTools, createReadDenial } from '@momonga/tools';
import type { HistoryStorePort, ReadDenial } from '@momonga/tools';
import { HISTORY_READ_PAGE_EVENTS } from '@momonga/store';
import type { HistoryVisibility, RuntimeStore } from '@momonga/store';
import type { HistoryPort, SettingsPort } from '../ports.ts';

export type HistoryPortOptions = {
  store: Pick<RuntimeStore, 'search' | 'governing'>;
  settings: Pick<SettingsPort, 'trusted' | 'rules'>;
  clock: Clock;
  home: string;
  redactor: Redactor;
  enforcement: () => RuleEnforcement;
};

export const createHistoryPort = ({ store, settings, clock, home, redactor, enforcement }: HistoryPortOptions): HistoryPort => ({
  load: (session) => {
    const trusted = settings.trusted(session);
    const visibility: HistoryVisibility = { trusted, project: session.cwd };
    const denialFor = async (project: string, signal: AbortSignal): Promise<ReadDenial> => {
      const own = project === session.cwd;
      const rules = await permissionRulesFor({ store, settings, clock, home }, own ? session : { ...session, cwd: project, additionalDirectories: [] });
      const roots = own ? [session.cwd, ...session.additionalDirectories] : [project];
      return createReadDenial({ rules, roots: await mapAsync(roots, hostPaths(signal).canonicalPath), cwd: project, enforcement: enforcement(), signal });
    };
    const toolPort: HistoryStorePort = {
      search: async (request, signal) => {
        const projects = store.search.visibleProjects(visibility, request.scope);
        const denials = new Map(await Promise.all(projects.map(async (project) => [project, await denialFor(project, signal)] as const)));
        const denialOf = (project: string): ReadDenial => {
          const denial = denials.get(project);
          if (denial === undefined) throw new Error(`no read denial was built for project ${project}`);
          return denial;
        };
        const verdicts = new Map<string, boolean>();
        const keyOf = (target: string, project: string): string => JSON.stringify([project, target]);
        for (;;) {
          const unanswered: Array<{ target: string; project: string }> = [];
          const result = store.search.query(visibility, {
            ...request,
            readDenied: (target, project) => {
              const verdict = verdicts.get(keyOf(target, project));
              if (verdict !== undefined) return verdict;
              unanswered.push({ target, project });
              return false;
            },
          });
          if (unanswered.length === 0) return result;
          for (const { target, project } of unanswered) verdicts.set(keyOf(target, project), await denialOf(project)(target));
        }
      },
      read: async (request) => {
        const result = await store.search.readRange(visibility, { ...request, limit: HISTORY_READ_PAGE_EVENTS, redactor });
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
