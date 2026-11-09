export type CallStopTerms = {
  startedAt: number;
  lastProgressAt: number;
  idleMs: number | undefined;
  totalMs: number;
  deadlineAt: number;
};

export type CallStop = { at: number; bound: 'idle' | 'total' | 'deadline' };

export const callStopOf = ({ startedAt, lastProgressAt, idleMs, totalMs, deadlineAt }: CallStopTerms): CallStop => {
  const candidates: CallStop[] = [
    ...(idleMs === undefined ? [] : [{ at: lastProgressAt + idleMs, bound: 'idle' as const }]),
    { at: startedAt + totalMs, bound: 'total' },
    { at: deadlineAt, bound: 'deadline' },
  ];
  return candidates.reduce((earliest, candidate) => (candidate.at < earliest.at ? candidate : earliest));
};
