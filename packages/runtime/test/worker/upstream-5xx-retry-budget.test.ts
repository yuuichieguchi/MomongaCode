import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

const LM_STUDIO_500 =
  'the upstream responded with HTTP 500: <!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Internal Server Error</pre>\n</body>\n</html>\n';

const upstream500AfterGatewayRetries = (): ScriptStep => ({
  events: [],
  error: new GatewayRequestError({ status: 502, type: 'server_error', code: 'upstream_error', message: LM_STUDIO_500 }),
});

describe('a model request that the upstream answers with HTTP 5xx after the gateway has spent its retries on it', () => {
  it('ends the run on that claim instead of sending the same request again on later claims', async () => {
    const env = await makeEnv({ maxAttempts: 20, maxTotalAttempts: 20 });
    env.gateway.script.push(upstream500AfterGatewayRetries(), upstream500AfterGatewayRetries(), upstream500AfterGatewayRetries(), textStep('never sent'));
    const run = await env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const after = env.run(run.id);
    expect({ status: after.status, code: after.error?.code }).toEqual({ status: 'FAILED', code: 'upstream_error' });
    expect(env.gateway.streams).toHaveLength(1);
  });
});
