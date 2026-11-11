import { isDeepStrictEqual } from 'node:util';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { RunFactsView } from '@momonga/protocol';

export type RecomputedFacts = { rows: readonly RunFactsView[]; refused: readonly string[] };

export type FactsMismatch = { runId: string; fields: string[] };

export type FactsVerification = { checked: number; stale: string[]; refused: string[]; mismatches: FactsMismatch[] };

const differingFields = (stored: RunFactsView, folded: RunFactsView): string[] => {
  const storedFields: Record<string, unknown> = stored;
  const foldedFields: Record<string, unknown> = folded;
  const names = [...new Set([...Object.keys(storedFields), ...Object.keys(foldedFields)])].sort();
  return names.filter((name) => !isDeepStrictEqual(storedFields[name], foldedFields[name]));
};

export const verifyFacts = (stored: readonly RunFactsView[], recomputed: RecomputedFacts): FactsVerification => {
  const folded = new Map(recomputed.rows.map((entry) => [entry.runId, entry]));
  const refused = new Set(recomputed.refused);
  const verification: FactsVerification = { checked: 0, stale: [], refused: [], mismatches: [] };
  for (const entry of stored) {
    if (refused.has(entry.runId)) {
      verification.refused.push(entry.runId);
      continue;
    }
    if (entry.definitionsVersion !== INDICATOR_DEFINITIONS_VERSION) {
      verification.stale.push(entry.runId);
      continue;
    }
    const fold = folded.get(entry.runId);
    if (fold === undefined) throw new RangeError(`run ${entry.runId} was neither folded again nor refused by the journal`);
    verification.checked += 1;
    const fields = differingFields(entry, fold);
    if (fields.length > 0) verification.mismatches.push({ runId: entry.runId, fields });
  }
  return verification;
};

export const mergeVerifications = (left: FactsVerification, right: FactsVerification): FactsVerification => ({
  checked: left.checked + right.checked,
  stale: [...left.stale, ...right.stale],
  refused: [...left.refused, ...right.refused],
  mismatches: [...left.mismatches, ...right.mismatches],
});
