import { describe, expect, it } from 'vitest';
import type { ClassifiedError, ProviderAdapter } from '@momonga/protocol';
import { ScriptedUpstreamError, createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { getJson, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

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

const config = { retry: { maxAttempts: 1 }, breaker: { failureThreshold: 2, openMs: 30_000 } };
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
