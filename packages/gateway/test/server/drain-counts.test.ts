import { describe, expect, it } from 'vitest';
import type { Capabilities, CountTokensResult } from '@momonga/protocol';
import { DEFAULT_SCRIPTED_CAPABILITIES, createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { getJson, postJson, readJson, registerCleanup, startGateway, userInput } from '../gateway-helpers.ts';
import { openRawPost } from '../gateway-support.ts';

const MODEL = 'scripted/scripted-primary';
const DETACHED_MAX_MS = 1_800_000;
const CLOSE_GRACE_MS = 750;

const COUNTED: CountTokensResult = { input_tokens: 7, method: 'exact', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } };

const events = (text: string) => textResponseEvents({ model: 'scripted-primary', chunks: [text] });

const held = <T>() => {
  let release: (value: T) => void = () => undefined;
  const asked = { count: 0 };
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { asked, release, wait: (): Promise<T> => ((asked.count += 1), promise) };
};

describe('one registry counts every request in flight (gateway-core-C26)', () => {
  it('counts a detached keyed response and a count-tokens request as two', async () => {
    const counting = held<CountTokensResult>();
    const primary = Object.assign(createScriptedAdapter({ calls: [{ events: events('detached'), gate: { name: 'g', afterEvents: 2 } }] }), {
      countTokens: () => counting.wait(),
    });
    const { gateway, client, socketPath, timers } = await startGateway({ adapters: { [MODEL]: primary } });
    registerCleanup(() => primary.release('g'));
    registerCleanup(() => counting.release(COUNTED));
    expect(gateway.activeRequests()).toBe(0);

    const raw = await openRawPost(socketPath, '/v1/responses', { model: MODEL, input: userInput('hi'), stream: true }, { headers: { 'idempotency-key': 'drain-1' } });
    await waitFor(() => primary.calls[0]?.emitted === 2, { description: 'the first frames of the keyed response' });
    expect(gateway.activeRequests()).toBe(1);
    raw.socket.destroy();
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === DETACHED_MAX_MS), { description: 'the keyed response detached from its client', maxTurns: 20_000 });
    await waitFor(() => gateway.activeRequests() === 1, { description: 'the request of the gone client ended', maxTurns: 20_000 });

    const counted = postJson(client, '/v1/momonga/count_tokens', { model: MODEL, input: userInput('hi') });
    await waitFor(() => counting.asked.count === 1, { description: 'the count-tokens request reached its adapter' });

    expect(gateway.activeRequests()).toBe(2);

    counting.release(COUNTED);
    expect((await readJson(await counted)).status).toBe(200);
    await waitFor(() => gateway.activeRequests() === 1, { description: 'the count-tokens request ended' });
    primary.release('g');
    await waitFor(() => gateway.activeRequests() === 0, { description: 'the detached response ended', maxTurns: 20_000 });
  });

  it('reports an idle gateway as holding nothing through its own health read', async () => {
    const { client } = await startGateway({ adapters: { [MODEL]: createScriptedAdapter({ calls: [] }) } });

    expect((await getJson(client, '/v1/momonga/health')).body.activeRequests).toBe(0);
  });

  it('answers a models read that was in flight when close started, before its connection closes', async () => {
    const capabilities = held<Capabilities>();
    const primary = Object.assign(createScriptedAdapter({ calls: [] }), { capabilities: () => capabilities.wait() });
    const { gateway, client, timers } = await startGateway({ adapters: { [MODEL]: primary }, config: { closeGraceMs: CLOSE_GRACE_MS } });
    registerCleanup(() => capabilities.release(DEFAULT_SCRIPTED_CAPABILITIES));

    const reading = getJson(client, '/v1/momonga/models');
    await waitFor(() => capabilities.asked.count >= 1, { description: 'the models read to reach its adapter' });
    expect(gateway.activeRequests()).toBe(1);

    const closing = gateway.close();
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === CLOSE_GRACE_MS), { description: 'the close to wait for the read under its grace' });
    capabilities.release(DEFAULT_SCRIPTED_CAPABILITIES);

    const listing = await reading;
    expect(listing.status).toBe(200);
    expect(listing.body.data.map((entry: { id: string }) => entry.id)).toEqual([MODEL]);
    await closing;
    expect(gateway.abandonedRuns).toBe(0);
    expect(timers.pending()).toEqual([]);
  });
});
