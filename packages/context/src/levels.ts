import type { BuildContextInput, ProtectionLevel } from './types.ts';

export const DEFAULT_KEEP_RECENT_TURNS = 3;
export const DEFAULT_KEEP_RECENT_STEPS = 4;

export type SlotPosition = { turn: number; step: number };

export type HistoryShape = {
  positions: SlotPosition[];
  turnCount: number;
  currentTurn: number;
  lastStep: number;
};

export type ProtectionRung = { protection: ProtectionLevel; protectedSlots: Set<number> };

type Entry = { readonly seq: number; readonly item: { readonly type: string; readonly role?: string } };

const isUserMessage = (item: Entry['item']): boolean => item.type === 'message' && item.role === 'user';

export const retainedHistoryOf = <Item extends { readonly seq: number }>(history: readonly Item[], summary: { replacedThroughSeq: number } | undefined): Item[] =>
  summary === undefined ? [...history] : history.filter((entry) => entry.seq > summary.replacedThroughSeq);

export const shapeOf = (entries: readonly Entry[], taskSeq: number): HistoryShape => {
  const positions: SlotPosition[] = [];
  let turn = 0;
  let step = 0;
  let inheritedSeen = false;
  let taskBoundaryPending = false;
  for (const [index, entry] of entries.entries()) {
    if (entry.seq < taskSeq) inheritedSeen = true;
    else if (inheritedSeen) {
      taskBoundaryPending = true;
      inheritedSeen = false;
    }
    const previous = entries[index - 1];
    if ((index > 0 && isUserMessage(entry.item)) || taskBoundaryPending) {
      turn += 1;
      step = 0;
    } else if (previous !== undefined && previous.item.type === 'function_call_output' && entry.item.type !== 'function_call_output') {
      step += 1;
    }
    taskBoundaryPending = false;
    positions.push({ turn, step });
  }
  const last = entries.at(-1);
  const lastTurn = positions.at(-1)?.turn ?? 0;
  const turnCount = last === undefined ? 0 : last.seq < taskSeq ? lastTurn + 2 : lastTurn + 1;
  const currentTurn = turnCount - 1;
  const lastStep = positions.reduce((highest, position) => (position.turn === currentTurn ? Math.max(highest, position.step) : highest), -1);
  return { positions, turnCount, currentTurn, lastStep };
};

const sameSet = (left: ReadonlySet<number>, right: ReadonlySet<number>): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

export const protectionRungsOf = (shape: HistoryShape, keepTurns: number, keepSteps: number): ProtectionRung[] => {
  const protectedSetOf = (protection: ProtectionLevel): Set<number> => {
    const protectedSlots = new Set<number>();
    for (const [index, position] of shape.positions.entries()) {
      if (position.turn < shape.turnCount - protection.keepTurns) continue;
      if (position.turn === shape.currentTurn && position.step <= shape.lastStep - protection.keepSteps) continue;
      protectedSlots.add(index);
    }
    return protectedSlots;
  };
  const ladder: ProtectionLevel[] = [
    { keepTurns, keepSteps },
    { keepTurns: 1, keepSteps },
    { keepTurns: 1, keepSteps: 1 },
  ];
  const rungs: ProtectionRung[] = [];
  for (const protection of ladder) {
    const protectedSlots = protectedSetOf(protection);
    const previous = rungs.at(-1);
    if (previous === undefined || !sameSet(previous.protectedSlots, protectedSlots)) rungs.push({ protection, protectedSlots });
  }
  return rungs;
};
