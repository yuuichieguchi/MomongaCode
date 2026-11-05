import type { NeedsProbe } from '@momonga/protocol';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';

export const remedyOf = (targetName: string): string => `run \`momonga gateway probe ${targetName}\``;

export const needsProbeOf = (targetName: string, message: string, evidence: string): NeedsProbe => ({
  message,
  evidence,
  remedy: remedyOf(targetName),
});

export const preconditionOf = (needsProbe: NeedsProbe): PreconditionFailedError =>
  new PreconditionFailedError(needsProbe.message, needsProbe.evidence, needsProbe.remedy);
