import { describe, expect, it } from 'vitest';
import { createMapperState, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures, Effect, Phase } from '../src/acp/events.ts';
import { frameOf } from './acp-harness.ts';
import type { EventPayload } from './acp-harness.ts';

const NONE: ClientFeatures = { notices: false, compaction: false, elicitation: { form: false, url: false } };

const responded: EventPayload = { type: 'model.responded', step: 1, attempt: 0, response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };

const replay = (payloads: readonly EventPayload[], phase: Phase): Effect[] => {
  const state = createMapperState();
  return payloads.flatMap((payload, index) => mapRunEvent(frameOf('run-1', index + 1, payload).data, phase, state, NONE));
};

const chunk = (sessionUpdate: string, itemId: string, text: string): Effect => ({ kind: 'update', update: { sessionUpdate, content: { type: 'text', text }, messageId: `run-1/${itemId}` } } as Effect);

describe('a restarted stream sent to an editor', () => {
  it.for(['live', 'history'] as const)('sends each answer once its item completes and never the entries a restart withdraws (%s)', (phase) => {
    const effects = replay(
      [
        { type: 'agent.thought.delta', step: 1, attempt: 0, itemId: 't1', text: 'Hmm' },
        { type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'I looked' },
        { type: 'model.stream.restarted', step: 4, attempt: 5, itemIds: ['t1', 'm1'] },
        { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'm2', text: 'It adds' },
        { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'm2', text: ' two numbers.' },
        responded,
      ],
      phase,
    );

    expect(effects).toEqual([chunk('agent_message_chunk', 'm2', 'It adds two numbers.')]);
  });

  it('holds the text of an item until the model response that completes it', () => {
    const state = createMapperState();
    const map = (seq: number, payload: EventPayload): Effect[] => mapRunEvent(frameOf('run-1', seq, payload).data, 'live', state, NONE);

    expect(map(1, { type: 'agent.thought.delta', step: 1, attempt: 0, itemId: 't1', text: 'Hmm' })).toEqual([]);
    expect(map(2, { type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'Hi' })).toEqual([]);
    expect(map(3, responded)).toEqual([chunk('agent_thought_chunk', 't1', 'Hmm'), chunk('agent_message_chunk', 'm1', 'Hi')]);
    expect(map(4, responded)).toEqual([]);
  });
});
