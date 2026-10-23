import { describe, expect, it } from 'vitest';
import { FAKE_DETERMINISTIC_REPLY } from '@momonga/testkit';
import type { FakeScriptedReply } from '@momonga/testkit';
import { expectErrorBody, outputText, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { collect, makeAdapter, startFake, userText } from './cc-support.ts';

const rejection = (status: number): FakeScriptedReply => ({
  kind: 'error',
  status,
  body: { error: { message: 'invalid credentials', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } },
});

const completions = (fake: Awaited<ReturnType<typeof startFake>>) =>
  fake.requests.filter((request) => request.path === '/v1/chat/completions');

const body = { model: 'fast', input: userInput('hi') };

describe('chat-completions classification of upstream auth failures', () => {
  it.each([401, 403])('maps %i to a non-retryable authentication_failed', async (status) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [rejection(status)] });
    const adapter = makeAdapter(fake);
    const { events, error } = await collect(adapter, { model: 'system', input: [userText('hi')] });
    expect(events).toEqual([]);
    const classified = adapter.classify(error);
    expect(classified.retryable).toBe(false);
    expect(classified.error.code).toBe('authentication_failed');
  });
});

describe('authentication_failed skip outcome', () => {
  const twoTargets = {
    aliases: { fast: ['a', 'b'] },
    targets: { a: { kind: 'chat-completions', model: 'system' }, b: { kind: 'chat-completions', model: 'system' } },
  };

  it('falls back to the next target without retrying the first', async () => {
    const fakeA = await startFake({ scenario: 'tools-ok', script: [rejection(401)] });
    const fakeB = await startFake({ scenario: 'tools-ok' });
    const { client } = await startGateway({
      adapters: { a: makeAdapter(fakeA), b: makeAdapter(fakeB) },
      config: { ...twoTargets, retry: { maxAttempts: 3 } },
    });
    const response = await readJson(await postJson(client, '/v1/responses', body));
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe(FAKE_DETERMINISTIC_REPLY);
    expect(response.body.momonga.target).toBe('b');
    expect(response.body.momonga.fallbackFrom).toEqual(['a']);
    expect(completions(fakeA)).toHaveLength(1);
    expect(completions(fakeB)).toHaveLength(1);
  });

  it('does not trip the breaker of the target that rejected the credentials', async () => {
    const fakeA = await startFake({ scenario: 'tools-ok', script: [rejection(401), rejection(403), rejection(401)] });
    const fakeB = await startFake({ scenario: 'tools-ok' });
    const { client } = await startGateway({
      adapters: { a: makeAdapter(fakeA), b: makeAdapter(fakeB) },
      config: { ...twoTargets, breaker: { failureThreshold: 1 } },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await readJson(await postJson(client, '/v1/responses', body))).status).toBe(200);
    }
    expect(completions(fakeA)).toHaveLength(3);
    expect(completions(fakeB)).toHaveLength(3);
    const health = await readJson(await client.request({ method: 'GET', path: '/v1/momonga/health' }));
    expect(health.body.targets.a.breaker).toBe('closed');
  });

  it('surfaces 401 authentication_failed when no target is left, with one upstream call', async () => {
    const fakeA = await startFake({ scenario: 'tools-ok', script: [rejection(401)] });
    const { client } = await startGateway({
      adapters: { a: makeAdapter(fakeA) },
      config: { aliases: { fast: ['a'] }, targets: { a: { kind: 'chat-completions', model: 'system' } }, retry: { maxAttempts: 3 } },
    });
    const response = await readJson(await postJson(client, '/v1/responses', body));
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('authentication_failed');
    expectErrorBody(response.body, { type: response.body.error.type, code: 'authentication_failed' });
    expect(completions(fakeA)).toHaveLength(1);
  });
});
