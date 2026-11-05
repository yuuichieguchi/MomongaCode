import { describe, expect, it } from 'vitest';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import {
  createFakeClock,
  messageEvents,
  openResponsesStream,
  openResponsesTextReply,
  openingEvents,
  startFakeOpenResponses,
  terminalEvent,
  waitFor,
} from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { START_MS, postJson, readJson, readSse, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { DEFERRED_HEADER } from './retry-support.ts';
import { REMOTE_CAPABILITIES, startOpenResponsesGateway, terminalOf, textOf } from './upstream-gateway-support.ts';

const streamBody = { model: 'fast', stream: true, input: userInput('hello') };

const rateLimitedBeforeOutput = (headers?: Record<string, string>): FakeUpstreamReply =>
  openResponsesStream(
    [...openingEvents(), terminalEvent({ kind: 'failed', code: 'rate_limited', message: 'slow down', errorType: 'too_many_requests' }, [])],
    headers === undefined ? {} : { headers },
  );

const openResponsesTarget = async (script: FakeUpstreamReply[]) => {
  const fake = await startFakeOpenResponses({ script });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  return { fake, adapter };
};

describe('a rate limit inside the stream before any output goes through classification and the budget (C1)', () => {
  it('retries a response.failed too_many_requests before output after the backoff wait, and answers once', async () => {
    const gateway = await startOpenResponsesGateway({ script: [rateLimitedBeforeOutput(), openResponsesTextReply(['recovered'])] });
    const pending = postJson(gateway.client, '/v1/responses', streamBody).then(readSse);
    let settled = false;
    const settle = (): void => {
      settled = true;
    };
    void pending.then(settle, settle);
    await waitFor(() => settled || gateway.timers.pending().length > 0, { description: 'the retry wait or the answer' });
    const waits = gateway.timers.pending().map((timer) => timer.delayMs);
    gateway.timers.advance(waits[0] ?? 0);
    const frames = await pending;

    expect(waits).toEqual([75]);
    expect(gateway.fake.requests).toHaveLength(2);
    expect(frames.filter((frame) => frame.data.type === 'response.created')).toHaveLength(1);
    expect(frames.some((frame) => frame.data.type === 'response.failed')).toBe(false);
    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.completed');
    expect(textOf(terminal.response)).toBe('recovered');
  });

  it('returns a deferral when the in-stream rate limit carries a Retry-After beyond the whole budget and no fallback exists', async () => {
    const gateway = await startOpenResponsesGateway({ script: [rateLimitedBeforeOutput({ 'retry-after': '100' })] });

    const reply = await readJson(await postJson(gateway.client, '/v1/responses', streamBody));

    expect(reply.status).toBe(429);
    expect(reply.body.error.code).toBe('rate_limited');
    expect(reply.headers['retry-after']).toBe('100');
    expect(reply.headers[DEFERRED_HEADER]).toBe('true');
    expect(gateway.fake.requests).toHaveLength(1);
  });

  it('falls back to the next target on an in-stream rate limit whose Retry-After is above retry.maxMs', async () => {
    const primary = await openResponsesTarget([rateLimitedBeforeOutput({ 'retry-after': '20' })]);
    const secondary = await openResponsesTarget([openResponsesTextReply(['from secondary'])]);
    const { client } = await startGateway({
      adapters: { primary: primary.adapter, secondary: secondary.adapter },
      config: {
        aliases: { fast: ['primary', 'secondary'] },
        targets: { primary: { model: 'upstream-model', kind: 'remote' }, secondary: { model: 'upstream-model', kind: 'remote' } },
      },
    });

    const frames = await readSse(await postJson(client, '/v1/responses', streamBody));

    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.completed');
    expect(textOf(terminal.response)).toBe('from secondary');
    expect(terminal.response.momonga.fallbackFrom).toEqual(['primary']);
    expect(primary.fake.requests).toHaveLength(1);
    expect(secondary.fake.requests).toHaveLength(1);
  });

  it('marks a 429-class failure after output retryable', async () => {
    const message = messageEvents(['partial']);
    const gateway = await startOpenResponsesGateway({
      script: [
        openResponsesStream([
          ...openingEvents(),
          ...message.events.slice(0, 3),
          terminalEvent({ kind: 'failed', code: 'rate_limited', message: 'slow down', errorType: 'too_many_requests' }, []),
        ]),
      ],
    });

    const frames = await readSse(await postJson(gateway.client, '/v1/responses', streamBody));

    const terminal = terminalOf(frames);
    expect(frames.some((frame) => frame.data.type === 'response.output_text.delta')).toBe(true);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.momonga.retryable).toBe(true);
    expect(gateway.fake.requests).toHaveLength(1);
  });
});
