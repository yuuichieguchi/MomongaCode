import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@momonga/protocol';
import { within } from './deferred.ts';
import { createFakeGateway } from './fake-gateway.ts';
import { capabilitiesFor } from './harness.ts';
import { callsStep, failedStep, gated, incompleteStep, functionCallItem, textStep, thrownStep } from './scripts.ts';

const BODY = { model: 'fm', input: 'hi' };

const collectEvents = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const callIdsOf = (events: readonly StreamEvent[]) => {
  const added: string[] = [];
  const done: string[] = [];
  let terminal: string[] = [];
  for (const event of events) {
    if (event.type === 'response.output_item.added' && event.item.type === 'function_call') added.push(event.item.call_id);
    if (event.type === 'response.output_item.done' && event.item.type === 'function_call') done.push(event.item.call_id);
    if (event.type === 'response.completed' || event.type === 'response.incomplete')
      terminal = event.response.output.flatMap((item) => (item.type === 'function_call' ? [item.call_id] : []));
  }
  return { added, done, terminal };
};

const ISSUED = /^call_[0-9a-f]{32}$/;

const drain = async (stream: AsyncIterable<StreamEvent>): Promise<string[]> => {
  const types: string[] = [];
  for await (const event of stream) types.push(event.type);
  return types;
};

const options = (key: string, signal = new AbortController().signal) => ({ idempotencyKey: key, deadlineAt: 0, signal });

describe('fake gateway', () => {
  it('replays a completed generation for the same key without generating again', async () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    gateway.script.push(textStep('a'), textStep('b'));
    const first = await drain(gateway.stream(BODY, options('k1')));
    const second = await drain(gateway.stream(BODY, options('k1')));
    expect(second).toEqual(first);
    expect(first.at(-1)).toBe('response.completed');
    expect(gateway.generations.get('k1')).toBe(1);
    expect(gateway.script).toHaveLength(1);
    expect(gateway.streams.map((stream) => stream.deduplicated)).toEqual([false, true]);
  });

  it('attaches a second request to an in-flight generation', async () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    const step = gated(textStep('slow'), 2);
    gateway.script.push(step);
    const leader = drain(gateway.stream(BODY, options('k1')));
    await within(step.gate.reached.promise, 1000, 'the gate');
    const follower = drain(gateway.stream(BODY, options('k1')));
    step.gate.release.resolve();
    const [led, followed] = await Promise.all([leader, follower]);
    expect(followed).toEqual(led);
    expect(gateway.generations.get('k1')).toBe(1);
  });

  it('does not store failed generations, so a re-send generates again', async () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    gateway.script.push(failedStep('upstream_unavailable'), thrownStep(), textStep('ok'));
    expect((await drain(gateway.stream(BODY, options('k1')))).at(-1)).toBe('response.failed');
    await expect(drain(gateway.stream(BODY, options('k1')))).rejects.toThrow('gateway connection reset');
    expect((await drain(gateway.stream(BODY, options('k1')))).at(-1)).toBe('response.completed');
    expect(gateway.generations.get('k1')).toBe(3);
  });

  it('rejects a blocked stream when its signal aborts', async () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    const step = gated(textStep('never'), 0);
    gateway.script.push(step);
    const controller = new AbortController();
    const pending = drain(gateway.stream(BODY, options('k1', controller.signal)));
    await within(step.gate.reached.promise, 1000, 'the gate');
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});

describe('fake gateway call ids', () => {
  it('rewrites every call id to call_ plus 32 hex, the same id in streamed items and in the final output', async () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    gateway.script.push(callsStep([{ callId: 'call_m_1', name: 'Mark', args: { value: 'a' } }, { callId: 'call_m_2', name: 'Mark', args: { value: 'b' } }]));
    const { added, done, terminal } = callIdsOf(await collectEvents(gateway.stream(BODY, options('k1'))));
    expect(added).toHaveLength(2);
    for (const callId of added) expect(callId).toMatch(ISSUED);
    expect(done).toEqual(added);
    expect(terminal).toEqual(added);
    expect(new Set(added).size).toBe(2);
    expect(gateway.callId('call_m_1')).toBe(added[0]);
    expect(gateway.callId('call_m_2')).toBe(added[1]);
  });

  it('issues one id per upstream id per response, so a repeated script id gets a fresh id in the next response', async () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    const call = { callId: 'call_m_1', name: 'Mark', args: { value: 'a' } };
    gateway.script.push(callsStep([call]), callsStep([call]));
    const first = callIdsOf(await collectEvents(gateway.stream(BODY, options('k1'))));
    const second = callIdsOf(await collectEvents(gateway.stream(BODY, options('k2'))));
    expect(first.terminal[0]).not.toBe(second.terminal[0]);
    expect(gateway.issuedCallIds('call_m_1')).toEqual([first.terminal[0], second.terminal[0]]);
    expect(gateway.callId('call_m_1')).toBe(first.terminal[0]);
    expect(gateway.callId('call_m_1', 1)).toBe(second.terminal[0]);
  });

  it('maps a script id repeated inside one response to a single issued id', async () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    const call = { callId: 'call_d_1', name: 'Mark', args: { value: 'a' } };
    gateway.script.push(callsStep([call, call]));
    const { terminal } = callIdsOf(await collectEvents(gateway.stream(BODY, options('k1'))));
    expect(terminal).toHaveLength(2);
    expect(terminal[0]).toBe(terminal[1]);
    expect(gateway.issuedCallIds('call_d_1')).toEqual([terminal[0]]);
  });

  it('rewrites calls inside an incomplete response', async () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    gateway.script.push(incompleteStep([functionCallItem({ callId: 'call_i_1', name: 'Echo', args: { value: 'x' } })]));
    const { added, terminal } = callIdsOf(await collectEvents(gateway.stream(BODY, options('k1'))));
    expect(terminal).toEqual(added);
    expect(terminal[0]).toMatch(ISSUED);
    expect(gateway.callId('call_i_1')).toBe(terminal[0]);
  });

  it('replays the same issued ids for the same idempotency key', async () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    gateway.script.push(callsStep([{ callId: 'call_m_1', name: 'Mark', args: { value: 'a' } }]));
    const first = callIdsOf(await collectEvents(gateway.stream(BODY, options('k1'))));
    const replayed = callIdsOf(await collectEvents(gateway.stream(BODY, options('k1'))));
    expect(replayed).toEqual(first);
    expect(gateway.issuedCallIds('call_m_1')).toHaveLength(1);
  });

  it('passes script ids through unchanged when rewriting is off', async () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    gateway.rewriteCallIds = false;
    gateway.script.push(callsStep([{ callId: 'call_1', name: 'Mark', args: { value: 'a' } }]));
    const { added, done, terminal } = callIdsOf(await collectEvents(gateway.stream(BODY, options('k1'))));
    expect([added, done, terminal]).toEqual([['call_1'], ['call_1'], ['call_1']]);
    expect(gateway.issuedCallIds('call_1')).toEqual([]);
  });

  it('throws for a script id that was never issued', () => {
    const gateway = createFakeGateway(capabilitiesFor(1000));
    expect(() => gateway.callId('call_none')).toThrow(/call_none/);
  });
});
