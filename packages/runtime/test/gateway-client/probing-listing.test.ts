import { describe, expect, it } from 'vitest';
import { TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { fakeClock, makeClient, startRawHttpFake } from './fixtures.ts';

const RETRY_AFTER_SECONDS = 120;

describe('a model listing in which the gateway is measuring one alias', () => {
  it('rejects the capabilities of the measured alias as a 503 target_probing with its Retry-After, and still answers the other alias', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'default', object: 'model', targets: ['fm'], targetCounters: { fm: '1'.repeat(64) }, probing: { message: TARGET_PROBING_MESSAGE, retryAfterSeconds: RETRY_AFTER_SECONDS } },
            { id: 'other', object: 'model', targets: ['spare'], capabilities: { contextWindow: 8192 }, targetCapabilities: { spare: { contextWindow: 8192 } }, targetCounters: { spare: '2'.repeat(64) } },
          ],
        }),
      );
    });
    const client = makeClient(fake.socketPath, fakeClock());
    const signal = new AbortController().signal;

    const failure = await client.capabilities('default', { signal }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect(failure).toMatchObject({ status: 503, code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE, retryAfterMs: RETRY_AFTER_SECONDS * 1000 });
    expect(await client.capabilities('other', { signal })).toEqual({ contextWindow: 8192 });
  });
});
