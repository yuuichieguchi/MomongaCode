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

export const memoryReviewNoticeSource: NoticeSource = async ({ runtime, session }) => {
  const waiting = await runtime.memories({ state: 'candidate', project: session.cwd });
  return waiting.length === 0 ? [] : [`${waiting.length} ${waiting.length === 1 ? 'memory is' : 'memories are'} waiting for your review: run momonga memory review`];
};

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
  memoryReviewNoticeSource,
];

export type AutoNoticePair = { key: { classifier: string; codeDigest: string; datasetDigest: string }; measurement: string };

export const autoNoticeDue = (last: AutoNoticePair | undefined, current: AutoNoticePair): boolean =>
  last === undefined ||
  last.measurement !== current.measurement ||
  last.key.classifier !== current.key.classifier ||
  last.key.codeDigest !== current.key.codeDigest ||
  last.key.datasetDigest !== current.key.datasetDigest;
