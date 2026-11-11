import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@momonga/protocol';
import { createFakeClock, createFakeTimers, createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { sseResponse } from '../src/server/sse.ts';
import { START_MS, postJson, startGateway, userInput } from './gateway-helpers.ts';
import { BUDGET, driveTimers } from './retry-support.ts';

const IDLE_HEADER = 'momonga-stream-idle-ms';
const request = { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true };
const decoder = new TextDecoder();

const errorEventOf = (text: string): unknown => {
  const frame = text.split('\n\n').find((part) => part.includes('event: error'));
  if (frame === undefined) throw new Error(`no error frame in: ${text}`);
  return JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6) as string);
};

type Chunks = AsyncIterator<Uint8Array | string>;

const nextText = async (chunks: Chunks): Promise<string> => {
  const step = await chunks.next();
  if (step.done === true) throw new Error('the stream ended');
  return typeof step.value === 'string' ? step.value : decoder.decode(step.value);
};

const drain = async (chunks: Chunks): Promise<string> => {
  let text = '';
  for (let step = await chunks.next(); step.done !== true; step = await chunks.next()) {
    text += typeof step.value === 'string' ? step.value : decoder.decode(step.value);
  }
  return text;
};

describe('gateway stream liveness before the first upstream event', () => {
  it('answers at once and writes comment lines at a third of the runtime idle bound while the upstream is silent', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['late'] }), gate: { name: 'g', afterEvents: 0 } }],
    });
    const { client, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { sseKeepAliveMs: 15_000 } });

    const response = await postJson(client, '/v1/responses', request, { [IDLE_HEADER]: '3000' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
    const chunks = response.body[Symbol.asyncIterator]();
    expect(await nextText(chunks)).toMatch(/^:/);
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 1000), { description: 'the keep-alive timer' });
    timers.advance(1000);
    expect(await nextText(chunks)).toMatch(/^:/);
    expect(primary.calls[0]?.emitted).toBe(0);

    primary.release('g');
    const rest = await drain(chunks);
    expect(rest).toContain('event: response.completed');
    expect(timers.pending()).toEqual([]);
  });

  it('never writes comments less often than the configured sseKeepAliveMs', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['late'] }), gate: { name: 'g', afterEvents: 0 } }],
    });
    const { client, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { sseKeepAliveMs: 2500 } });

    const response = await postJson(client, '/v1/responses', request, { [IDLE_HEADER]: '3600000' });

    const chunks = response.body[Symbol.asyncIterator]();
    await nextText(chunks);
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 2500), { description: 'the keep-alive timer' });
    timers.advance(2500);
    expect(await nextText(chunks)).toMatch(/^:/);
    expect(primary.calls[0]?.emitted).toBe(0);
    primary.release('g');
    await drain(chunks);
  });

  it('rejects an idle bound that is not a positive integer', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const response = await postJson(client, '/v1/responses', request, { [IDLE_HEADER]: 'soon' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_stream_idle');
  });

  it('still falls back to the next target after comment lines were written', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const primary = createScriptedAdapter({ calls: [{ delayMs: 3500, failure: { status: 500, message: 'primary is down' } }], timers });
    const secondary = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-secondary', chunks: ['from secondary'] }) }] });
    const { client } = await startGateway({
      adapters: { 'scripted/scripted-primary': primary, 'scripted/scripted-secondary': secondary },
      clock,
      timers,
      config: {
        chains: { 'scripted/scripted-primary': ['scripted/scripted-primary', 'scripted/scripted-secondary'] },
        targets: { 'scripted/scripted-primary': {}, 'scripted/scripted-secondary': {} },
        retry: { maxAttempts: 1, totalWaitMs: 1, baseMs: 100, maxMs: 10_000 },
      },
    });

    const response = await postJson(client, '/v1/responses', request, { [IDLE_HEADER]: '3000' });
    const chunks = response.body[Symbol.asyncIterator]();
    expect(await nextText(chunks)).toMatch(/^:/);
    for (let round = 0; round < 3; round += 1) {
      await waitFor(() => timers.pending().some((timer) => timer.delayMs === 1000), { description: 'the keep-alive timer' });
      timers.advance(1000);
      expect(await nextText(chunks)).toMatch(/^:/);
    }
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 3500), { description: 'the primary failure timer' });
    timers.advance(500);

    const rest = await drain(chunks);
    expect(rest).toContain('from secondary');
    expect(rest).toContain('"fallbackFrom":["scripted/scripted-primary"]');
    expect(secondary.calls).toHaveLength(1);
  });

  it('reports a failure before the first event as an error event carrying the HTTP status', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 422, message: 'bad schema' } }] });
    const { client, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const response = await postJson(client, '/v1/responses', request, { [IDLE_HEADER]: '3000' });

    expect(response.status).toBe(200);
    const text = await drain(response.body[Symbol.asyncIterator]());
    const frame = text.split('\n\n').find((part) => part.includes('event: error'));
    expect(frame).toBeDefined();
    const event = JSON.parse((frame as string).split('\n').find((line) => line.startsWith('data: '))?.slice(6) as string);
    expect(event).toMatchObject({ type: 'error', status: 400, error: { type: 'invalid_request', code: 'upstream_rejected' } });
    expect(timers.pending()).toEqual([]);
  });

  it('carries retry_after_ms and no deferral in the error event of a rate-limited call whose next wait does not fit the remaining budget', async () => {
    const primary = createScriptedAdapter({
      calls: [
        { failure: { status: 429, message: 'slow down', retryAfterMs: 4000 } },
        { failure: { status: 429, message: 'slow down again', retryAfterMs: 4000 } },
      ],
    });
    const harness = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { retry: { maxAttempts: 1, totalWaitMs: 6000, baseMs: 100, maxMs: 10_000 } } });
    const reading = postJson(harness.client, '/v1/responses', request, { [IDLE_HEADER]: '3000' }).then((response) => drain(response.body[Symbol.asyncIterator]()));

    await driveTimers(harness, [reading], (timer) => timer.delayMs === 1000);
    const event = errorEventOf(await reading) as { deferred?: boolean };

    expect(event).toMatchObject({ type: 'error', status: 429, retry_after_ms: 4000 });
    expect(event.deferred).toBeUndefined();
    expect(primary.calls).toHaveLength(2);
  });

  it('carries the deferral in the error event of a stream whose only target asks for longer than the whole budget', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 429, message: 'come back later', retryAfterMs: 100_000 } }] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { retry: BUDGET } });

    const response = await postJson(client, '/v1/responses', request, { [IDLE_HEADER]: '3000' });

    expect(errorEventOf(await drain(response.body[Symbol.asyncIterator]()))).toMatchObject({
      type: 'error',
      status: 429,
      retry_after_ms: 100_000,
      deferred: true,
      error: { code: 'rate_limited' },
    });
    expect(primary.calls).toHaveLength(1);
  });

  it('sends a later stream to the only target although its breaker is open, and reports that target error', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 500, message: 'down' } }, { failure: { status: 500, message: 'still down' } }] });
    const { client } = await startGateway({
      adapters: { 'scripted/scripted-primary': primary },
      config: { retry: { maxAttempts: 1, totalWaitMs: 1, baseMs: 100, maxMs: 10_000 }, breaker: { failureThreshold: 1, openMs: 30_000 } },
    });
    await (await postJson(client, '/v1/responses', request, { [IDLE_HEADER]: '3000' })).text();

    const response = await postJson(client, '/v1/responses', request, { [IDLE_HEADER]: '3000' });

    expect(errorEventOf(await drain(response.body[Symbol.asyncIterator]()))).toMatchObject({
      type: 'error',
      status: 502,
      error: { code: 'upstream_error', message: expect.stringContaining('still down') },
    });
    expect(primary.calls).toHaveLength(2);
  });
});

describe('compaction liveness', () => {
  const compactRequest = { model: 'scripted/scripted-primary', input: userInput('hi') };

  const frameOf = (text: string, name: string): { event: string; data: unknown } | undefined => {
    const frame = text.split('\n\n').find((part) => part.includes(`event: ${name}`));
    if (frame === undefined) return undefined;
    return { event: name, data: JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6) as string) };
  };

  it('opens at once and writes comment lines while the compaction runs, then sends the result as its final event', async () => {
    const primary = createScriptedAdapter({ calls: [], compactSummary: 'GOAL: x', compactGate: 'g' });
    const { client, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { sseKeepAliveMs: 15_000 } });

    const response = await postJson(client, '/v1/responses/compact', compactRequest, { [IDLE_HEADER]: '3000' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
    const chunks = response.body[Symbol.asyncIterator]();
    expect(await nextText(chunks)).toMatch(/^:/);
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 1000), { description: 'the keep-alive timer' });
    timers.advance(1000);
    expect(await nextText(chunks)).toMatch(/^:/);

    primary.release('g');
    const rest = await drain(chunks);
    expect(frameOf(rest, 'compaction')?.data).toMatchObject({ object: 'response.compaction', output: [{ type: 'compaction' }] });
    expect(rest.trimEnd().split('\n\n').at(-1)).toContain('event: compaction');
    expect(timers.pending()).toEqual([]);
  });

  it('answers a compaction without the header as one JSON body, as before', async () => {
    const primary = createScriptedAdapter({ calls: [], compactSummary: 'GOAL: x' });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const response = await postJson(client, '/v1/responses/compact', compactRequest);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(((await response.json()) as { object: string }).object).toBe('response.compaction');
  });

  it('still rejects a malformed compaction request with its HTTP status when the header is present', async () => {
    const primary = createScriptedAdapter({ calls: [], compactSummary: 'GOAL: x' });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const response = await postJson(client, '/v1/responses/compact', { input: userInput('hi') }, { [IDLE_HEADER]: '3000' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_body');
  });

  it('rejects an idle bound that is not a positive integer on a compaction too', async () => {
    const primary = createScriptedAdapter({ calls: [], compactSummary: 'GOAL: x' });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const response = await postJson(client, '/v1/responses/compact', compactRequest, { [IDLE_HEADER]: 'soon' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_stream_idle');
  });

  it('reports a failed compaction as an error event carrying the HTTP status', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const response = await postJson(client, '/v1/responses/compact', compactRequest, { [IDLE_HEADER]: '3000' });

    expect(response.status).toBe(200);
    const text = await drain(response.body[Symbol.asyncIterator]());
    expect(frameOf(text, 'error')?.data).toMatchObject({ type: 'error', status: 400, error: { code: 'capability_unsupported' } });
    expect(timers.pending()).toEqual([]);
  });
});

describe('sseResponse before the first event', () => {
  const quietOptions = { readerStallMs: 30_000, signal: new AbortController().signal };

  it('answers an error that is not a GatewayError with a 500 error event and reports it', async () => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const failure = new Error('store exploded');
    const reported: unknown[] = [];
    const rest: AsyncIterator<StreamEvent> = {
      next: () => Promise.reject(failure),
      return: async () => ({ done: true, value: undefined }),
    };

    const response = sseResponse(undefined, rest, { ...quietOptions, timers, keepAliveMs: 1000, onError: (error) => reported.push(error) });

    expect(errorEventOf(await response.text())).toMatchObject({
      type: 'error',
      status: 500,
      error: { type: 'server_error', code: 'internal_error', message: 'store exploded' },
    });
    expect(reported).toEqual([failure]);
  });

  it('keeps erroring the stream once an event was written', async () => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const failure = new Error('late failure');
    const reported: unknown[] = [];
    const first = textResponseEvents({ model: 'm', chunks: ['x'] })[0] as StreamEvent;
    const rest: AsyncIterator<StreamEvent> = {
      next: () => Promise.reject(failure),
      return: async () => ({ done: true, value: undefined }),
    };

    const response = sseResponse(first, rest, { ...quietOptions, timers, keepAliveMs: 1000, onError: (error) => reported.push(error) });

    await expect(response.text()).rejects.toBe(failure);
    expect(reported).toEqual([]);
  });
});
