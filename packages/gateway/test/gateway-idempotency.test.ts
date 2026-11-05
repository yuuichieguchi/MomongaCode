import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import {
  expectErrorBody,
  outputText,
  postJson,
  readJson,
  readSse,
  registerCleanup,
  sseIterator,
  startGateway,
  userInput,
  type SseFrame,
} from './gateway-helpers.ts';

const events = (text: string) => textResponseEvents({ model: 'scripted-primary', chunks: [text] });
const body = { model: 'fast', input: userInput('hi') };
const streamBody = { ...body, stream: true };
const key = (value: string) => ({ 'idempotency-key': value });
const JOINER_DEADLINE_MS = 60_000;
const CLIENT_RECEIPT_WINDOW_MS = 50;

const drain = async (iterator: AsyncIterator<SseFrame>, initial: SseFrame[]): Promise<SseFrame[]> => {
  const frames = [...initial];
  for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) frames.push(step.value);
  return frames;
};

describe('Idempotency-Key', () => {
  it('coalesces two concurrent identical non-stream requests into one adapter call with identical results', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('once'), gate: { name: 'g', afterEvents: 0 } }] });
    const { client } = await startGateway({ adapters: { primary } });
    const first = postJson(client, '/v1/responses', body, key('k-1'));
    await waitFor(() => primary.calls.length === 1);
    const second = postJson(client, '/v1/responses', body, key('k-1'));
    primary.release('g');
    const [a, b] = await Promise.all([readJson(await first), readJson(await second)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(outputText(a.body)).toBe('once');
    expect(primary.calls).toHaveLength(1);
  });

  it('gives a stream joining mid-flight the full identical event sequence from the start', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('shared'), gate: { name: 'g', afterEvents: 2 } }] });
    const { client, timers } = await startGateway({ adapters: { primary } });
    registerCleanup(() => primary.release('g'));
    const firstPending = postJson(client, '/v1/responses', streamBody, key('k-2'));
    let firstArrived = false;
    const markArrived = (): void => {
      firstArrived = true;
    };
    void firstPending.then(markArrived, markArrived);
    await waitFor(() => primary.calls[0]?.emitted === 2, { description: 'the opening events' });
    await new Promise((resolve) => setTimeout(resolve, CLIENT_RECEIPT_WINDOW_MS));
    const heldBeforeOutput = !firstArrived;

    const secondPending = postJson(client, '/v1/responses', streamBody, { ...key('k-2'), 'momonga-deadline-ms': String(JOINER_DEADLINE_MS) });
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === JOINER_DEADLINE_MS), {
      description: 'the joiner subscribed to the in-flight run',
      maxTurns: 20_000,
    });
    primary.release('g');

    const secondResponse = await secondPending;
    expect(secondResponse.status).toBe(200);
    const firstIterator = sseIterator(await firstPending);
    const secondIterator = sseIterator(secondResponse);
    const firstStep = await firstIterator.next();
    const secondStep = await secondIterator.next();
    expect(heldBeforeOutput).toBe(true);
    const firstAll = await drain(firstIterator, firstStep.done === true ? [] : [firstStep.value]);
    const secondAll = await drain(secondIterator, secondStep.done === true ? [] : [secondStep.value]);
    expect(firstAll.slice(0, 2).map((frame) => frame.data.type)).toEqual(['response.created', 'response.in_progress']);
    expect(secondAll).toEqual(firstAll);
    expect(firstAll.at(-1)?.data.type).toBe('response.completed');
    expect(primary.calls).toHaveLength(1);
  });

  it('replays a completed result, streamed and non-streamed, without calling the adapter again', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('stored') }] });
    const { client } = await startGateway({ adapters: { primary } });
    const original = await readSse(await postJson(client, '/v1/responses', streamBody, key('k-3')));
    const replayed = await readSse(await postJson(client, '/v1/responses', streamBody, key('k-3')));
    expect(replayed).toEqual(original);
    expect(primary.calls).toHaveLength(1);

    const plainOriginal = createScriptedAdapter({ calls: [{ events: events('plain') }] });
    const second = await startGateway({ adapters: { primary: plainOriginal } });
    const firstPlain = await readJson(await postJson(second.client, '/v1/responses', body, key('k-4')));
    const replayPlain = await readJson(await postJson(second.client, '/v1/responses', body, key('k-4')));
    expect(replayPlain.status).toBe(200);
    expect(replayPlain.body).toEqual(firstPlain.body);
    expect(plainOriginal.calls).toHaveLength(1);
  });

  it('does not cache a failed result, so a retry with the same key calls the adapter again', async () => {
    const primary = createScriptedAdapter({
      calls: [{ failure: { status: 400, message: 'rejected once' } }, { events: events('second time') }],
    });
    const { client } = await startGateway({ adapters: { primary } });
    const failed = await readJson(await postJson(client, '/v1/responses', body, key('k-5')));
    expect(failed.status).toBe(400);
    const retried = await readJson(await postJson(client, '/v1/responses', body, key('k-5')));
    expect(retried.status).toBe(200);
    expect(outputText(retried.body)).toBe('second time');
    expect(primary.calls).toHaveLength(2);
  });

  it('rejects the same key with a different body digest with 422 idempotency_key_reused', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('first') }] });
    const { client } = await startGateway({ adapters: { primary } });
    expect((await readJson(await postJson(client, '/v1/responses', body, key('k-6')))).status).toBe(200);
    const reused = await readJson(
      await postJson(client, '/v1/responses', { model: 'fast', input: userInput('different') }, key('k-6')),
    );
    expect(reused.status).toBe(422);
    expectErrorBody(reused.body, { type: 'invalid_request', code: 'idempotency_key_reused', param: null });
    expect(primary.calls).toHaveLength(1);
  });

  it('treats a key-order-only difference in the body as the same digest', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('canonical') }] });
    const { client } = await startGateway({ adapters: { primary } });
    const first = await readJson(await postJson(client, '/v1/responses', '{"model":"fast","input":"hi"}', key('k-7')));
    const second = await readJson(await postJson(client, '/v1/responses', '{"input":"hi","model":"fast"}', key('k-7')));
    expect(second.body).toEqual(first.body);
    expect(primary.calls).toHaveLength(1);
  });

  it('expires entries after idempotency.ttlMs', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('before') }, { events: events('after') }] });
    const { client, clock } = await startGateway({ adapters: { primary }, config: { idempotency: { ttlMs: 60_000 } } });
    await readJson(await postJson(client, '/v1/responses', body, key('k-8')));
    clock.advance(59_999);
    expect(outputText((await readJson(await postJson(client, '/v1/responses', body, key('k-8')))).body)).toBe('before');
    expect(primary.calls).toHaveLength(1);
    clock.advance(2);
    expect(outputText((await readJson(await postJson(client, '/v1/responses', body, key('k-8')))).body)).toBe('after');
    expect(primary.calls).toHaveLength(2);
  });

  it('treats the sf-string form of a key as the same key as its bare token', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('quoted') }, { events: events('unexpected') }] });
    const { client } = await startGateway({ adapters: { primary } });
    const quoted = await readJson(await postJson(client, '/v1/responses', body, key('"k-sf"')));
    const bare = await readJson(await postJson(client, '/v1/responses', body, key('k-sf')));
    const quotedAgain = await readJson(await postJson(client, '/v1/responses', body, key('"k-sf"')));
    expect(quoted.status).toBe(200);
    expect(bare.body).toEqual(quoted.body);
    expect(quotedAgain.body).toEqual(quoted.body);
    expect(outputText(quoted.body)).toBe('quoted');
    expect(primary.calls).toHaveLength(1);
  });

  it('rejects a reused sf-string key with a different body with 422', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('first') }, { events: events('unexpected') }] });
    const { client } = await startGateway({ adapters: { primary } });
    expect((await readJson(await postJson(client, '/v1/responses', body, key('"k-sf-2"')))).status).toBe(200);
    const reused = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('different') }, key('k-sf-2')));
    expect(reused.status).toBe(422);
    expectErrorBody(reused.body, { type: 'invalid_request', code: 'idempotency_key_reused', param: null });
    expect(primary.calls).toHaveLength(1);
  });

  it('keeps keys independent', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('one') }, { events: events('two') }] });
    const { client } = await startGateway({ adapters: { primary } });
    const one = await readJson(await postJson(client, '/v1/responses', body, key('k-a')));
    const two = await readJson(await postJson(client, '/v1/responses', body, key('k-b')));
    expect(outputText(one.body)).toBe('one');
    expect(outputText(two.body)).toBe('two');
    expect(primary.calls).toHaveLength(2);
  });
});
