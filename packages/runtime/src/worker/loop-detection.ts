import { canonicalJson } from '@momonga/foundation';
import type { RunState } from '@momonga/protocol';
import { parseJsonOrText } from './json.ts';

type CallGroup = { signature: string; outputs: Map<string, string>; callIds: string[]; closed: boolean };

const outputText = (output: unknown): string => (typeof output === 'string' ? output : canonicalJson(output));

const callGroups = (history: RunState['history']): CallGroup[] => {
  const groups: { calls: [string, unknown][]; outputs: Map<string, string>; callIds: string[]; closed: boolean }[] = [];
  for (const { item } of history) {
    if (item.type === 'function_call') {
      let group = groups.at(-1);
      if (group === undefined || group.closed) {
        group = { calls: [], outputs: new Map(), callIds: [], closed: false };
        groups.push(group);
      }
      group.calls.push([item.name, parseJsonOrText(item.arguments)]);
      group.callIds.push(item.call_id);
    } else if (item.type === 'function_call_output') {
      const group = groups.at(-1);
      if (group === undefined) continue;
      group.closed = true;
      group.outputs.set(item.call_id, outputText(item.output));
    }
  }
  return groups.map((group) => ({ ...group, signature: canonicalJson(group.calls) }));
};

const outputSignature = (group: CallGroup): string | undefined => {
  if (!group.closed || group.callIds.some((callId) => !group.outputs.has(callId))) return undefined;
  return canonicalJson(group.callIds.map((callId) => group.outputs.get(callId)));
};

export const isLoop = (history: RunState['history'], threshold: number): boolean => {
  const groups = callGroups(history);
  const current = groups.at(-1);
  if (current === undefined) return false;
  const previous = groups.slice(0, -1).slice(-(threshold - 1));
  if (previous.length < threshold - 1) return false;
  const outputs = previous.map(outputSignature);
  const first = outputs[0];
  return first !== undefined && previous.every((group) => group.signature === current.signature) && outputs.every((signature) => signature === first);
};
