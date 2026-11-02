import { loadUserSettings } from '@momonga/config';
import type { RuntimeClient } from '../client/runtime-client.ts';
import type { SessionView } from '../client/views.ts';
import type { CliPorts } from '../ports.ts';
import { announceUpdate } from '../update/background.ts';
import type { UpdateWiring } from '../update/background.ts';

export type NoticeContext = { runtime: RuntimeClient; session: SessionView };

export type NoticeSource = (context: NoticeContext) => Promise<readonly string[]>;

export const settingsWarningSource =
  (ports: Pick<CliPorts, 'home'>): NoticeSource =>
  async () => (await loadUserSettings({ home: ports.home })).warnings;

export const skillWarningSource: NoticeSource = async ({ runtime, session }) => (await runtime.skills(session.id)).warnings;

export const agentWarningSource: NoticeSource = async ({ runtime, session }) => (await runtime.agents(session.id)).warnings;

export const updateNoticeSource =
  (update: UpdateWiring): NoticeSource =>
  async () => {
    const notice = await announceUpdate(update);
    return notice === undefined ? [] : [`momonga: ${notice}`];
  };

export const defaultNoticeSources = (ports: Pick<CliPorts, 'home'>, update: UpdateWiring): readonly NoticeSource[] => [
  settingsWarningSource(ports),
  updateNoticeSource(update),
  skillWarningSource,
  agentWarningSource,
];
