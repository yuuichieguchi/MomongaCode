import { MEMORY_STATUSES } from '@momonga/protocol';
import type { MemoryRecord, MemoryStatus } from '@momonga/protocol';

type Rankable = Pick<MemoryRecord, 'id' | 'contributedAt' | 'keptAt'> & { observedStatus?: MemoryStatus | null };

const tierOf = (memory: Rankable): number => (memory.observedStatus === undefined || memory.observedStatus === null ? MEMORY_STATUSES.length : MEMORY_STATUSES.indexOf(memory.observedStatus));

const newestFirst = (left: number | null, right: number | null): number => (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY) || 0;

const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export const recallOrder = <M extends Rankable>(memories: readonly M[], matchedIds: ReadonlySet<string>): M[] =>
  [...memories].sort(
    (left, right) =>
      Number(matchedIds.has(right.id)) - Number(matchedIds.has(left.id)) ||
      tierOf(left) - tierOf(right) ||
      newestFirst(left.contributedAt, right.contributedAt) ||
      newestFirst(left.keptAt, right.keptAt) ||
      compareIds(left.id, right.id),
  );
