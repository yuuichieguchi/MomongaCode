import { loadUserSettings } from '@momonga/config';
import type { CliPorts } from '../ports.ts';

export type NoticeSource = () => Promise<readonly string[]>;

export const settingsWarningSource =
  (ports: Pick<CliPorts, 'home'>): NoticeSource =>
  async () => (await loadUserSettings({ home: ports.home })).warnings;

export const defaultNoticeSources = (ports: Pick<CliPorts, 'home'>): readonly NoticeSource[] => [settingsWarningSource(ports)];
