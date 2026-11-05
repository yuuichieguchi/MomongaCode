import { PreconditionFailedError } from '../adapters/shared/failures.ts';

export const remedyOf = (targetName: string): string => `run \`momonga gateway probe ${targetName}\``;

export const missingRecordFailure = (message: string, evidence: string, targetName: string): PreconditionFailedError =>
  new PreconditionFailedError(message, evidence, remedyOf(targetName));
