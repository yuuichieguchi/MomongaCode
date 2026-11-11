import { RECORDED_DATA_MARKER, recordedDataMessage, userMessageContent } from '@momonga/protocol';
import type { HeldOutcome, InputItem, RunEventPayload } from '@momonga/protocol';

export const LATE_RESULT_TAG = 'late_tool_result';

const LATE_OUTCOME_TEXT: Record<HeldOutcome, string> = {
  executed: 'a person approved it and it has now run',
  rejected: 'a person rejected it, so it was not run',
  withdrawn: 'the request for approval was withdrawn, so it was not run',
};

export const lateResultOrigin = (tool: string, callId: string, outcome: HeldOutcome): string =>
  `${RECORDED_DATA_MARKER}: the result of the held call ${tool} (${callId}); ${LATE_OUTCOME_TEXT[outcome]}`;

export type ProducedItem = { item: InputItem; callId?: string; handle?: string };

export type ItemFacts = {
  providerCallIdOf(callId: string): string;
  heldToolNameOf(callId: string): string;
};

type EventOf<Type extends RunEventPayload['type']> = Extract<RunEventPayload, { type: Type }>;

type Producer<Type extends RunEventPayload['type']> = (event: EventOf<Type>, facts: ItemFacts) => ProducedItem[];

const outputOf = (callId: string, output: string, facts: ItemFacts): ProducedItem => ({
  item: { type: 'function_call_output', call_id: facts.providerCallIdOf(callId), output },
  callId,
});

const ITEM_PRODUCERS = {
  'user.message': (event) => [{ item: { type: 'message', role: 'user', content: userMessageContent(event.text, event.images, event) } }],
  'model.responded': (event) => (event.response.output as InputItem[]).map((item) => ({ item })),
  'tool.completed': (event, facts) => [{ ...outputOf(event.callId, event.output, facts), ...(event.handle === undefined ? {} : { handle: event.handle }) }],
  'tool.reconciled': (event, facts) => [outputOf(event.callId, event.output, facts)],
  'tool.held.resolved': (event, facts) => [
    { item: recordedDataMessage({ tag: LATE_RESULT_TAG, origin: lateResultOrigin(facts.heldToolNameOf(event.callId), event.callId, event.outcome), text: event.output }) },
  ],
} satisfies { [Type in RunEventPayload['type']]?: Producer<Type> };

export type ItemEventType = keyof typeof ITEM_PRODUCERS;

export const ITEM_EVENT_TYPES = Object.keys(ITEM_PRODUCERS) as ItemEventType[];

const producers: { [Type in ItemEventType]: Producer<Type> } = ITEM_PRODUCERS;

const isItemEvent = (event: RunEventPayload): event is EventOf<ItemEventType> => Object.hasOwn(producers, event.type);

const produced = <Type extends ItemEventType>(type: Type, event: EventOf<Type>, facts: ItemFacts): ProducedItem[] => producers[type](event, facts);

export const itemsOfEvent = (event: RunEventPayload, facts: ItemFacts): ProducedItem[] => (isItemEvent(event) ? produced(event.type, event, facts) : []);

const UNREAD_FACTS: ItemFacts = { providerCallIdOf: (callId) => callId, heldToolNameOf: (callId) => callId };

export const itemCountOf = (event: RunEventPayload): number => itemsOfEvent(event, UNREAD_FACTS).length;
