import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedSocket } from '@momonga/foundation';
import { TARGET_NOT_READY, TARGET_PROBE_FAILED, TARGET_PROBING, TARGET_PROBING_MESSAGE, agentReadiness, readinessText } from '@momonga/protocol';
import type { NotListedCapabilities, ProbingCapabilities, UnavailableCapabilities } from '@momonga/protocol';
import { GatewayRequestError, ModelUnlistedError, createGatewayClient } from '@momonga/runtime';
import { fakeClock, listedEntry, listingBody, makeClient, settle, startRawHttpFake } from '../gateway-client/fixtures.ts';
import { MODEL_ID, OTHER_MODEL_ID, defaultModelCapabilities, makeLayout, onCleanup, startService } from './helpers.ts';

const UNKNOWN_SIZE_TEXT =
  'the model plan-model cannot be used yet: the settings give no context window and output limit for it, and the model list of its account reports none; momonga models --catalog reads the list';

const UNAVAILABLE: UnavailableCapabilities = {
  toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: UNKNOWN_SIZE_TEXT, param: 'model' },
  source: 'unprobed',
};

const PROBING: ProbingCapabilities = { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } }, source: 'unprobed' };

const IMAGE = { mediaType: 'image/png', data: Buffer.from('fake png bytes').toString('base64') };

const refusalTextOf = (listed: NotListedCapabilities): string => {
  const readiness = agentReadiness(listed);
  if (readiness.state === 'ready') throw new Error('a not-listed value was judged ready');
  return readinessText(readiness);
};

const entry = (id: string, capabilities: unknown) => listedEntry(id, capabilities);

const capabilitiesThroughEntries = async (data: readonly unknown[]) => {
  const fake = await startRawHttpFake();
  fake.respond((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(listingBody(data)));
  });
  const client = makeClient(fake.socketPath, fakeClock());
  return (model: string) => client.capabilities(model, { signal: new AbortController().signal });
};

const capabilitiesThroughListing = (sessionChainCapabilities: unknown) =>
  capabilitiesThroughEntries([entry(MODEL_ID, sessionChainCapabilities), entry(OTHER_MODEL_ID, defaultModelCapabilities(true))]);

const createRunWithImage = async (capabilitiesOf: (model: string) => Promise<unknown>) => {
  const env = await startService({ capabilitiesOf });
  const session = await env.createSession();
  const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'what is this', images: [IMAGE] } });
  return { env, session, response };
};

describe('a run created with an image answers by the readiness of its model (K5)', () => {
  it('refuses with 409 target_not_ready and the readiness text of the listing when the model is listed as unavailable', async () => {
    const { env, session, response } = await createRunWithImage(await capabilitiesThroughListing(UNAVAILABLE));

    expect({ status: response.status, body: response.json }).toEqual({
      status: 409,
      body: { error: { type: 'conflict', code: TARGET_NOT_READY, message: refusalTextOf(UNAVAILABLE) } },
    });
    expect(env.errors).toEqual([]);
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('refuses with 409 target_not_ready and the probing readiness text when the model is being measured', async () => {
    const { env, session, response } = await createRunWithImage(await capabilitiesThroughListing(PROBING));

    expect({ status: response.status, body: response.json }).toEqual({
      status: 409,
      body: { error: { type: 'conflict', code: TARGET_NOT_READY, message: refusalTextOf(PROBING) } },
    });
    expect(refusalTextOf(PROBING)).toBe(TARGET_PROBING_MESSAGE);
    expect(response.headers['retry-after']).toBeUndefined();
    expect(env.errors).toEqual([]);
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('refuses with 409 target_not_ready and the probing text when the gateway answers the listing itself with 503 target_probing', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '120' });
      response.end(JSON.stringify({ error: { type: 'server_error', code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE, param: null } }));
    });
    const client = makeClient(fake.socketPath, fakeClock());
    const raised = await settle(client.capabilities(MODEL_ID, { signal: new AbortController().signal }));
    expect(raised).toBeInstanceOf(GatewayRequestError);
    expect(raised).not.toBeInstanceOf(ModelUnlistedError);
    expect(raised).toMatchObject({ status: 503, code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE });

    const { env, session, response } = await createRunWithImage((model) => client.capabilities(model, { signal: new AbortController().signal }));

    expect({ status: response.status, body: response.json }).toEqual({
      status: 409,
      body: { error: { type: 'conflict', code: TARGET_NOT_READY, message: TARGET_PROBING_MESSAGE } },
    });
    expect(response.headers['retry-after']).toBeUndefined();
    expect(env.errors).toEqual([]);
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('answers a failed measurement of the model with its own typed status, the cause the gateway names and when it measures again', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '75' });
      response.end(JSON.stringify({ error: { type: 'server_error', code: TARGET_PROBE_FAILED, message: 'measuring this model failed: the oil ran dry', param: null } }));
    });
    const client = makeClient(fake.socketPath, fakeClock());

    const { env, session, response } = await createRunWithImage((model) => client.capabilities(model, { signal: new AbortController().signal }));

    expect({ status: response.status, body: response.json }).toEqual({
      status: 503,
      body: { error: { type: 'server_error', code: TARGET_PROBE_FAILED, message: 'measuring this model failed: the oil ran dry; it is measured again in 75 seconds' } },
    });
    expect(response.headers['retry-after']).toBe('75');
    expect(env.errors).toEqual([]);
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('answers with the status, type, code and message of the gateway client when the listing no longer holds the model', async () => {
    const { env, session, response } = await createRunWithImage(await capabilitiesThroughEntries([entry(OTHER_MODEL_ID, defaultModelCapabilities(true))]));

    expect({ status: response.status, body: response.json }).toEqual({
      status: 404,
      body: { error: { type: 'not_found', code: 'model_not_found', message: `the gateway does not list the model "${MODEL_ID}"` } },
    });
    expect(response.json.error).not.toHaveProperty('param');
    expect(env.errors).toEqual([]);
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('still answers 503 gateway_unavailable with retry-after 1 when the gateway cannot be reached', async () => {
    const layout = makeLayout();
    const unreachable = createGatewayClient({ resolveSocket: fixedSocket(path.join(layout.runDir, 'absent-gateway.sock')), clock: fakeClock(), version: '0.0.0-test' });
    onCleanup(() => unreachable.destroy());

    const { env, session, response } = await createRunWithImage((model) => unreachable.capabilities(model, { signal: new AbortController().signal }));

    expect({ status: response.status, code: response.json.error.code, type: response.json.error.type, retryAfter: response.headers['retry-after'] }).toEqual({
      status: 503,
      code: 'gateway_unavailable',
      type: 'server_error',
      retryAfter: '1',
    });
    expect(env.errors).toEqual([]);
    expect(env.store.listRuns(session.id)).toEqual([]);
  });
});
