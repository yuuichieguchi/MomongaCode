import { RECORDED_DATA_MARKER, includedShellTexts, recordedDataMessage, userMessageContent } from '@momonga/protocol';
import type { ContentPart, HeldOutcome, InputItem, RunEventPayload } from '@momonga/protocol';

export const LATE_RESULT_TAG = 'late_tool_result';

type ReconciledOutcome = Extract<RunEventPayload, { type: 'tool.reconciled' }>['outcome'];

export type LateOutcome = HeldOutcome | `reconciled_${ReconciledOutcome}`;

const LATE_OUTCOME_TEXT: Record<LateOutcome, string> = {
  executed: 'a person approved it and it has now run',
  rejected: 'a person rejected it, so it was not run',
  withdrawn: 'the request for approval was withdrawn, so it was not run',
  reconciled_already_applied: 'a person approved it, its attempt was interrupted, and its effect was found already applied',
  reconciled_not_applied: 'a person approved it, and its attempt was interrupted before it had an effect',
  reconciled_unknown: 'a person approved it, its attempt was interrupted, and its effect is unknown',
};

export const lateResultOrigin = (tool: string, callId: string, outcome: LateOutcome): string =>
  `${RECORDED_DATA_MARKER}: the result of the held call ${tool} (${callId}); ${LATE_OUTCOME_TEXT[outcome]}`;

export type ProducedItem = { item: InputItem; callId?: string; handle?: string };

export type ItemFacts = {
  fence: string;
  providerCallIdOf(callId: string): string;
  heldToolNameOf(callId: string): string;
};

type EventOf<Type extends RunEventPayload['type']> = Extract<RunEventPayload, { type: Type }>;

type Producer<Type extends RunEventPayload['type']> = (event: EventOf<Type>, facts: ItemFacts) => ProducedItem[];

const outputOf = (callId: string, output: string, facts: ItemFacts): ProducedItem => ({
  item: { type: 'function_call_output', call_id: facts.providerCallIdOf(callId), output },
  callId,
});

const lateResultOf = (callId: string, outcome: LateOutcome, output: string, facts: ItemFacts): ProducedItem => ({
  item: recordedDataMessage({ tag: LATE_RESULT_TAG, origin: lateResultOrigin(facts.heldToolNameOf(callId), callId, outcome), text: output }),
});

const ITEM_PRODUCERS = {
  'user.message': (event, facts) => [
    {
      item: {
        type: 'message',
        role: 'user',
        content: [...includedShellTexts(event.shell, facts.fence).map((text): ContentPart => ({ type: 'input_text', text })), ...userMessageContent(event.text, event.images, event, facts.fence)],
      },
    },
  ],
  'model.responded': (event) => (event.response.output as InputItem[]).map((item) => ({ item })),
  'tool.completed': (event, facts) => [
    { ...(event.held === undefined ? outputOf(event.callId, event.output, facts) : lateResultOf(event.callId, 'executed', event.output, facts)), ...(event.handle === undefined ? {} : { handle: event.handle }) },
  ],
  'tool.reconciled': (event, facts) => [event.held === undefined ? outputOf(event.callId, event.output, facts) : lateResultOf(event.callId, `reconciled_${event.outcome}`, event.output, facts)],
  'tool.held.resolved': (event, facts) => [lateResultOf(event.callId, event.outcome, event.output, facts)],
} satisfies { [Type in RunEventPayload['type']]?: Producer<Type> };

export type ItemEventType = keyof typeof ITEM_PRODUCERS;

export const ITEM_EVENT_TYPES = Object.keys(ITEM_PRODUCERS) as ItemEventType[];

const producers: { [Type in ItemEventType]: Producer<Type> } = ITEM_PRODUCERS;

const isItemEvent = (event: RunEventPayload): event is EventOf<ItemEventType> => Object.hasOwn(producers, event.type);

const produced = <Type extends ItemEventType>(type: Type, event: EventOf<Type>, facts: ItemFacts): ProducedItem[] => producers[type](event, facts);

export const itemsOfEvent = (event: RunEventPayload, facts: ItemFacts): ProducedItem[] => (isItemEvent(event) ? produced(event.type, event, facts) : []);

const UNREAD_FACTS: ItemFacts = { fence: '', providerCallIdOf: (callId) => callId, heldToolNameOf: (callId) => callId };

export const itemCountOf = (event: RunEventPayload): number => itemsOfEvent(event, UNREAD_FACTS).length;
