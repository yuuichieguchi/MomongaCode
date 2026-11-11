import { messageOf } from '@momonga/protocol';
import type { KeptWork, Surface } from '@momonga/protocol';
import type { HandoverKind, HandoverRecord } from './record.ts';

export const restartingText = (toVersion: string): string => `Restarting into momonga v${toVersion}. Your session and unsent input are kept.`;

export type HandoverFailure = { toVersion: string; fromVersion: string; reason: string; kept: KeptWork };

export const SURFACE_OF_KIND: Readonly<Record<HandoverKind, Surface>> = { tui: 'tui', acp: 'acp', attach: 'cli', headless: 'cli' };

export const surfaceOfRecord = (record: HandoverRecord): Surface => SURFACE_OF_KIND[record.kind];

export const keptWorkOf = (record: HandoverRecord): KeptWork => {
  switch (record.kind) {
    case 'tui':
      return { kind: 'sessions', sessionIds: [record.session] };
    case 'acp':
      return { kind: 'sessions', sessionIds: record.sessions };
    case 'attach':
    case 'headless':
      return { kind: 'run', runId: record.runId };
  }
};

export const handoverFailedText = (surface: Surface, failure: HandoverFailure): string => messageOf('handoverFailed', surface, failure);

export const recordTooLargeText = ({ toVersion, fromVersion }: Pick<HandoverFailure, 'toVersion' | 'fromVersion'>): string =>
  `Could not restart into v${toVersion}: the unsent input and notes are larger than 1 MiB. This session stays on v${fromVersion}; send or clear the input and it will restart.`;

export const restoreRefusedText = (refusal: Pick<HandoverFailure, 'reason' | 'kept'>): string => messageOf('restoreRefused', 'cli', { reason: refusal.reason, kept: refusal.kept });

export const installedNotNewerReason = (version: string): string => `the installed program is still v${version}`;

export const attachmentChangedText = (file: string): string => `The attached file ${file} has changed and was dropped.`;

export const attachmentUnreadableText = (file: string, reason: string): string => `The attached file ${file} could not be read and was dropped (${reason}).`;
