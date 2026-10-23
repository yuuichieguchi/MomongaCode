import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import {
  expectErrorBody,
  outputText,
  postJson,
  readJson,
  readSse,
  sseIterator,
  startGateway,
  userInput,
  type SseFrame,
} from './gateway-helpers.ts';

const events = (text: string) => textResponseEvents({ model: 'scripted-primary', chunks: [text] });
const body = { model: 'fast', input: userInput('hi') };
const streamBody = { ...body, stream: true };
const key = (value: string) => ({ 'idempotency-key': value });

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
    const { client } = await startGateway({ adapters: { primary } });
    const firstResponse = await postJson(client, '/v1/responses', streamBody, key('k-2'));
    const firstIterator = sseIterator(firstResponse);
    const firstHead: SseFrame[] = [];
    for (let index = 0; index < 2; index += 1) {
      const step = await firstIterator.next();
      if (step.done !== true) firstHead.push(step.value);
    }
    expect(firstHead.map((frame) => frame.data.type)).toEqual(['response.created', 'response.in_progress']);

    const secondResponse = await postJson(client, '/v1/responses', streamBody, key('k-2'));
    expect(secondResponse.status).toBe(200);
    const secondIterator = sseIterator(secondResponse);
    const secondFirst = await secondIterator.next();
    expect(secondFirst.done).not.toBe(true);
    primary.release('g');

    const firstAll = await drain(firstIterator, firstHead);
    const secondAll = await drain(secondIterator, secondFirst.done === true ? [] : [secondFirst.value]);
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

  it('rejects the same key with a different body digest as idempotency_key_reused', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('first') }] });
    const { client } = await startGateway({ adapters: { primary } });
    expect((await readJson(await postJson(client, '/v1/responses', body, key('k-6')))).status).toBe(200);
    const reused = await readJson(
      await postJson(client, '/v1/responses', { model: 'fast', input: userInput('different') }, key('k-6')),
    );
    expect(reused.status).toBe(400);
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
