import { WORDS } from '@momonga/protocol';
import type { DialectId, NeedsProbe, ProbeReportDialect } from '@momonga/protocol';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';

export const probeCommandOf = (targetName: string): string => `${WORDS.command} gateway probe ${targetName}`;

export const remedyOf = (targetName: string): string => `run \`${probeCommandOf(targetName)}\``;

export const unusableRecordError = (file: string, targetName: string, problem: string, cause?: unknown): Error =>
  new Error(`Probe record ${file} is unusable (${problem}). Delete it or ${remedyOf(targetName)}.`, cause === undefined ? undefined : { cause });

export const needsProbeOf = (targetName: string, message: string, evidence: string): NeedsProbe => ({
  state: 'needs_probe',
  message,
  evidence,
  remedy: remedyOf(targetName),
});

export const preconditionOf = (needsProbe: NeedsProbe): PreconditionFailedError =>
  new PreconditionFailedError(needsProbe.message, needsProbe.evidence, needsProbe.remedy);

export const declaredDialectRefusal = (targetName: string, declared: DialectId | undefined, report: ProbeReportDialect, subject: string): NeedsProbe | undefined => {
  if (declared === undefined || report.selected !== null) return undefined;
  const detail = report.tried.find((attempt) => attempt.id === declared)?.detail;
  return needsProbeOf(
    targetName,
    `the model "${targetName}" declares the schema dialect "${declared}", which the probe found the server does not accept`,
    `${subject} refused the declared dialect${detail === undefined ? '' : `: ${detail}`}`,
  );
};

const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const ABSOLUTE_PATH = /(^|[\s(="'])(?:~|[A-Za-z]:)?[/\\][^\s)"']*/g;
const BODY_START = /{|\[[{"]/;

export const measurementCauseOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const bodyAt = message.search(BODY_START);
  const withoutBody = bodyAt === -1 ? message : message.slice(0, bodyAt);
  return withoutBody.replace(ADDRESS, 'an address').replace(ABSOLUTE_PATH, '$1a path').replace(/[\s:;,]+$/, '').trim();
};

export const measurementFailedText = (targetName: string, cause: string, declaration: string): string =>
  `measuring the ${WORDS.model} "${targetName}" failed: ${cause}. It is not measured again until you ask: ${declaration}, or ${remedyOf(targetName)}.`;
