import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '@momonga/runtime';
import { startService } from './helpers.ts';

describe('a gateway answer the runtime has no mapping for', () => {
  it('reaches the client with its own status, code and text, never as a 500 without a reason', async () => {
    const env = await startService();
    const session = await env.createSession();
    env.ports.listingFailure.error = new GatewayRequestError({ status: 409, type: 'invalid_request', code: 'model_measuring_elsewhere', message: 'the gateway is measuring the model; step 2 of 3' });
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'say hello' } });
    expect({ status: response.status, body: response.json }).toEqual({ status: 409, body: { error: { type: 'invalid_request', code: 'model_measuring_elsewhere', message: 'the gateway is measuring the model; step 2 of 3' } } });
    expect(env.errors).toEqual([]);
  });
});
