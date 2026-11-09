import type { MemoryStatus, MemoryValidity, Stored, ValidityChange, ValidityCloser, ValidityInterval } from '@momonga/protocol';

export type ValidityInput = {
  observations: readonly { status: Stored<MemoryStatus>; observedAt: number }[];
  createdAt: number;
  successorCreatedAt: number | null;
  retiredAt: number | null;
};

const closerOf = (successorCreatedAt: number | null, retiredAt: number | null): { at: number; by: ValidityCloser } | undefined => {
  if (retiredAt !== null && (successorCreatedAt === null || retiredAt <= successorCreatedAt)) return { at: retiredAt, by: 'retirement' };
  if (successorCreatedAt !== null) return { at: successorCreatedAt, by: 'successor' };
  return undefined;
};

export const validityOf = ({ observations, successorCreatedAt, retiredAt }: ValidityInput): MemoryValidity => {
  const closer = closerOf(successorCreatedAt, retiredAt);
  const intervals = observations.map((observation, index): ValidityInterval => {
    const next = observations[index + 1];
    if (next !== undefined) return { status: observation.status, from: observation.observedAt, to: next.observedAt, closedBy: 'observation' };
    return { status: observation.status, from: observation.observedAt, to: closer?.at ?? null, closedBy: closer?.by ?? null };
  });
  const changes = observations.flatMap((observation, index): ValidityChange[] => {
    const next = observations[index + 1];
    return next === undefined || next.status === observation.status ? [] : [{ from: observation.status, to: next.status, changedBetween: [observation.observedAt, next.observedAt] }];
  });
  return { intervals, changes };
};
