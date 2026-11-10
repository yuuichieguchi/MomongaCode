import { describe, expect, it } from 'vitest';
import { carriesOutput } from '@momonga/protocol';
import type { StreamEvent } from '@momonga/protocol';
import { createFakeClock, createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { START_MS, postJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { createLiveSpanTelemetry } from './gateway-support.ts';
import { driveTimers } from './retry-support.ts';

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

const completedWith = (sequenceNumber: number, output: unknown[]): StreamEvent => {
  if (completed === undefined || completed.type !== 'response.completed') throw new Error('fixture shape');
  return { ...completed, sequence_number: sequenceNumber, response: { ...completed.response, output } } as unknown as StreamEvent;
};

const reasoningDeltaStream = (): StreamEvent[] =>
  [
    ...opening,
    { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { type: 'reasoning', id: 'rs_2', summary: [] } },
    { type: 'response.reasoning.delta', sequence_number: 3, item_id: 'rs_2', output_index: 0, content_index: 0, delta: 'pondering' },
    completedWith(4, [{ type: 'reasoning', id: 'rs_2', summary: [], content: [{ type: 'reasoning_text', text: 'pondering' }] }]),
  ] as unknown as StreamEvent[];

const refusalStream = (): StreamEvent[] =>
  [
    ...opening,
    { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { type: 'message', id: 'msg_r', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', sequence_number: 3, item_id: 'msg_r', output_index: 0, content_index: 0, part: { type: 'refusal', refusal: '' } },
    { type: 'response.refusal.delta', sequence_number: 4, item_id: 'msg_r', output_index: 0, content_index: 0, delta: 'no' },
    completedWith(5, [{ type: 'message', id: 'msg_r', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }]),
  ] as unknown as StreamEvent[];

const functionCallItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '', status: 'in_progress' };

const functionCallStream = (): StreamEvent[] =>
  [
    ...opening,
    { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: functionCallItem },
    { type: 'response.function_call_arguments.delta', sequence_number: 3, item_id: 'fc_1', output_index: 0, delta: '{}' },
    completedWith(4, [{ ...functionCallItem, arguments: '{}', status: 'completed' }]),
  ] as unknown as StreamEvent[];

const silentStream = (): StreamEvent[] => [...opening, completedWith(2, [])];

const lifecycleCount = (events: readonly StreamEvent[]): number => events.findIndex(carriesOutput);

const commitEventsWhileParked = async (
  events: StreamEvent[],
  afterEvents: number,
  expectCommitWhileParked: boolean,
): Promise<{ parked: number; finished: number }> => {
  const clock = createFakeClock(START_MS);
  const live = createLiveSpanTelemetry(clock);
  const primary = createScriptedAdapter({ calls: [{ events, gate: { name: 'g', afterEvents } }] });
  const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, clock, telemetry: live.telemetry });
  registerCleanup(() => primary.release('g'));
  const pending = postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true });
  await waitFor(() => primary.calls[0]?.emitted === afterEvents && primary.calls[0]?.outcome === 'pending', {
    description: `the adapter parked at its gate after ${afterEvents} events`,
  });
  await waitFor(() => live.attemptSpans().length === 1, { description: 'the attempt span started' });
  if (expectCommitWhileParked) await waitFor(() => live.commitEvents() === 1, { description: 'the commit event after the first output was pulled' });
  const parked = live.commitEvents();
  primary.release('g');
  await (await pending).text();
  await waitFor(() => primary.calls[0]?.outcome !== 'pending', { description: 'the upstream call finished' });
  return { parked, finished: live.commitEvents() };
};

const outputKinds: Array<[string, () => StreamEvent[]]> = [
  ['an output text delta', () => text],
  ['a reasoning delta', reasoningDeltaStream],
  ['a reasoning summary delta', reasoningStream],
  ['a refusal delta', refusalStream],
  ['a function call item', functionCallStream],
];

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
    const clock = createFakeClock(START_MS);
    const live = createLiveSpanTelemetry(clock);
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, clock, telemetry: live.telemetry });
    registerCleanup(() => primary.release('g'));
    const pending = postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true });
    await waitFor(() => live.commitEvents() === 1, { description: 'the commit event at the reasoning summary delta while the upstream is held' });
    const response = await pending;
    expect(primary.calls[0]?.emitted).toBe(4);
    expect(primary.calls[0]?.outcome).toBe('pending');
    primary.release('g');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: response.reasoning_summary_text.delta');
  });

  it.each(outputKinds)('records no commit event on the attempt span while only lifecycle events before %s have been pulled', async (_kind, stream) => {
    const events = stream();
    const { parked, finished } = await commitEventsWhileParked(events, lifecycleCount(events), false);
    expect(parked).toBe(0);
    expect(finished).toBe(1);
  });

  it.each(outputKinds)('records exactly one commit event on the attempt span as soon as %s has been pulled', async (_kind, stream) => {
    const events = stream();
    const { parked, finished } = await commitEventsWhileParked(events, lifecycleCount(events) + 1, true);
    expect(parked).toBe(1);
    expect(finished).toBe(1);
  });

  it('records exactly one commit event, at the terminal event, for a stream with no output', async () => {
    const events = silentStream();
    expect(events.some(carriesOutput)).toBe(false);
    const beforeTerminal = await commitEventsWhileParked(events, 2, false);
    expect(beforeTerminal).toEqual({ parked: 0, finished: 1 });
  });

  it('records the commit only on the attempt that produced output when the same target is retried', async () => {
    const clock = createFakeClock(START_MS);
    const live = createLiveSpanTelemetry(clock);
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'down before output' } }, { events: text }] });
    const harness = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, clock, telemetry: live.telemetry });
    const pending = postJson(harness.client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true });
    await driveTimers(harness, [pending]);
    const body = await (await pending).text();
    expect(body).toContain('event: response.completed');
    expect(primary.calls).toHaveLength(2);
    expect(live.attemptSpans()).toHaveLength(2);
    expect(live.commitCountsPerAttempt()).toEqual([0, 1]);
  });

  it('records the commit only on the fallback attempt when the first target fails before output', async () => {
    const clock = createFakeClock(START_MS);
    const live = createLiveSpanTelemetry(clock);
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 429, message: 'slow down', retryAfterMs: 86_400_000 } }] });
    const secondary = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-secondary', chunks: ['from secondary'] }) }] });
    const { client } = await startGateway({
      adapters: { 'scripted/scripted-primary': primary, 'scripted/scripted-secondary': secondary },
      clock,
      telemetry: live.telemetry,
      config: {
        chains: { 'scripted/scripted-primary': ['scripted/scripted-primary', 'scripted/scripted-secondary'] },
        targets: { 'scripted/scripted-primary': {}, 'scripted/scripted-secondary': {} },
        retry: { maxAttempts: 3, baseMs: 100, maxMs: 10_000 },
      },
    });
    const body = await (await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true })).text();
    expect(body).toContain('from secondary');
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(1);
    expect(live.attemptSpans()).toHaveLength(2);
    expect(live.commitCountsPerAttempt()).toEqual([0, 1]);
  });
});
