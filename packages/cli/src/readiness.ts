import { escapeTerminalLine, readinessShownText } from '@momonga/protocol';
import type { Readiness, RemedySurface } from '@momonga/protocol';
import type { MomongaPaths } from '@momonga/foundation';
import { configureHintText } from './models-texts.ts';

export const readinessNoticeOf = (readiness: Readiness, surface: RemedySurface): string | undefined =>
  readiness.state === 'ready' ? undefined : readinessShownText(readiness, surface).split('\n').map(escapeTerminalLine).join('\n');

export const noTargetLines = (reason: string, paths: Pick<MomongaPaths, 'settingsFile'>): string[] => [reason, `  ${configureHintText(paths.settingsFile)}`];
