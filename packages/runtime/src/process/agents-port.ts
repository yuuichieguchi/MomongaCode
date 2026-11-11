import { createAgentLoader } from '@momonga/agents';
import { settledOrAborted } from '@momonga/foundation';
import type { ChildRuns } from '@momonga/agents';
import type { SkillFileSystem } from '@momonga/skills';
import type { AgentsPort, SettingsPort } from '../ports.ts';

export type AgentsPortOptions = { home: string; fileSystem: SkillFileSystem; settings: Pick<SettingsPort, 'trusted'>; runs: ChildRuns };

export const createAgentsPort = ({ home, fileSystem, settings, runs }: AgentsPortOptions): AgentsPort => {
  const loader = createAgentLoader({ home, fileSystem });
  return { runs, load: (session, signal) => settledOrAborted((async () => loader.load({ projectRoot: session.cwd, trusted: await settings.trusted(session) }))(), signal) };
};
