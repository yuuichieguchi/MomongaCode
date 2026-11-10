import { describe, expect, it } from 'vitest';
import type { CountTokensResult } from '@momonga/protocol';
import { UpstreamHttpError } from '../src/adapters/shared/failures.ts';
import { waitFor } from '@momonga/testkit';
import { getJson, postJson, readJson } from './gateway-helpers.ts';
import type { Harness } from './gateway-helpers.ts';
import { CC_CAPABILITIES, completionBodies, makeAdapter, startFake, userText } from './cc-support.ts';
import { ccAdapterFor, startCcGateway, summaryOfResource, textReply } from './cc-compact-support.ts';

const compact = async (harness: Harness, body: Record<string, unknown> = {}) =>
  readJson(await postJson(harness.client, '/v1/responses/compact', { model: harness.model, input: [userText('summarise this')], ...body }));

const breakerOf = async (harness: Harness, target: string): Promise<string> =>
  (await getJson(harness.client, '/v1/momonga/health')).body.targets[target].breaker as string;

const failingCounter = async () => {
  const fake = await startFake({ scenario: 'tools-ok', script: [textReply('never')] });
  const adapter = makeAdapter(fake, {
    capabilities: async () => ({ ...CC_CAPABILITIES, tokenCounting: 'calibrated' }),
    countTokens: async (): Promise<CountTokensResult> => {
      throw new UpstreamHttpError(503, null, 'counter down', undefined, false);
    },
  });
  return { fake, adapter };
};

describe('a candidate whose counter fails is dropped, not fatal', () => {
  it('summarises on the next candidate and records the failure on the first target breaker', async () => {
    const first = await failingCounter();
    const healthy = await startFake({ scenario: 'tools-ok', script: [textReply('from second')] });
    const harness = await startCcGateway(
      { first: first.adapter, second: ccAdapterFor(healthy) },
      { retry: { maxAttempts: 1, totalWaitMs: 1 }, breaker: { failureThreshold: 1, openMs: 30_000 } },
    );
    const response = await compact(harness);
    expect(response.status).toBe(200);
    expect(summaryOfResource(response.body)).toBe('from second');
    expect(completionBodies(first.fake)).toHaveLength(0);
    expect(await breakerOf(harness, 'first')).toBe('open');
  });

  it('answers the counter failure, not a size error, when every counter fails', async () => {
    const first = await failingCounter();
    const second = await failingCounter();
    const harness = await startCcGateway({ first: first.adapter, second: second.adapter }, { retry: { maxAttempts: 1, totalWaitMs: 1 } });
    const response = await compact(harness);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body.error.type).toBe('server_error');
    expect(response.body.error.code).toBe('upstream_error');
    expect(completionBodies(first.fake)).toHaveLength(0);
    expect(completionBodies(second.fake)).toHaveLength(0);
  });
});

describe('the margin term of the summary input bound', () => {
  const W = 4096;
  const CAP = 100;
  const LIMIT = W - CAP - 82;

  it.for([
    [LIMIT, 200],
    [LIMIT + 1, 400],
  ] as const)('a counted request of %i tokens answers %i when W - cap - marginFloorFor(W) is the smaller term', async ([tokens, status]) => {
    expect(LIMIT).toBeLessThan(W - CAP);
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('note')] });
    const adapter = makeAdapter(fake, {
      capabilities: async () => ({ ...CC_CAPABILITIES, contextWindow: W, maxOutputTokens: CAP, tokenCounting: 'calibrated' }),
      countTokens: async (): Promise<CountTokensResult> => ({ input_tokens: tokens, method: 'calibrated', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } }),
    });
    const harness = await startCcGateway({ fm: adapter });
    const response = await compact(harness, { momonga: { max_summary_tokens: CAP } });
    expect(response.status).toBe(status);
    if (status === 400) {
      expect(response.body.error.code).toBe('compaction_input_too_large');
      expect(completionBodies(fake)).toHaveLength(0);
    } else {
      expect(completionBodies(fake)).toHaveLength(1);
    }
  });
});

describe('the reasoning headroom term of the summary input bound', () => {
  const W = 4096;
  const CAP = 100;
  const HEADROOM = 500;
  const ROOMY_LIMIT = W - CAP - HEADROOM - 82;
  const CAPPED_LIMIT = W - CAP - 82;

  it.for([
    [CAP + HEADROOM, ROOMY_LIMIT, 200],
    [CAP + HEADROOM, ROOMY_LIMIT + 1, 400],
    [CAP, CAPPED_LIMIT, 200],
    [CAP, CAPPED_LIMIT + 1, 400],
  ] as const)('with a model output maximum of %i, a counted request of %i tokens answers %i: the input limit subtracts only the reasoning room the wire output cap can hold', async ([maxOutputTokens, tokens, status]) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('note')] });
    const adapter = makeAdapter(fake, {
      capabilities: async () => ({
        ...CC_CAPABILITIES,
        contextWindow: W,
        maxOutputTokens,
        tokenCounting: 'calibrated',
        reasoning: { control: 'none', headroomTokens: HEADROOM },
      }),
      countTokens: async (): Promise<CountTokensResult> => ({ input_tokens: tokens, method: 'calibrated', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } }),
    });
    const harness = await startCcGateway({ fm: adapter });
    const response = await compact(harness, { momonga: { max_summary_tokens: CAP } });
    expect(response.status).toBe(status);
    if (status === 400) expect(response.body.error.code).toBe('compaction_input_too_large');
  });
});

describe('error precedence when every candidate is dropped', () => {
  const tooLarge = async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('never')] });
    const counts: unknown[] = [];
    const adapter = makeAdapter(fake, {
      capabilities: async () => ({ ...CC_CAPABILITIES, tokenCounting: 'calibrated' }),
      countTokens: async (_target, request): Promise<CountTokensResult> => {
        counts.push(request);
        return { input_tokens: 100_000, method: 'calibrated', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } };
      },
    });
    return { fake, adapter, counts };
  };

  it.for([
    ['the failing counter first', true],
    ['a too-large candidate before and after it', false],
  ] as const)('answers the counter failure with %s', async ([, failingFirst]) => {
    const failing = await failingCounter();
    const large = await tooLarge();
    const trailing = await tooLarge();
    const adapters = failingFirst
      ? { a: failing.adapter, b: large.adapter }
      : { a: large.adapter, b: failing.adapter, c: trailing.adapter };
    const harness = await startCcGateway(adapters, { retry: { maxAttempts: 1, totalWaitMs: 1 } });
    const response = await compact(harness);
    expect(response.body.error.type).toBe('server_error');
    expect(response.body.error.code).toBe('upstream_error');
    expect(completionBodies(failing.fake)).toHaveLength(0);
    expect(completionBodies(large.fake)).toHaveLength(0);
    expect(completionBodies(trailing.fake)).toHaveLength(0);
    expect(trailing.counts).toHaveLength(failingFirst ? 0 : 1);
  });
});

describe('a dead request stops sizing instead of dropping the candidate', () => {
  const heldCounter = async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('never')] });
    const calls: AbortSignal[] = [];
    const adapter = makeAdapter(fake, {
      capabilities: async () => ({ ...CC_CAPABILITIES, tokenCounting: 'calibrated' }),
      countTokens: (_target, _request, signal): Promise<CountTokensResult> => {
        calls.push(signal);
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    });
    return { fake, adapter, calls };
  };

  const countingCounter = async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('from second')] });
    const calls: unknown[] = [];
    const sizing = { capabilities: 0, renders: 0 };
    const adapter = makeAdapter(fake, {
      capabilities: async () => {
        sizing.capabilities += 1;
        return { ...CC_CAPABILITIES, tokenCounting: 'calibrated' };
      },
      countTokens: async (_target, request): Promise<CountTokensResult> => {
        calls.push(request);
        return { input_tokens: 100, method: 'calibrated', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } };
      },
    });
    const render = adapter.renderCompactWire;
    if (render === undefined) throw new Error('the chat-completions adapter has no renderCompactWire');
    adapter.renderCompactWire = (...args) => {
      sizing.renders += 1;
      return render.apply(adapter, args);
    };
    return { fake, adapter, calls, sizing };
  };

  it.for(['unkeyed', 'keyed'] as const)('answers gateway_closed for a %s request when the gateway closes during the first counter, and never sizes or calls the second target', async (kind) => {
    const first = await heldCounter();
    const second = await countingCounter();
    const harness = await startCcGateway({ first: first.adapter, second: second.adapter }, { retry: { maxAttempts: 1, totalWaitMs: 1 }, closeGraceMs: 1000 });
    const pending = postJson(
      harness.client,
      '/v1/responses/compact',
      { model: 'first/system', input: [userText('summarise this')] },
      kind === 'keyed' ? { 'idempotency-key': 'closing' } : {},
    ).then(
      (response) => readJson(response),
      () => undefined,
    );
    await waitFor(() => first.calls.length === 1, { description: 'the first counter to be held' });
    const capabilityReadsBefore = second.sizing.capabilities;
    const closing = harness.gateway.close();
    await waitFor(() => first.calls[0]?.aborted === true || harness.timers.pending().some((timer) => timer.delayMs === 1000), {
      description: 'the close to start',
    });
    if (first.calls[0]?.aborted !== true) harness.timers.advance(1000);
    const response = await pending;
    await closing;
    expect(first.calls[0]?.aborted).toBe(true);
    expect(response === undefined ? 'connection closed' : response.body.error.code).toMatch(/^(connection closed|gateway_closed)$/);
    expect(second.calls).toHaveLength(0);
    expect(second.sizing.renders).toBe(0);
    expect(second.sizing.capabilities).toBe(capabilityReadsBefore);
    expect(completionBodies(second.fake)).toHaveLength(0);
    expect(completionBodies(first.fake)).toHaveLength(0);
  });

  it.for(['deadline', 'client abort'] as const)('propagates a %s during the first counter and never sizes or calls the second target', async (kind) => {
    const first = await heldCounter();
    const second = await countingCounter();
    const harness = await startCcGateway({ first: first.adapter, second: second.adapter }, { retry: { maxAttempts: 1, totalWaitMs: 1 } });
    const body = JSON.stringify({ model: 'first/system', input: [userText('summarise this')] });
    const client = new AbortController();
    const pending = harness.client
      .request({
        method: 'POST',
        path: '/v1/responses/compact',
        headers: { 'content-type': 'application/json', ...(kind === 'deadline' ? { 'momonga-deadline-ms': '1000' } : {}) },
        body,
        ...(kind === 'client abort' ? { signal: client.signal } : {}),
      })
      .then(
        (response) => readJson(response),
        () => undefined,
      );
    await waitFor(() => first.calls.length === 1, { description: 'the first counter to be held' });
    const capabilityReadsBefore = second.sizing.capabilities;
    if (kind === 'deadline') {
      await waitFor(() => harness.timers.pending().some((timer) => timer.delayMs === 1000), { description: 'deadline timer' });
      harness.timers.advance(1000);
      const response = await pending;
      expect(response?.status).toBe(504);
      expect(response?.body.error.code).toBe('deadline_exceeded');
    } else {
      client.abort();
      await pending;
      await waitFor(() => first.calls[0]?.aborted === true, { description: 'the held counter to see the abort' });
      await harness.gateway.close();
    }
    expect(second.calls).toHaveLength(0);
    expect(second.sizing.renders).toBe(0);
    expect(second.sizing.capabilities).toBe(capabilityReadsBefore);
    expect(completionBodies(second.fake)).toHaveLength(0);
    expect(completionBodies(first.fake)).toHaveLength(0);
  });
});
