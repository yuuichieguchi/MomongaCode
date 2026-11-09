import { describe, expect, it } from 'vitest';
import { OutboundConnectionError } from '@momonga/foundation';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import type { UpstreamLiveness } from '@momonga/gateway';
import { createFakeClock, openResponsesStream, openResponsesTextReply, openingEvents, startFakeOpenResponses } from '@momonga/testkit';
import type { FakeTimers, FakeUpstreamReply, FakeUpstreamServer } from '@momonga/testkit';
import { START_MS, postJson, readJson, readSse, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import type { ConfigOverrides } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';
import { createUpstreamClassifier } from '../src/adapters/shared/classify.ts';

const STALL_MS = 50;
const LIVENESS: UpstreamLiveness = { headersTimeoutMs: STALL_MS, idleTimeoutMs: STALL_MS };
const BREAKER_OPENS_ON_ONE_FAILURE = { failureThreshold: 1 };

const realTimers: FakeTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  advance: () => {
    throw new Error('real timers cannot be advanced');
  },
  pending: () => [],
  now: () => Date.now(),
  monotonicMs: () => performance.now(),
  nextDueAt: () => undefined,
};

const noHeaders: FakeUpstreamReply = { kind: 'hang' };

const openingThenSilence = (): FakeUpstreamReply => {
  const opening = openResponsesStream(openingEvents(), { done: false });
  if (opening.kind !== 'stream') throw new Error('the opening reply must be a stream');
  return { kind: 'hang', frames: opening.frames };
};

const startUpstream = async (script: FakeUpstreamReply[]) => {
  const fake = await startFakeOpenResponses({ script });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
    liveness: LIVENESS,
  });
  registerCleanup(() => adapter.close());
  return { fake, adapter };
};

const responsesTo = (fake: FakeUpstreamServer): number => fake.requests.filter((request) => request.path === '/v1/responses').length;

const startSingleTarget = async (script: FakeUpstreamReply[]) => {
  const remote = await startUpstream(script);
  const harness = await startGateway({
    adapters: { remote: remote.adapter },
    timers: realTimers,
    config: { aliases: { fast: ['remote'] }, targets: { remote: { model: 'upstream-model', kind: 'remote' } } },
  });
  return { harness, fake: remote.fake };
};

const startWithFallback = async (remoteScript: FakeUpstreamReply[], backupScript: FakeUpstreamReply[], breaker: ConfigOverrides['breaker']) => {
  const remote = await startUpstream(remoteScript);
  const backup = await startUpstream(backupScript);
  const harness = await startGateway({
    adapters: { remote: remote.adapter, backup: backup.adapter },
    timers: realTimers,
    config: {
      aliases: { fast: ['remote', 'backup'] },
      targets: { remote: { model: 'upstream-model', kind: 'remote' }, backup: { model: 'upstream-model', kind: 'remote' } },
      ...(breaker === undefined ? {} : { breaker }),
    },
  });
  return { harness, remote: remote.fake, backup: backup.fake };
};

const ask = async (client: Parameters<typeof postJson>[0], stream: boolean) => {
  const response = await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), ...(stream ? { stream: true } : {}) });
  if (response.headers['content-type']?.startsWith('text/event-stream') !== true) return readJson(response);
  const frames = await readSse(response);
  return { status: response.status, headers: response.headers, body: frames.at(-1)?.data };
};

describe('a stalled attempt ends the call at once and is never retried inside the gateway (audit-unbounded-waits-2026-11-07.md, Settled at Stage C, rule 1)', () => {
  it('ends the call after one upstream request when no headers arrive within models.headersTimeoutMs, under the default retry policy', async () => {
    const { harness, fake } = await startSingleTarget([noHeaders, openResponsesTextReply(['retried'])]);
    const reply = await ask(harness.client, false);
    expect(reply.status).toBe(502);
    expect(reply.body.error.code).toBe('provider_unavailable');
    expect(responsesTo(fake)).toBe(1);
  });

  it('ends the call after one upstream request when no content arrives within models.idleTimeoutMs, under the default retry policy', async () => {
    const { harness, fake } = await startSingleTarget([openingThenSilence(), openResponsesTextReply(['retried'])]);
    const reply = await ask(harness.client, true);
    expect(reply.status).toBe(502);
    expect(reply.body.error.code).toBe('stream_interrupted');
    expect(responsesTo(fake)).toBe(1);
  });

  it('keeps the retry layer for a retryable failure that is not a stall', async () => {
    const { harness, fake } = await startSingleTarget([{ kind: 'error', status: 503, body: { error: { type: 'server_error', code: null, message: 'down' } } }, openResponsesTextReply(['retried'])]);
    const reply = await ask(harness.client, false);
    expect(reply.status).toBe(200);
    expect(responsesTo(fake)).toBe(2);
  });

  it('with a fallback target, a stall ends the call without reaching the fallback, and the breaker records it, so with a threshold of one the next call is routed to the fallback', async () => {
    const { harness, remote, backup } = await startWithFallback([noHeaders, noHeaders, noHeaders], [openResponsesTextReply(['from backup'])], BREAKER_OPENS_ON_ONE_FAILURE);
    const stalled = await ask(harness.client, false);
    expect(stalled.status).toBe(502);
    expect(stalled.body.error.code).toBe('provider_unavailable');
    expect(responsesTo(remote)).toBe(1);
    expect(responsesTo(backup)).toBe(0);
    const next = await ask(harness.client, false);
    expect(next.status).toBe(200);
    expect(next.body.momonga.fallbackFrom).toEqual(['remote']);
    expect(responsesTo(remote)).toBe(1);
    expect(responsesTo(backup)).toBe(1);
  });

  it('with a fallback target and the default breaker, the next call after a stall tries the first target again', async () => {
    const { harness, remote, backup } = await startWithFallback([noHeaders, openResponsesTextReply(['from remote'])], [openResponsesTextReply(['from backup'])], undefined);
    expect((await ask(harness.client, false)).status).toBe(502);
    const next = await ask(harness.client, false);
    expect(next.status).toBe(200);
    expect(next.body.momonga).not.toHaveProperty('fallbackFrom');
    expect(responsesTo(remote)).toBe(2);
    expect(responsesTo(backup)).toBe(0);
  });
});

describe('a stall carried by a labelled connection error keeps both rules: the label decides retryable and the code, the undici timeout decides stalled', () => {
  const classify = createUpstreamClassifier('test');
  const timeout = (code: string): Error => Object.assign(new Error(code), { code });

  it('marks an origin-connection error caused by a headers timeout as a retryable, unreachable stall', () => {
    const classified = classify(new OutboundConnectionError({ kind: 'origin-connection', origin: 'https://upstream.example' }, { cause: timeout('UND_ERR_HEADERS_TIMEOUT') }));
    expect(classified).toMatchObject({ retryable: true, stalled: true, error: { code: 'provider_unavailable' } });
  });

  it('does not mark an origin-connection error caused by a refused connection as a stall', () => {
    const classified = classify(new OutboundConnectionError({ kind: 'origin-connection', origin: 'https://upstream.example' }, { cause: timeout('ECONNREFUSED') }));
    expect(classified.retryable).toBe(true);
    expect(classified.stalled).toBeUndefined();
  });

  it('marks a bare headers timeout as a retryable, unreachable stall', () => {
    expect(classify(timeout('UND_ERR_HEADERS_TIMEOUT'))).toMatchObject({ retryable: true, stalled: true, error: { code: 'provider_unavailable' } });
  });
});
