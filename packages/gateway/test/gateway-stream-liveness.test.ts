import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { START_MS, postJson, startGateway, userInput } from './gateway-helpers.ts';

const IDLE_HEADER = 'momonga-stream-idle-ms';
const request = { model: 'fast', input: userInput('hi'), stream: true };
const decoder = new TextDecoder();

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
    const { client, timers } = await startGateway({ adapters: { primary }, config: { sseKeepAliveMs: 15_000 } });

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
    const { client, timers } = await startGateway({ adapters: { primary }, config: { sseKeepAliveMs: 2500 } });

    const response = await postJson(client, '/v1/responses', request, { [IDLE_HEADER]: '3600000' });

    const chunks = response.body[Symbol.asyncIterator]();
    await nextText(chunks);
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 2500), { description: 'the keep-alive timer' });
    primary.release('g');
    await drain(chunks);
  });

  it('rejects an idle bound that is not a positive integer', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary } });

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
      adapters: { primary, secondary },
      clock,
      timers,
      config: {
        aliases: { fast: ['primary', 'secondary'] },
        targets: { primary: { model: 'scripted-primary' }, secondary: { model: 'scripted-secondary' } },
        retry: { maxAttempts: 1, baseMs: 100, maxMs: 10_000 },
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
    expect(rest).toContain('"fallbackFrom":["primary"]');
    expect(secondary.calls).toHaveLength(1);
  });

  it('reports a failure before the first event as an error event carrying the HTTP status', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 422, message: 'bad schema' } }] });
    const { client, timers } = await startGateway({ adapters: { primary } });

    const response = await postJson(client, '/v1/responses', request, { [IDLE_HEADER]: '3000' });

    expect(response.status).toBe(200);
    const text = await drain(response.body[Symbol.asyncIterator]());
    const frame = text.split('\n\n').find((part) => part.includes('event: error'));
    expect(frame).toBeDefined();
    const event = JSON.parse((frame as string).split('\n').find((line) => line.startsWith('data: '))?.slice(6) as string);
    expect(event).toMatchObject({ type: 'error', status: 400, error: { type: 'invalid_request', code: 'upstream_rejected' } });
    expect(timers.pending()).toEqual([]);
  });
});
