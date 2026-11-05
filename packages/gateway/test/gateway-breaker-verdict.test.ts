import { describe, expect, it } from 'vitest';
import type { ClassifiedError, ProviderAdapter } from '@momonga/protocol';
import { ScriptedUpstreamError, createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { getJson, outputText, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { BASE_MS, MAX_MS, driveTimers, ok } from './retry-support.ts';

const classified = (code: string, type: ClassifiedError['error']['type'], message: string): ClassifiedError => ({
  retryable: false,
  error: { type, code, message, param: null },
});

const withClassifier = (adapter: ProviderAdapter): ProviderAdapter => ({
  ...adapter,
  classify: (error) => {
    if (error instanceof ScriptedUpstreamError && error.message === 'guardrail') {
      return classified('guardrail_violation', 'model_error', error.message);
    }
    if (error instanceof ScriptedUpstreamError && error.message === 'filtered') {
      return classified('content_filter', 'invalid_request', error.message);
    }
    if (error instanceof ScriptedUpstreamError && error.message === 'refused') {
      return classified('refusal', 'model_error', error.message);
    }
    return adapter.classify(error);
  },
});

const config = { retry: { maxAttempts: 1, totalWaitMs: 1 }, breaker: { failureThreshold: 2, openMs: 30_000 } };
const body = { model: 'fast', input: userInput('hi') };
const partial = textResponseEvents({ model: 'scripted-primary', chunks: ['a', 'b'] }).slice(0, 5);

const breakerAfter = async (calls: Array<{ events?: typeof partial; failure: { status: number; message: string } }>) => {
  const primary = withClassifier(createScriptedAdapter({ calls }));
  const { client } = await startGateway({ adapters: { primary }, config });
  for (let index = 0; index < calls.length; index += 1) {
    const response = await postJson(client, '/v1/responses', body);
    await response.text();
  }
  return (await getJson(client, '/v1/momonga/health')).body.targets.primary.breaker as string;
};

const fail = (status: number, message: string) => ({ failure: { status, message } });
const failMidStream = (status: number, message: string) => ({ events: partial, failure: { status, message } });

describe('breaker verdict before the first event', () => {
  it.each([
    ['guardrail', 400],
    ['filtered', 400],
    ['refused', 400],
    ['plain', 400],
    ['rate limited', 429],
  ])('keeps the breaker closed for %s (%i)', async (message, status) => {
    expect(await breakerAfter([fail(status, message), fail(status, message), fail(status, message)])).toBe('closed');
  });

  it('opens on repeated server errors', async () => {
    expect(await breakerAfter([fail(503, 'down'), fail(503, 'down')])).toBe('open');
  });
});

describe('breaker verdict after the first event', () => {
  it.each([
    ['guardrail', 400],
    ['filtered', 400],
    ['refused', 400],
    ['rate limited', 429],
  ])('keeps the breaker closed for %s (%i)', async (message, status) => {
    expect(await breakerAfter([failMidStream(status, message), failMidStream(status, message), failMidStream(status, message)])).toBe(
      'closed',
    );
  });

  it('opens on repeated server errors', async () => {
    expect(await breakerAfter([failMidStream(503, 'down'), failMidStream(503, 'down')])).toBe('open');
  });

  it('keeps the breaker closed for an in-stream response.failed carrying a neutral code', async () => {
    const base = textResponseEvents({ model: 'scripted-primary', chunks: ['x'] });
    const last = base[base.length - 1];
    if (last === undefined || last.type !== 'response.completed') throw new Error('fixture shape');
    const refusal = [
      ...base.slice(0, -1),
      {
        type: 'response.failed' as const,
        sequence_number: last.sequence_number,
        response: { ...last.response, status: 'failed' as const, error: { code: 'content_filter', message: 'blocked' } },
      },
    ];
    const primary = createScriptedAdapter({ calls: [{ events: refusal }, { events: refusal }, { events: refusal }] });
    const { client } = await startGateway({ adapters: { primary }, config });
    for (let index = 0; index < 3; index += 1) await readJson(await postJson(client, '/v1/responses', body));
    expect((await getJson(client, '/v1/momonga/health')).body.targets.primary.breaker).toBe('closed');
  });

  it('opens on repeated in-stream failures with a non-neutral code', async () => {
    const base = textResponseEvents({ model: 'scripted-primary', chunks: ['x'] });
    const last = base[base.length - 1];
    if (last === undefined || last.type !== 'response.completed') throw new Error('fixture shape');
    const broken = [
      ...base.slice(0, -1),
      {
        type: 'response.failed' as const,
        sequence_number: last.sequence_number,
        response: { ...last.response, status: 'failed' as const, error: { code: 'server_exploded', message: 'boom' } },
      },
    ];
    const primary = createScriptedAdapter({ calls: [{ events: broken }, { events: broken }] });
    const { client } = await startGateway({ adapters: { primary }, config });
    for (let index = 0; index < 2; index += 1) await readJson(await postJson(client, '/v1/responses', body));
    expect((await getJson(client, '/v1/momonga/health')).body.targets.primary.breaker).toBe('open');
  });
});

describe('one verdict per request and target', () => {
  const THREE_SENDS_BUDGET = { maxAttempts: 3, baseMs: BASE_MS, maxMs: MAX_MS, totalWaitMs: 375 + 750 };

  const startThreeSends = async (calls: Parameters<typeof createScriptedAdapter>[0]['calls'], failureThreshold: number) => {
    const primary = createScriptedAdapter({ calls });
    const harness = await startGateway({ adapters: { primary }, config: { retry: THREE_SENDS_BUDGET, breaker: { failureThreshold, openMs: 30_000 } } });
    const send = async () => {
      const pending = postJson(harness.client, '/v1/responses', body);
      await driveTimers(harness, [pending]);
      return readJson(await pending);
    };
    const breaker = async () => (await getJson(harness.client, '/v1/momonga/health')).body.targets.primary.breaker as string;
    return { primary, send, breaker };
  };

  it('records one failure for a request that failed three sends on a target, so a threshold of 2 stays closed', async () => {
    const { primary, send, breaker } = await startThreeSends([fail(503, 'd1'), fail(503, 'd2'), fail(503, 'd3')], 2);
    const response = await send();
    expect(response.status).toBe(502);
    expect(primary.calls).toHaveLength(3);
    expect(await breaker()).toBe('closed');
  });

  it('opens at a threshold of 2 after the second request that ends on a failure there', async () => {
    const { primary, send, breaker } = await startThreeSends([...Array.from({ length: 6 }, (_unused, index) => fail(503, `d${index}`))], 2);
    await send();
    await send();
    expect(primary.calls).toHaveLength(6);
    expect(await breaker()).toBe('open');
  });

  it('records a success for a request that failed twice and then answered, which resets the count', async () => {
    const { primary, send, breaker } = await startThreeSends([fail(503, 'd1'), fail(503, 'd2'), ok('third time'), fail(503, 'd3'), fail(503, 'd4'), fail(503, 'd5')], 2);
    const answered = await send();
    expect(answered.status).toBe(200);
    expect(outputText(answered.body)).toBe('third time');
    await send();
    expect(primary.calls).toHaveLength(6);
    expect(await breaker()).toBe('closed');
  });

  it('records neutral when the last error on the target is a 429, even after server errors, so a threshold of 1 stays closed', async () => {
    const { primary, send, breaker } = await startThreeSends([fail(503, 'd1'), fail(503, 'd2'), fail(429, 'slow down')], 1);
    const response = await send();
    expect(response.status).toBe(429);
    expect(primary.calls).toHaveLength(3);
    expect(await breaker()).toBe('closed');
  });

  it('lets the one trial request of a half-open target retry there while a concurrent request skips to the later candidate', async () => {
    const a = createScriptedAdapter({ calls: [fail(503, 'a1'), fail(503, 'a2'), fail(503, 'a3'), fail(503, 'trial down'), ok('a back', 'model-a')] });
    const b = createScriptedAdapter({ calls: [ok('b one', 'model-b'), ok('b two', 'model-b')] });
    const harness = await startGateway({
      adapters: { a, b },
      config: {
        aliases: { fast: ['a', 'b'] },
        targets: { a: { model: 'model-a' }, b: { model: 'model-b' } },
        retry: { maxAttempts: 3, baseMs: BASE_MS, maxMs: MAX_MS, totalWaitMs: 84_000 },
        breaker: { failureThreshold: 1, openMs: 10_000 },
      },
    });
    const opening = postJson(harness.client, '/v1/responses', body);
    await driveTimers(harness, [opening]);
    expect(outputText((await readJson(await opening)).body)).toBe('b one');
    expect((await getJson(harness.client, '/v1/momonga/health')).body.targets.a).toMatchObject({ breaker: 'open' });

    harness.clock.advance(10_000);
    const trial = postJson(harness.client, '/v1/responses', body);
    let trialSettled = false;
    const settle = (): void => {
      trialSettled = true;
    };
    void trial.then(settle, settle);
    await waitFor(() => trialSettled || harness.timers.pending().length > 0, { description: 'the trial request waiting to retry on a' });
    const settledBeforeRetry = trialSettled;
    const callsWhileTrialWaits = a.calls.length;
    const concurrent = await readJson(await postJson(harness.client, '/v1/responses', body));
    harness.timers.advance(harness.timers.pending().at(-1)?.delayMs ?? 0);
    const trialAnswer = await readJson(await trial);

    expect(settledBeforeRetry).toBe(false);
    expect(callsWhileTrialWaits).toBe(4);
    expect(outputText(concurrent.body)).toBe('b two');
    expect(concurrent.body.momonga.fallbackFrom).toEqual(['a']);
    expect(trialAnswer.status).toBe(200);
    expect(outputText(trialAnswer.body)).toBe('a back');
    expect(a.calls).toHaveLength(5);
    expect(b.calls).toHaveLength(2);
    expect((await getJson(harness.client, '/v1/momonga/health')).body.targets.a).toMatchObject({ breaker: 'closed' });
  });
});
