import { describe, expect, it } from 'vitest';
import { TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { fakeClock, listedEntry, listingBody, makeClient, startRawHttpFake } from './fixtures.ts';

const MEASURED = 'apple/system';

const RETRY_AFTER_SECONDS = 120;
const PROBING = { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: RETRY_AFTER_SECONDS, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } }, source: 'unprobed' };

describe('a model listing in which the gateway is measuring one model', () => {
  it('rejects the capabilities of the measured model as a 503 target_probing with its Retry-After, and still answers the other model', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(listingBody([listedEntry(MEASURED, PROBING), listedEntry('fake/other', { contextWindow: 8192 })])),
      );
    });
    const client = makeClient(fake.socketPath, fakeClock());
    const signal = new AbortController().signal;

    const failure = await client.capabilities(MEASURED, { signal }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect(failure).toMatchObject({ status: 503, code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE, retryAfterMs: RETRY_AFTER_SECONDS * 1000 });
    expect(await client.capabilities('fake/other', { signal })).toEqual({ contextWindow: 8192 });
  });
});
