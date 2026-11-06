import { escapeTerminalLine, readinessText } from '@momonga/protocol';
import type { Readiness } from '@momonga/protocol';
import type { MomongaPaths } from '@momonga/foundation';

export const readinessNoticeOf = (readiness: Readiness): string | undefined =>
  readiness.state === 'ready' ? undefined : readinessText(readiness).split('\n').map(escapeTerminalLine).join('\n');

export const noTargetLines = (reason: string, paths: Pick<MomongaPaths, 'settingsFile'>): string[] => [
  reason,
  `  declare a target in ${paths.settingsFile} (models.targets and models.aliases), or run \`momonga models detect\` to find a local model server`,
];
