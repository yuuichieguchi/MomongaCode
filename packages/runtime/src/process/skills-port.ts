import { settledOrAborted } from '@momonga/foundation';
import type { SkillLoader } from '@momonga/skills';
import type { SettingsPort, SkillsPort } from '../ports.ts';

export type SkillsPortOptions = { loader: SkillLoader; settings: Pick<SettingsPort, 'trusted'> };

export const createSkillsPort = ({ loader, settings }: SkillsPortOptions): SkillsPort => ({
  load: (session, signal) => settledOrAborted((async () => loader.load({ projectRoot: session.cwd, trusted: await settings.trusted(session) }))(), signal),
});
