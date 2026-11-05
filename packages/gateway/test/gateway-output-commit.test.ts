import { describe, expect, it } from 'vitest';
import { carriesOutput } from '@momonga/protocol';
import type { StreamEvent } from '@momonga/protocol';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { postJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';

const text = textResponseEvents({ model: 'scripted-primary', chunks: ['shown'] });
const opening = text.slice(0, 2);
const completed = text.at(-1);
const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [] };

const reasoningStream = (): StreamEvent[] => {
  if (completed === undefined || completed.type !== 'response.completed') throw new Error('fixture shape');
  return [
    ...opening,
    { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: reasoningItem },
    { type: 'response.reasoning_summary_text.delta', sequence_number: 3, item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'thinking' },
    { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: { ...reasoningItem, summary: [{ type: 'summary_text', text: 'thinking' }] } },
    { ...completed, sequence_number: 5, response: { ...completed.response, output: [{ ...reasoningItem, summary: [{ type: 'summary_text', text: 'thinking' }] }] } },
  ] as unknown as StreamEvent[];
};

const heldBeforeOutput = (events: readonly StreamEvent[]): string[] => {
  const first = events.findIndex(carriesOutput);
  return events.slice(0, first).map((event) => event.type);
};

describe('what counts as output for the commit point (W3)', () => {
  it('holds only lifecycle and structure events before the first text delta: 4 events', () => {
    expect(heldBeforeOutput(text)).toEqual(['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added']);
  });

  it('holds only lifecycle and structure events before the first reasoning summary delta: 3 events', () => {
    expect(heldBeforeOutput(reasoningStream())).toEqual(['response.created', 'response.in_progress', 'response.output_item.added']);
  });

  it('counts every displayed delta and a tool call as output, and no lifecycle event', () => {
    const displayed = [
      'response.output_text.delta',
      'response.reasoning.delta',
      'response.reasoning_summary_text.delta',
      'response.refusal.delta',
      'response.function_call_arguments.delta',
    ].map((type) => ({ type }) as unknown as StreamEvent);
    expect(displayed.every(carriesOutput)).toBe(true);
    expect(carriesOutput({ type: 'response.output_item.added', item: { type: 'function_call' } } as unknown as StreamEvent)).toBe(true);
    const lifecycle = ['response.created', 'response.in_progress', 'response.queued', 'response.content_part.added'].map((type) => ({ type }) as unknown as StreamEvent);
    expect(lifecycle.some(carriesOutput)).toBe(false);
  });

  it('commits at a reasoning summary delta, so the client receives the response before the upstream continues', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: reasoningStream(), gate: { name: 'g', afterEvents: 4 } }] });
    const { client } = await startGateway({ adapters: { primary } });
    registerCleanup(() => primary.release('g'));
    const response = await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true });
    expect(primary.calls[0]?.emitted).toBe(4);
    expect(primary.calls[0]?.outcome).toBe('pending');
    primary.release('g');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: response.reasoning_summary_text.delta');
  });
});
