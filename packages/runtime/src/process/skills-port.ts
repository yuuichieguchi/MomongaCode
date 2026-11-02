import type { SkillLoader } from '@momonga/skills';
import type { SettingsPort, SkillsPort } from '../ports.ts';

export type SkillsPortOptions = { loader: SkillLoader; settings: Pick<SettingsPort, 'trusted'> };

export const createSkillsPort = ({ loader, settings }: SkillsPortOptions): SkillsPort => ({
  load: (session) => loader.load({ projectRoot: session.cwd, trusted: settings.trusted(session) }),
});
