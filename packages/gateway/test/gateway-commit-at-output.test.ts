import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { createUpstreamClassifier } from '../src/adapters/shared/classify.ts';
import { UpstreamHttpError } from '../src/adapters/shared/failures.ts';
import { outputText, postJson, readJson, readSse, startGateway } from './gateway-helpers.ts';
import { BREAKER_OUT_OF_THE_WAY, BUDGET, driveTimers, ok, request } from './retry-support.ts';

const full = textResponseEvents({ model: 'scripted-primary', chunks: ['partial', ' rest'] });
const BEFORE_OUTPUT = full.slice(0, 4);
const THROUGH_FIRST_DELTA = full.slice(0, 5);

const startOne = (calls: Parameters<typeof createScriptedAdapter>[0]['calls']) => {
  const primary = createScriptedAdapter({ calls });
  return { primary, started: startGateway({ adapters: { primary }, config: { retry: BUDGET, breaker: BREAKER_OUT_OF_THE_WAY } }) };
};

describe('the gateway commits at the first event that carries output (R-b)', () => {
  it('fixes the fixture: the first four events carry no output and the fifth is the first text delta', () => {
    expect(BEFORE_OUTPUT.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
    ]);
    expect(THROUGH_FIRST_DELTA.at(-1)?.type).toBe('response.output_text.delta');
  });

  it('retries an upstream failure that came after opening events but before any output, within the budget, and answers 200', async () => {
    const { primary, started } = startOne([{ events: BEFORE_OUTPUT, failure: { status: 503, message: 'down before output' } }, ok('recovered')]);
    const harness = await started;
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(waits).toEqual([375]);
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('recovered');
    expect(primary.calls).toHaveLength(2);
    expect(response.body.momonga.attempts).toBe(2);
  });

  it('streams one clean response to the client when a failure before output was retried', async () => {
    const { primary, started } = startOne([{ events: BEFORE_OUTPUT, failure: { status: 503, message: 'down before output' } }, ok('recovered')]);
    const harness = await started;
    const reading = postJson(harness.client, '/v1/responses', { ...request, stream: true }).then(readSse);

    await driveTimers(harness, [reading]);
    const frames = await reading;

    expect(primary.calls).toHaveLength(2);
    expect(frames.filter((frame) => frame.event === 'response.created')).toHaveLength(1);
    expect(frames.some((frame) => frame.event === 'response.failed' || frame.event === 'error')).toBe(false);
    expect(frames.at(-1)?.event).toBe('response.completed');
  });

  it('does not retry a failure after output and marks the failed response retryable for a retryable error', async () => {
    const { primary, started } = startOne([{ events: THROUGH_FIRST_DELTA, failure: { status: 503, message: 'down after output' } }, ok('never sent')]);
    const harness = await started;
    const reading = postJson(harness.client, '/v1/responses', { ...request, stream: true }).then(readSse);

    await driveTimers(harness, [reading]);
    const frames = await reading;

    expect(primary.calls).toHaveLength(1);
    const last = frames.at(-1);
    expect(last?.event).toBe('response.failed');
    expect(last?.data.response.momonga.retryable).toBe(true);
  });

  it('marks a failed response after output not retryable for a non-retryable error', async () => {
    const { primary, started } = startOne([{ events: THROUGH_FIRST_DELTA, failure: { status: 400, message: 'rejected after output' } }]);
    const harness = await started;
    const reading = postJson(harness.client, '/v1/responses', { ...request, stream: true }).then(readSse);
    await driveTimers(harness, [reading]);
    const frames = await reading;

    expect(primary.calls).toHaveLength(1);
    const last = frames.at(-1);
    expect(last?.event).toBe('response.failed');
    expect(last?.data.response.momonga.retryable).toBe(false);
  });
});

describe('Retry-After on every retryable status', () => {
  const classify = createUpstreamClassifier('chat-completions');

  it.each([500, 502, 503, 504])('keeps the Retry-After of a retryable HTTP %i', (status) => {
    const classified = classify(new UpstreamHttpError(status, null, 'down', 20_000, false));
    expect(classified.retryable).toBe(true);
    expect(classified.retryAfterMs).toBe(20_000);
  });

  it('keeps the Retry-After of a 429 as before', () => {
    expect(classify(new UpstreamHttpError(429, 'rate_limited', 'slow down', 20_000, false)).retryAfterMs).toBe(20_000);
  });
});
