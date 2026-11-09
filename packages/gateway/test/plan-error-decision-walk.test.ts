import { describe, expect, it } from 'vitest';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import type { ClassifiedError, ErrorType, ProviderAdapter } from '@momonga/protocol';
import {
  UNDICI_DEFAULT_LIVENESS,
  createFakeClock,
  createScriptedAdapter,
  openResponsesStream,
  openResponsesTextReply,
  openingEvents,
  startFakeOpenResponses,
  terminalEvent,
  textResponseEvents,
  usageOf,
  waitFor,
} from '@momonga/testkit';
import type { ScriptedAdapter } from '@momonga/testkit';
import { START_MS, postJson, readJson, readSse, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

type RuleDecision = { retryable: boolean; verdict: 'failure' | 'neutral'; fallback: 'next' | 'stop'; credential: 'keep' | 'pause' | 'rejected' };

const ruled = (type: ErrorType, code: string, rule: RuleDecision): ClassifiedError =>
  ({ ...rule, error: { type, code, message: `${code} from the rules`, param: null } }) as ClassifiedError;

const withDecision = (scripted: ScriptedAdapter, classified: ClassifiedError): ScriptedAdapter => ({ ...scripted, classify: () => classified });

const failingTwice = (): ScriptedAdapter =>
  createScriptedAdapter({ calls: [{ failure: { status: 400, message: 'refused upstream' } }, { failure: { status: 400, message: 'refused upstream' } }] });

const serving = (model: string): ScriptedAdapter =>
  createScriptedAdapter({
    calls: [
      { events: textResponseEvents({ model, chunks: ['served'], usage: usageOf(5, 1) }) },
      { events: textResponseEvents({ model, chunks: ['served'], usage: usageOf(5, 1) }) },
    ],
  });

const startPair = async (first: ProviderAdapter, second: ProviderAdapter, breaker: { failureThreshold: number } = { failureThreshold: 5 }) => {
  const harness = await startGateway({
    adapters: { first, second },
    config: {
      aliases: { fast: ['first', 'second'] },
      targets: { first: { model: 'model-first' }, second: { model: 'model-second' } },
      retry: { maxAttempts: 1, totalWaitMs: 1 },
      breaker,
    },
  });
  return async () => readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
};

describe('the alias walk reads fallback from the classified decision, not SKIPPABLE_CODES (P3, M4)', () => {
  it('moves to the next member on a non-retryable adapter-classified error whose fallback is next', async () => {
    const first = failingTwice();
    const second = serving('model-second');
    const post = await startPair(withDecision(first, ruled('invalid_request', 'plan_rule_next', { retryable: false, verdict: 'neutral', fallback: 'next', credential: 'keep' })), second);
    const response = await post();
    expect(response.status).toBe(200);
    expect(second.calls).toHaveLength(1);
    expect(response.body.momonga.fallbackCauses).toMatchObject([{ target: 'first', code: 'plan_rule_next' }]);
  });

  it('stops on the member when fallback is stop, even for a code that SKIPPABLE_CODES lists', async () => {
    const first = failingTwice();
    const second = serving('model-second');
    const post = await startPair(withDecision(first, ruled('invalid_request', 'authentication_failed', { retryable: false, verdict: 'neutral', fallback: 'stop', credential: 'keep' })), second);
    const response = await post();
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('authentication_failed');
    expect(second.calls).toHaveLength(0);
  });
});

describe('the breaker records the verdict of the classified decision when it is set (P3, retry.ts:177 and the skip path)', () => {
  it('records failure on the skip path, so the next request passes over the open breaker', async () => {
    const first = failingTwice();
    const second = serving('model-second');
    const post = await startPair(
      withDecision(first, ruled('server_error', 'plan_rule_skip_failure', { retryable: false, verdict: 'failure', fallback: 'next', credential: 'keep' })),
      second,
      { failureThreshold: 1 },
    );
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(2);
  });

  it('records failure for a stopping invalid_request whose verdict is failure, where the type alone would be neutral', async () => {
    const first = failingTwice();
    const second = serving('model-second');
    const post = await startPair(
      withDecision(first, ruled('invalid_request', 'plan_rule_stop_failure', { retryable: false, verdict: 'failure', fallback: 'stop', credential: 'keep' })),
      second,
      { failureThreshold: 1 },
    );
    expect((await post()).body.error.code).toBe('plan_rule_stop_failure');
    expect(second.calls).toHaveLength(0);
    await post();
    expect(first.calls).toHaveLength(1);
  });
});

describe('a response.failed before output is decided by the adapter classifier (P3, M4: one rule per question)', () => {
  it('asks adapter.classify with the upstream code and does not retry when it answers not retryable, though the type alone would retry', async () => {
    const fake = await startFakeOpenResponses({
      script: [
        openResponsesStream([...openingEvents(), terminalEvent({ kind: 'failed', code: 'upstream_quota_code', message: 'quota reached', errorType: 'server_error' }, [])]),
        openResponsesTextReply(['retried']),
      ],
    });
    registerCleanup(() => fake.close());
    const real = createOpenResponsesAdapter({
      liveness: UNDICI_DEFAULT_LIVENESS,
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      capabilities: async () => REMOTE_CAPABILITIES,
      clock: createFakeClock(START_MS),
    });
    registerCleanup(() => real.close());
    const seen: unknown[] = [];
    const adapter: ProviderAdapter = {
      ...real,
      classify: (error: unknown) => {
        seen.push(error);
        return ruled('too_many_requests', 'plan_usage_limit', { retryable: false, verdict: 'neutral', fallback: 'stop', credential: 'pause' });
      },
    };
    const harness = await startGateway({ adapters: { only: adapter }, config: { aliases: { fast: ['only'] }, targets: { only: { model: 'upstream-model' } } } });
    let settled = false;
    const pending = postJson(harness.client, '/v1/responses', { model: 'fast', stream: true, input: userInput('hi') }).then(readSse);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitFor(() => settled || harness.timers.pending().length > 0, { description: 'the answer or a retry wait' });
    const retryWaits = harness.timers.pending().map((timer) => timer.delayMs);
    harness.timers.advance(Math.max(0, ...retryWaits));
    const frames = await pending;
    expect(retryWaits).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(seen.some((error) => (error as { code?: unknown }).code === 'upstream_quota_code')).toBe(true);
    const terminal = frames.at(-1)?.data;
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error.code).toBe('plan_usage_limit');
  });
});
