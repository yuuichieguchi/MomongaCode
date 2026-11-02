import { assistantTextOf } from '@momonga/protocol';
import type { PublicRunEvent, ToolKind } from '@momonga/protocol';
import type { PermissionDecision } from './dataset.ts';
import type { Transcript } from './transcript.ts';

type EventOf<T extends PublicRunEvent['type']> = Extract<PublicRunEvent, { type: T }>;

export type ObservedCall = {
  runId: string;
  callId: string;
  name: string;
  kind: ToolKind;
  rawInput: unknown;
  decision: PermissionDecision | 'unresolved';
};

const eventsOfType = <T extends PublicRunEvent['type']>(events: readonly PublicRunEvent[], type: T): EventOf<T>[] =>
  events.filter((event): event is EventOf<T> => event.type === type);

export const finalTextOf = (events: readonly PublicRunEvent[]): string | undefined => {
  const responded = eventsOfType(events, 'model.responded').at(-1);
  return responded === undefined ? undefined : assistantTextOf(responded.response.output);
};

const decisionOf = (events: readonly PublicRunEvent[], callId: string): ObservedCall['decision'] => {
  if (eventsOfType(events, 'tool.permission.requested').some((event) => event.callId === callId)) return 'ask';
  if (eventsOfType(events, 'tool.started').some((event) => event.callId === callId)) return 'allow';
  const completed = eventsOfType(events, 'tool.completed').find((event) => event.callId === callId);
  if (completed?.denial !== undefined) return 'deny';
  return 'unresolved';
};

const callsInRun = (runId: string, events: readonly PublicRunEvent[]): ObservedCall[] =>
  eventsOfType(events, 'tool.call').map((event) => ({
    runId,
    callId: event.callId,
    name: event.name,
    kind: event.kind,
    rawInput: event.rawInput,
    decision: decisionOf(events, event.callId),
  }));

export const callsOf = (transcript: Pick<Transcript, 'run' | 'events' | 'children'>): ObservedCall[] => [
  ...callsInRun(transcript.run.id, transcript.events),
  ...transcript.children.flatMap((child) => callsInRun(child.runId, child.events)),
];
