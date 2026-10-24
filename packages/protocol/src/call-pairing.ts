import type { InputItem } from './open-responses.ts';

export const findDanglingOutput = (entries: readonly { seq: number; item: InputItem }[]): { callId: string; seq: number } | undefined => {
  const unpaired = new Map<string, number>();
  for (const { seq, item } of entries) {
    if (item.type === 'function_call') {
      unpaired.set(item.call_id, (unpaired.get(item.call_id) ?? 0) + 1);
    } else if (item.type === 'function_call_output') {
      const open = unpaired.get(item.call_id) ?? 0;
      if (open === 0) return { callId: item.call_id, seq };
      unpaired.set(item.call_id, open - 1);
    }
  }
  return undefined;
};

export const findUnpairedCalls = (entries: readonly { seq: number; item: InputItem }[]): { seq: number; callId: string }[] => {
  const open = new Map<string, number[]>();
  for (const { seq, item } of entries) {
    if (item.type === 'function_call') {
      open.set(item.call_id, [...(open.get(item.call_id) ?? []), seq]);
    } else if (item.type === 'function_call_output') {
      open.get(item.call_id)?.shift();
    }
  }
  return [...open.entries()].flatMap(([callId, seqs]) => seqs.map((seq) => ({ seq, callId }))).sort((a, b) => a.seq - b.seq);
};
