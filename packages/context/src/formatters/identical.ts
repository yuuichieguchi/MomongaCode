import { readClauseOf } from '../tool-output.ts';

export const identicalMarker = (referentCallId: string, handle: string, reader: string | undefined): string =>
  `[identical to the output of call ${referentCallId}; stored as ${handle}${readClauseOf(reader)}]`;

export type IdenticalCandidate = { callId: string; text: string; full: boolean };

export const identicalReferents = (outputs: readonly IdenticalCandidate[]): Map<string, string> => {
  const earliestFull = new Map<string, string>();
  const referents = new Map<string, string>();
  for (const { callId, text, full } of outputs) {
    if (!full) continue;
    const earliest = earliestFull.get(text);
    if (earliest === undefined) earliestFull.set(text, callId);
    else referents.set(callId, earliest);
  }
  return referents;
};
