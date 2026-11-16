import { settledOrAborted } from '@momonga/foundation';
import type { SkillLoader } from '@momonga/skills';
import type { SettingsPort, SkillsPort } from '../ports.ts';

export type SkillsPortOptions = { loader: SkillLoader; settings: Pick<SettingsPort, 'trusted'> };

export const createSkillsPort = ({ loader, settings }: SkillsPortOptions): SkillsPort => ({
  load: async (session, signal) => {
    signal.throwIfAborted();
    const trusted = await settledOrAborted(settings.trusted(session, signal), signal);
    signal.throwIfAborted();
    return settledOrAborted(loader.load({ projectRoot: session.cwd, trusted, signal }), signal);
  },
});
