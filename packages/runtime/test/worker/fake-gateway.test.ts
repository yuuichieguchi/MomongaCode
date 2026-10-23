import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@momonga/protocol';
import { within } from './deferred.ts';
import { createFakeGateway } from './fake-gateway.ts';
import { capabilitiesFor } from './harness.ts';
import { failedStep, gated, textStep, thrownStep } from './scripts.ts';

const BODY = { model: 'fm', input: 'hi' };

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
