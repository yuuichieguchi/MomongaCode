import { MEMORY_STATUSES } from '@momonga/protocol';
import type { MemoryView } from '@momonga/protocol';

const tierOf = (memory: MemoryView): number => MEMORY_STATUSES.indexOf(memory.status);

const newestFirst = (left: number | null, right: number | null): number => (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY) || 0;

const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export const recallOrder = <M extends MemoryView>(memories: readonly M[], matchedIds: ReadonlySet<string>): M[] =>
  [...memories].sort(
    (left, right) =>
      Number(matchedIds.has(right.id)) - Number(matchedIds.has(left.id)) ||
      tierOf(left) - tierOf(right) ||
      newestFirst(left.contributedAt, right.contributedAt) ||
      newestFirst(left.lastUsedAt, right.lastUsedAt) ||
      compareIds(left.id, right.id),
  );
