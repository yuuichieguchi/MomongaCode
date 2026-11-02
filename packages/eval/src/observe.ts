import type { PublicRunEvent } from '@momonga/protocol';
import type { PermissionDecision } from './dataset.ts';

type EventOf<T extends PublicRunEvent['type']> = Extract<PublicRunEvent, { type: T }>;

export type ObservedCall = {
  callId: string;
  name: string;
  rawInput: unknown;
  decision: PermissionDecision | 'unresolved';
};

const eventsOfType = <T extends PublicRunEvent['type']>(events: readonly PublicRunEvent[], type: T): EventOf<T>[] =>
  events.filter((event): event is EventOf<T> => event.type === type);

const textOfOutput = (output: readonly unknown[]): string =>
  output
    .flatMap((item) => {
      if (typeof item !== 'object' || item === null || !('type' in item) || item.type !== 'message' || !('content' in item) || !Array.isArray(item.content)) return [];
      const parts: unknown[] = item.content;
      return parts.flatMap((part) =>
        typeof part === 'object' && part !== null && 'type' in part && part.type === 'output_text' && 'text' in part && typeof part.text === 'string' ? [part.text] : [],
      );
    })
    .join('');

export const finalTextOf = (events: readonly PublicRunEvent[]): string | undefined => {
  const responded = eventsOfType(events, 'model.responded').at(-1);
  return responded === undefined ? undefined : textOfOutput(responded.response.output);
};

const decisionOf = (events: readonly PublicRunEvent[], callId: string): ObservedCall['decision'] => {
  if (eventsOfType(events, 'tool.permission.requested').some((event) => event.callId === callId)) return 'ask';
  if (eventsOfType(events, 'tool.started').some((event) => event.callId === callId)) return 'allow';
  const completed = eventsOfType(events, 'tool.completed').find((event) => event.callId === callId);
  if (completed?.denial !== undefined) return 'deny';
  return 'unresolved';
};

export const callsOf = (events: readonly PublicRunEvent[]): ObservedCall[] =>
  eventsOfType(events, 'tool.call').map((event) => ({
    callId: event.callId,
    name: event.name,
    rawInput: event.rawInput,
    decision: decisionOf(events, event.callId),
  }));
