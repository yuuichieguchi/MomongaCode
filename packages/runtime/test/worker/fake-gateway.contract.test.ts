import { describe, expect, it } from 'vitest';
import type { CompactRequest, CountTokensRequest, CreateResponseBody, StreamEvent } from '@momonga/protocol';
import { callOptions, createdEvent, fakeClock, makeClient, openSse, sseFrame, startRawHttpFake, streamBody } from '../gateway-client/fixtures.ts';
import { createFakeGateway } from './fake-gateway.ts';
import { capabilitiesFor } from './harness.ts';
import { gated, textStep } from './scripts.ts';

type Stage = 'before the call' | 'before the first event' | 'after the first event';

const REASONS = ['cancel', 'lease_lost', 'shutdown'] as const;
const STAGES: readonly Stage[] = ['before the call', 'before the first event', 'after the first event'];

const rejectionOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return { rejected: error };
  }
  throw new Error('the aborted call did not reject');
};

const abortedAt = async (stream: AsyncIterable<StreamEvent>, controller: AbortController, reason: string, stage: Stage, replyHeld: Promise<void>): Promise<unknown> => {
  const events = stream[Symbol.asyncIterator]();
  if (stage === 'before the call') {
    controller.abort(reason);
    return rejectionOf(events.next());
  }
  if (stage === 'before the first event') {
    const first = events.next();
    await replyHeld;
    controller.abort(reason);
    return rejectionOf(first);
  }
  expect((await events.next()).done).toBe(false);
  const second = events.next();
  await replyHeld;
  controller.abort(reason);
  return rejectionOf(second);
};

const throughRealClient = async (reason: string, stage: Stage): Promise<unknown> => {
  const clock = fakeClock();
  const fake = await startRawHttpFake();
  let held: () => void = () => undefined;
  const replyHeld = new Promise<void>((resolve) => {
    held = resolve;
  });
  fake.respond((_request, response) => {
    if (stage === 'after the first event') {
      openSse(response);
      response.write(sseFrame(createdEvent));
    }
    held();
  });
  const controller = new AbortController();
  const client = makeClient(fake.socketPath, clock);
  return abortedAt(client.stream(streamBody(), callOptions(clock, { signal: controller.signal })), controller, reason, stage, replyHeld);
};

const throughFake = async (reason: string, stage: Stage): Promise<unknown> => {
  const clock = fakeClock();
  const gateway = createFakeGateway(capabilitiesFor(100_000));
  const step = gated(textStep('late answer', { chunks: ['late ', 'answer'] }), stage === 'after the first event' ? 1 : 0);
  gateway.script.push(step);
  const controller = new AbortController();
  const events = gateway.stream(streamBody(), callOptions(clock, { signal: controller.signal }));
  return abortedAt(events, controller, reason, stage, stage === 'before the call' ? Promise.resolve() : step.gate.reached.promise);
};

describe('the fake gateway of the worker tests ends an aborted model call with the value the real client ends it with', () => {
  it.for(REASONS.flatMap((reason) => STAGES.map((stage) => [reason, stage] as const)))('reason %s, aborted %s', async ([reason, stage]) => {
    const real = await throughRealClient(reason, stage);
    const fake = await throughFake(reason, stage);

    expect(real).toEqual({ rejected: reason });
    expect(fake).toEqual(real);
  });

  it('rejects a compact call whose signal is already aborted with the reason, as the real client does', async () => {
    const clock = fakeClock();
    const request: CompactRequest = { model: 'default', input: streamBody().input };
    const fake = await startRawHttpFake();
    const real = await rejectionOf(makeClient(fake.socketPath, clock).compact(request, callOptions(clock, { signal: AbortSignal.abort('shutdown') })));
    const faked = await rejectionOf(createFakeGateway(capabilitiesFor(100_000)).compact(request, callOptions(clock, { signal: AbortSignal.abort('shutdown') })));

    expect(real).toEqual({ rejected: 'shutdown' });
    expect(faked).toEqual(real);
    expect(fake.requests).toEqual([]);
  });
});

describe('the fake gateway refuses the request the gateway refuses, by the gateway own validator', () => {
  const live = (): { signal: AbortSignal } => ({ signal: new AbortController().signal });

  it('fails a model call whose body the validator refuses, before any scripted step is taken', async () => {
    const clock = fakeClock();
    const gateway = createFakeGateway(capabilitiesFor(100_000));
    gateway.script.push(textStep('never sent'));
    const refused = { ...streamBody(), input: [{ type: 'message', role: 'user' }] } as unknown as CreateResponseBody;

    await expect(gateway.stream(refused, callOptions(clock))[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'GatewayError', status: 400, body: { type: 'invalid_request', param: 'input[0].content' } });
    expect(gateway.script).toHaveLength(1);
  });

  it('fails a model call that names no model', async () => {
    const clock = fakeClock();
    const gateway = createFakeGateway(capabilitiesFor(100_000));
    gateway.script.push(textStep('never sent'));

    await expect(gateway.stream({ ...streamBody(), model: '' }, callOptions(clock))[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'GatewayError', status: 400 });
  });

  it('fails a compact call and a count call whose items the validator refuses', async () => {
    const clock = fakeClock();
    const gateway = createFakeGateway(capabilitiesFor(100_000));
    const items = [{ type: 'function_call_output' }];

    await expect(gateway.compact({ model: 'default', input: items } as unknown as CompactRequest, callOptions(clock))).rejects.toMatchObject({ name: 'GatewayError', status: 400 });
    await expect(gateway.countTokens({ model: 'default', input: items } as unknown as CountTokensRequest, live())).rejects.toMatchObject({ name: 'GatewayError', status: 400 });
  });

  it('answers a request the validator accepts', async () => {
    const clock = fakeClock();
    const gateway = createFakeGateway(capabilitiesFor(100_000));
    gateway.script.push(textStep('hello'));
    const seen: string[] = [];
    for await (const event of gateway.stream(streamBody(), callOptions(clock))) seen.push(event.type);

    expect(seen.at(-1)).toBe('response.completed');
  });
});
