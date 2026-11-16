import { createAgentLoader } from '@momonga/agents';
import { projectAgentDigestOf } from '@momonga/config';
import { settledOrAborted } from '@momonga/foundation';
import type { ChildRuns, ProjectAgentApproved } from '@momonga/agents';
import type { SkillFileSystem } from '@momonga/skills';
import type { AgentsPort, SettingsPort } from '../ports.ts';

export type AgentsPortOptions = { home: string; fileSystem: SkillFileSystem; settings: Pick<SettingsPort, 'trusted' | 'approvedProjectAgents'>; runs: ChildRuns };

const approvedByDigest =
  (digests: Pick<ReadonlySet<string>, 'has'>): ProjectAgentApproved =>
  ({ name, text }) =>
    digests.has(projectAgentDigestOf(name, text));

export const createAgentsPort = ({ home, fileSystem, settings, runs }: AgentsPortOptions): AgentsPort => {
  const loader = createAgentLoader({ home, fileSystem });
  return {
    runs,
    load: async (session, signal) => {
      signal.throwIfAborted();
      const trusted = await settledOrAborted(settings.trusted(session, signal), signal);
      signal.throwIfAborted();
      const approved = approvedByDigest(await settledOrAborted(settings.approvedProjectAgents(session, signal), signal));
      signal.throwIfAborted();
      return settledOrAborted(loader.load({ projectRoot: session.cwd, trusted, projectAgentApproved: approved, signal }), signal);
    },
  };
};
