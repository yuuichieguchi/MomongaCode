import { describe, expect, it } from 'vitest';
import { TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import { GatewayRequestError, ModelUnlistedError } from '@momonga/runtime';
import { fakeClock, makeClient, settle, startRawHttpFake } from './fixtures.ts';

const UNKNOWN_SIZE_TEXT =
  'the model plan-model cannot be used yet: the settings give no context window and output limit for it, and the model list of its account reports none; momonga models --catalog reads the list';
const UNAVAILABLE = { toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: UNKNOWN_SIZE_TEXT, param: 'model' }, source: 'unprobed' };
const UNAVAILABLE_ERROR = { status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: UNKNOWN_SIZE_TEXT, param: 'model' };
const RETRY_AFTER_SECONDS = 120;
const PROBING = { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: RETRY_AFTER_SECONDS }, source: 'unprobed' };
const READY = { contextWindow: 8192 };

const entry = (id: string, capabilities: unknown, targetCapabilities: Record<string, unknown>) => ({
  id,
  object: 'model',
  targets: Object.keys(targetCapabilities),
  targetCounters: Object.fromEntries(Object.keys(targetCapabilities).map((target, index) => [target, String(index + 1).repeat(64)])),
  capabilities,
  targetCapabilities,
});

const clientListing = async (data: unknown[]) => {
  const fake = await startRawHttpFake();
  fake.respond((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data }));
  });
  return makeClient(fake.socketPath, fakeClock());
};

const signal = (): AbortSignal => new AbortController().signal;

const LISTING = [entry('plan', UNAVAILABLE, { gpt: UNAVAILABLE }), entry('other', READY, { spare: READY })];

describe('a model listing in which one alias is unavailable', () => {
  it('rejects the capabilities of the unavailable alias with its error and still answers the other alias', async () => {
    const client = await clientListing(LISTING);

    const failure = await settle(client.capabilities('plan', { signal: signal() }));

    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect(failure).toBeInstanceOf(ModelUnlistedError);
    expect(failure).toMatchObject(UNAVAILABLE_ERROR);
    expect(await client.capabilities('other', { signal: signal() })).toEqual(READY);
  });

  it('refuses a listing whose unavailable value is malformed', async () => {
    const malformed = { ...UNAVAILABLE, toolCalling: { ...UNAVAILABLE.toolCalling, status: 'x' } };
    const client = await clientListing([entry('plan', malformed, { gpt: malformed }), entry('other', READY, { spare: READY })]);

    const failure = await settle(client.capabilities('other', { signal: signal() }));

    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect(failure).toMatchObject({ code: 'invalid_response', message: 'the gateway sent a malformed reply: the model list holds a malformed unavailable entry' });
  });

  it('models() returns every alias, the unavailable one included', async () => {
    const client = await clientListing(LISTING);

    expect((await client.models()).map((model) => model.id)).toEqual(['plan', 'other']);
  });

  it('model(alias) of an unavailable alias rejects with a ModelUnlistedError carrying status, type, code, message and param, and model(other) resolves', async () => {
    const client = await clientListing(LISTING);

    const failure = await settle(client.model('plan', { signal: signal() }));

    expect(failure).toBeInstanceOf(ModelUnlistedError);
    expect(failure).toMatchObject(UNAVAILABLE_ERROR);
    expect(await client.model('other', { signal: signal() })).toMatchObject({ id: 'other', capabilities: READY });
  });

  it('modelOf of [probing, unavailable] rejects with the 503 target_probing error, of [unavailable, probing] with the unavailable member error', async () => {
    const client = await clientListing([entry('probing-first', PROBING, { p: PROBING, u: UNAVAILABLE }), entry('unavailable-first', UNAVAILABLE, { u: UNAVAILABLE, p: PROBING })]);

    const probingFirst = await settle(client.model('probing-first', { signal: signal() }));
    const unavailableFirst = await settle(client.model('unavailable-first', { signal: signal() }));

    expect(probingFirst).toBeInstanceOf(ModelUnlistedError);
    expect(probingFirst).toMatchObject({ status: 503, type: 'server_error', code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE, retryAfterMs: RETRY_AFTER_SECONDS * 1000 });
    expect(unavailableFirst).toBeInstanceOf(ModelUnlistedError);
    expect(unavailableFirst).toMatchObject(UNAVAILABLE_ERROR);
  });
});
