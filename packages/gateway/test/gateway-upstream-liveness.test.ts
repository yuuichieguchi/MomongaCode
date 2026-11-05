import { describe, expect, it } from 'vitest';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import type { UpstreamLiveness } from '@momonga/gateway';
import { createFakeClock, openingEvents, openResponsesStream, startFakeOpenResponses } from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { START_MS, postJson, readJson, readSse, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

const LIVENESS: UpstreamLiveness = { headersTimeoutMs: 50, bodyTimeoutMs: 50 };

const openingThenSilence = (): FakeUpstreamReply => {
  const opening = openResponsesStream(openingEvents(), { done: false });
  if (opening.kind !== 'stream') throw new Error('the opening reply must be a stream');
  return { kind: 'hang', frames: opening.frames };
};

const startSilentUpstream = async (script: FakeUpstreamReply[]) => {
  const fake = await startFakeOpenResponses({ script });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
    liveness: LIVENESS,
  });
  registerCleanup(() => adapter.close());
  return startGateway({
    adapters: { remote: adapter },
    config: { aliases: { fast: ['remote'] }, targets: { remote: { model: 'upstream-model', kind: 'remote' } }, retry: { maxAttempts: 1, totalWaitMs: 1 } },
  });
};

describe('upstream liveness', () => {
  it('fails a request whose upstream accepts the connection and never sends headers', async () => {
    const harness = await startSilentUpstream([{ kind: 'hang' }]);
    const reply = await readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(reply.status).toBe(502);
    expect(reply.body.error.code).toBe('provider_unavailable');
  });

  it('ends a stream whose upstream goes silent after the first events with a failed response', async () => {
    const harness = await startSilentUpstream([openingThenSilence()]);
    const frames = await readSse(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }));
    const last = frames.at(-1)?.data;
    expect(last.type).toBe('response.failed');
    expect(last.response.error.code).toBe('stream_interrupted');
  });
});
