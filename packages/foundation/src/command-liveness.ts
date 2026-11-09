import type { MarkerState } from './marker-state.ts';
import type { UninspectableProcess } from './platform/inspector-types.ts';

export type HolderListing = { kind: 'listed'; holders: readonly number[]; refused: readonly UninspectableProcess[] } | { kind: 'failed'; reason: string };

export type GroupLiveness = { kind: 'unrecorded' } | { kind: 'read'; runnable: boolean };

export type CommandLivenessEvidence = { marker: MarkerState; listing?: HolderListing; group?: GroupLiveness };

export type CommandLiveness = { answer: 'yes' } | { answer: 'no' } | { answer: 'unknown'; basis: 'held' | 'unchecked'; reason: string };

export const UNNAMED_REASON = 'no process could be named';

export const refusedReason = (refused: readonly UninspectableProcess[]): string => `process ${refused.map(({ pid, command }) => `${pid} (${command})`).join(', ')} could not be inspected`;

const unchecked = (reason: string): CommandLiveness => ({ answer: 'unknown', basis: 'unchecked', reason });

export const commandMayStillRun = ({ marker, listing, group }: CommandLivenessEvidence): CommandLiveness => {
  if (listing?.kind === 'failed') return unchecked(listing.reason);
  if (listing !== undefined && listing.holders.length > 0) return { answer: 'yes' };
  if (group?.kind === 'read' && group.runnable) return { answer: 'yes' };
  if (marker === 'free') return { answer: 'no' };
  if (marker === 'unknown') return unchecked('the marker state could not be read');
  if (group?.kind === 'unrecorded') return unchecked('no process group is recorded for the marker');
  if (listing !== undefined && listing.refused.length > 0) return unchecked(refusedReason(listing.refused));
  return { answer: 'unknown', basis: 'held', reason: UNNAMED_REASON };
};
