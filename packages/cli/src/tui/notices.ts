import { editModelsSettings, loadUserModels, loadUserSettings } from '@momonga/config';
import { homeLayout } from '@momonga/foundation';
import { isModelsRefusal } from '../commands/models.ts';
import type { ModelsHost } from '../commands/models.ts';
import { displayMapOf } from '@momonga/protocol';
import { memoryAutoReviewText } from '../memory/format.ts';
import { sessionModelOf } from './models/order.ts';
import type { RuntimeClient } from '../client/runtime-client.ts';
import type { SessionView } from '../client/views.ts';
import type { CliPorts } from '../ports.ts';
import { announceUpdate } from '../update/background.ts';
import type { UpdateWiring } from '../update/background.ts';

export type NoticeContext = { runtime: RuntimeClient; session: SessionView };

export type NoticeSource = (context: NoticeContext) => Promise<readonly string[]>;

export const settingsWarningSource =
  (ports: Pick<CliPorts, 'env' | 'home' | 'interrupt'>): NoticeSource =>
  async () => (await loadUserSettings({ env: ports.env, home: ports.home, signal: ports.interrupt })).warnings;

export const memoryAutoReviewNoticeSource =
  (ports: Pick<CliPorts, 'env' | 'home' | 'interrupt'>, lock: ModelsHost['lock']): NoticeSource =>
  async ({ session }) => {
    const { memory } = (await loadUserSettings({ env: ports.env, home: ports.home, signal: ports.interrupt })).settings;
    const model = sessionModelOf(session.model);
    if (!memory.autoReview || memory.autoReviewModel !== undefined || model === undefined) return [];
    try {
      await editModelsSettings(ports.home, homeLayout(ports.home).settingsFile, [{ kind: 'setMemoryReviewModel', model }], { lock: lock(), signal: ports.interrupt });
    } catch (error) {
      if (!isModelsRefusal(error)) throw error;
      return [error.message];
    }
    const { resolved } = await loadUserModels({ home: ports.home, signal: ports.interrupt });
    return [memoryAutoReviewText({ on: true, model }, displayMapOf(resolved.views))];
  };

export const skillWarningSource: NoticeSource = async ({ runtime, session }) => (await runtime.skills(session.id)).warnings;

export const agentWarningSource: NoticeSource = async ({ runtime, session }) => (await runtime.agents(session.id)).warnings;

export const mcpWarningSource: NoticeSource = async ({ runtime, session }) => runtime.mcpWarnings(session.id);

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

export type NoticeSourcesOptions = { updateSource?: NoticeSource };

export const defaultNoticeSources = (
  ports: Pick<CliPorts, 'env' | 'home' | 'interrupt'>,
  update: UpdateWiring,
  lock: ModelsHost['lock'],
  options: NoticeSourcesOptions = {},
): readonly NoticeSource[] => [
  settingsWarningSource(ports),
  options.updateSource ?? updateNoticeSource(update),
  skillWarningSource,
  agentWarningSource,
  mcpWarningSource,
  memoryReviewNoticeSource,
  memoryAutoReviewNoticeSource(ports, lock),
];

export type AutoNoticePair = { key: { classifier: string; codeDigest: string; datasetDigest: string }; measurement: string };

export const autoNoticeDue = (last: AutoNoticePair | undefined, current: AutoNoticePair): boolean =>
  last === undefined ||
  last.measurement !== current.measurement ||
  last.key.classifier !== current.key.classifier ||
  last.key.codeDigest !== current.key.codeDigest ||
  last.key.datasetDigest !== current.key.datasetDigest;
