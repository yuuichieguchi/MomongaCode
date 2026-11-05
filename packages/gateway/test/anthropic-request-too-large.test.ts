import { describe, expect, it } from 'vitest';
import { HTTP_TRANSPORT_VOCABULARY } from '../src/adapters/shared/vocabulary.ts';
import { createUpstreamClassifier } from '../src/adapters/shared/classify.ts';
import { anthropicErrorDetail } from '../src/adapters/anthropic/errors.ts';
import { httpErrorOf } from '../src/adapters/shared/http-error.ts';
import { createFakeClock } from '@momonga/testkit';

async function* bytesOf(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

describe('an Anthropic HTTP 413 request_too_large', () => {
  it('is a body size limit, not a context overflow', async () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum allowed number of bytes.' } });
    const error = await httpErrorOf({ status: 413, headers: {}, body: bytesOf(body) }, createFakeClock(0), anthropicErrorDetail, HTTP_TRANSPORT_VOCABULARY);

    const result = createUpstreamClassifier('anthropic')(error);

    expect(result.retryable).toBe(false);
    expect(result.error).toMatchObject({ type: 'invalid_request', code: 'payload_too_large' });
  });
});
