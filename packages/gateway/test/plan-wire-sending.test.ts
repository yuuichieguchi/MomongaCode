import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import { planProfileOf } from '@momonga/config';
import { SESSION_ID_HEADER } from '@momonga/protocol';
import { PLAN_RESPONSES_PATH, UNCONFIGURED_NETWORK, UNDICI_DEFAULT_LIVENESS, createFakeClock, openResponsesTextReply, startFakePlanResponses } from '@momonga/testkit';
import type { FakePlanResponses, FakeUpstreamReply } from '@momonga/testkit';
import type { PlanRequestWire } from '../src/adapters/open-responses/types.ts';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { PLAN_CAPABILITIES, fakeAuth, posts } from './plan-auth-support.ts';

const PROFILE_WIRE = planProfileOf('chatgpt').requestWire;

const SESSION_HEADERS = ['session-id', 'thread-id', 'x-client-request-id'];

const ONE_MIB = 1024 * 1024;

const startRoute = async (script: FakeUpstreamReply[], requestWire: PlanRequestWire | undefined) => {
  const fake = await startFakePlanResponses({ verifyBearer: () => 'valid', script });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'tcp', baseUrl: `${fake.origin}/v1`, network: UNCONFIGURED_NETWORK }),
    capabilities: async () => PLAN_CAPABILITIES,
    clock: createFakeClock(START_MS),
    authSource: () => fakeAuth(),
    errorRules: planProfileOf('chatgpt').errorRules,
    ...(requestWire === undefined ? {} : { requestWire }),
  });
  registerCleanup(() => adapter.close());
  const harness = await startGateway({ adapters: { 'scripted/plan-model': adapter }, config: { chains: { 'scripted/plan-model': ['scripted/plan-model'] }, targets: { 'scripted/plan-model': { billing: 'plan' } }, retry: { maxAttempts: 1, totalWaitMs: 1 }, limits: { maxBodyBytes: 32 * ONE_MIB } } });
  const post = async (text: string, headers: Record<string, string> = {}) => readJson(await postJson(harness.client, '/v1/responses', { model: 'scripted/plan-model', input: userInput(text) }, headers));
  const compact = async (headers: Record<string, string>) => readJson(await postJson(harness.client, '/v1/responses/compact', { model: 'scripted/plan-model', input: userInput('compact me') }, headers));
  return { fake, post, compact };
};

const sessionHeadersOf = (fake: FakePlanResponses): Array<Record<string, unknown>> =>
  posts(fake).map((request) => Object.fromEntries(SESSION_HEADERS.map((name) => [name, request.headers[name]])));

describe('the plan profile declares what its requests carry', () => {
  it('declares zstd bodies and the session headers ChatGPT derives cache affinity from', () => {
    expect(PROFILE_WIRE).toEqual({ encoding: 'zstd', sessionHeaders: SESSION_HEADERS });
  });
});

describe('a plan request carries the session id in the declared headers', () => {
  it('sends the same session id on every request of one session and another for another session', async () => {
    const route = await startRoute([openResponsesTextReply(['a']), openResponsesTextReply(['b']), openResponsesTextReply(['c'])], PROFILE_WIRE);
    expect((await route.post('one', { [SESSION_ID_HEADER]: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' })).status).toBe(200);
    expect((await route.post('two', { [SESSION_ID_HEADER]: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' })).status).toBe(200);
    expect((await route.post('three', { [SESSION_ID_HEADER]: '0190a1b2-ffff-7e5f-8a9b-0c1d2e3f4a5b' })).status).toBe(200);
    const same = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const other = '0190a1b2-ffff-7e5f-8a9b-0c1d2e3f4a5b';
    expect(sessionHeadersOf(route.fake)).toEqual([
      { 'session-id': same, 'thread-id': same, 'x-client-request-id': same },
      { 'session-id': same, 'thread-id': same, 'x-client-request-id': same },
      { 'session-id': other, 'thread-id': other, 'x-client-request-id': other },
    ]);
  });

  it('carries the session id on a compaction request too', async () => {
    const route = await startRoute([openResponsesTextReply(['summary'])], PROFILE_WIRE);
    expect((await route.compact({ [SESSION_ID_HEADER]: 'session-for-compaction' })).status).toBe(200);
    expect(sessionHeadersOf(route.fake)).toEqual([{ 'session-id': 'session-for-compaction', 'thread-id': 'session-for-compaction', 'x-client-request-id': 'session-for-compaction' }]);
  });

  it('sends none of the headers for a request that names no session, and none on a target that declares none', async () => {
    const declared = await startRoute([openResponsesTextReply(['a'])], PROFILE_WIRE);
    await declared.post('one');
    expect(sessionHeadersOf(declared.fake)).toEqual([{ 'session-id': undefined, 'thread-id': undefined, 'x-client-request-id': undefined }]);
    const undeclared = await startRoute([openResponsesTextReply(['a'])], undefined);
    await undeclared.post('one', { [SESSION_ID_HEADER]: 'session-x' });
    expect(sessionHeadersOf(undeclared.fake)).toEqual([{ 'session-id': undefined, 'thread-id': undefined, 'x-client-request-id': undefined }]);
  });

  it('refuses a session id header that is empty', async () => {
    const route = await startRoute([openResponsesTextReply(['a'])], PROFILE_WIRE);
    const answer = await route.post('one', { [SESSION_ID_HEADER]: ' ' });
    expect(answer.status).toBe(400);
    expect(posts(route.fake)).toEqual([]);
  });
});

describe('a plan request body is sent zstd-compressed', () => {
  it('sends Content-Encoding zstd with a body that decodes to the request', async () => {
    const route = await startRoute([openResponsesTextReply(['a'])], PROFILE_WIRE);
    expect((await route.post('hello')).status).toBe(200);
    const [sent] = posts(route.fake);
    expect(sent?.headers['content-encoding']).toBe('zstd');
    expect(sent?.body).toMatchObject({ store: false, stream: true });
    expect(sent?.rawBytes).toBeDefined();
    expect(JSON.parse(zstdDecompressSync(sent?.rawBytes ?? Buffer.alloc(0)).toString('utf8'))).toEqual(sent?.body);
  });

  it('completes a turn whose body is over 1 MiB, which the route refuses uncompressed', async () => {
    const large = 'word '.repeat(Math.ceil((ONE_MIB * 1.5) / 5));
    const compressed = await startRoute([openResponsesTextReply(['ok'])], PROFILE_WIRE);
    expect((await compressed.post(large)).status).toBe(200);
    expect(posts(compressed.fake)[0]?.rawBytes?.byteLength).toBeLessThan(ONE_MIB);
    const plain = await startRoute([openResponsesTextReply(['ok'])], undefined);
    const refused = await plain.post(large);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('payload_too_large');
  });
});

describe('the plan fake checks what arrives the way the route does', () => {
  it('accepts a zstd body and refuses an uncompressed body over 1 MiB with 413', async () => {
    const fake = await startFakePlanResponses({ verifyBearer: () => 'valid', script: [openResponsesTextReply(['a'])] });
    registerCleanup(() => fake.close());
    const body = JSON.stringify({ model: 'm', input: [{ role: 'user', content: 'x'.repeat(ONE_MIB + 1) }], store: false, stream: true });
    const refused = await fetch(`${fake.origin}${PLAN_RESPONSES_PATH}`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body });
    expect(refused.status).toBe(413);
  });
});
