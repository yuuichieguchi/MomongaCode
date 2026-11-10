export const restartingText = (toVersion: string): string => `Restarting into momonga v${toVersion}. Your session and unsent input are kept.`;

export type HandoverFailure = { toVersion: string; fromVersion: string; reason: string; session: string };

export const handoverFailedText = ({ toVersion, fromVersion, reason, session }: HandoverFailure): string =>
  `Could not restart into v${toVersion} (${reason}). This session stays on v${fromVersion} and keeps working until that version finishes its tasks. Your tasks keep running; open them with \`momonga attach ${session}\`. Your unsent input is still in the prompt.`;

export const recordTooLargeText = ({ toVersion, fromVersion }: Pick<HandoverFailure, 'toVersion' | 'fromVersion'>): string =>
  `Could not restart into v${toVersion}: the unsent input and notes are larger than 1 MiB. This session stays on v${fromVersion}; send or clear the input and it will restart.`;

export const restoreRefusedText = ({ reason, session }: Pick<HandoverFailure, 'reason' | 'session'>): string =>
  `Could not restore the session (${reason}). Your session is kept: run \`momonga attach ${session}\`.`;

export const installedNotNewerReason = (version: string): string => `the installed program is still v${version}`;

export const attachmentChangedText = (file: string): string => `The attached file ${file} has changed and was dropped.`;

export const attachmentUnreadableText = (file: string, reason: string): string => `The attached file ${file} could not be read and was dropped (${reason}).`;
