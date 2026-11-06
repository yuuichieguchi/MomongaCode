import { describe, expect, it } from 'vitest';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import type { UpstreamLiveness } from '@momonga/gateway';
import { createFakeClock, openingEvents, openResponsesStream, startFakeOpenResponses } from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

const SETTINGS_LIVENESS = { headersTimeoutMs: 50, idleTimeoutMs: 50 };

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
    liveness: SETTINGS_LIVENESS as unknown as UpstreamLiveness,
  });
  registerCleanup(() => adapter.close());
  return startGateway({
    adapters: { remote: adapter },
    config: { aliases: { fast: ['remote'] }, targets: { remote: { model: 'upstream-model', kind: 'remote' } }, retry: { maxAttempts: 1, totalWaitMs: 1 } },
  });
};

describe('upstream liveness from models.headersTimeoutMs and models.idleTimeoutMs', () => {
  it('fails a request whose upstream accepts the connection and sends no headers past models.headersTimeoutMs', async () => {
    const harness = await startSilentUpstream([{ kind: 'hang' }]);
    const reply = await readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(reply.status).toBe(502);
    expect(reply.body.error.code).toBe('provider_unavailable');
  });

  it('answers a stream whose upstream goes silent past models.idleTimeoutMs after the opening events, before any output, with an HTTP error and no stream', async () => {
    const harness = await startSilentUpstream([openingThenSilence()]);
    const reply = await readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }));
    expect(reply.status).toBe(502);
    expect(reply.body.error.code).toBe('provider_unavailable');
  });
});
