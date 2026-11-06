import { describe, expect, it } from 'vitest';
import { systemClock } from '@momonga/foundation';
import { createUpstreamClassifier } from '../src/adapters/shared/classify.ts';
import { httpErrorOf, nestedErrorDetail } from '../src/adapters/shared/http-error.ts';
import { CHAT_COMPLETIONS_VOCABULARY } from '../src/adapters/chat-completions/vocabulary.ts';

const classify = createUpstreamClassifier('test');

const classified = async (status: number, headers: Record<string, string>) => {
  const body = (async function* () {
    yield new TextEncoder().encode(JSON.stringify({ error: { message: 'x' } }));
  })();
  return classify(await httpErrorOf({ status, headers, body }, systemClock, nestedErrorDetail, CHAT_COMPLETIONS_VOCABULARY));
};

describe('one retry rule for an upstream HTTP error', () => {
  it('retries what the target says may be retried, whatever the status', async () => {
    for (const status of [404, 408, 409, 422, 429, 500]) {
      expect((await classified(status, { 'x-should-retry': 'true' })).retryable).toBe(true);
    }
  });

  it('does not retry what the target says must not be retried, whatever the status', async () => {
    for (const status of [408, 409, 429, 500, 503]) {
      expect((await classified(status, { 'x-should-retry': 'false' })).retryable).toBe(false);
    }
  });

  it('falls back to the status when the target reports nothing', async () => {
    for (const status of [408, 409, 429, 500]) expect((await classified(status, {})).retryable).toBe(true);
    for (const status of [401, 403, 404, 413, 422]) expect((await classified(status, {})).retryable).toBe(false);
  });

  it('keeps the error type of the status, and reports a retryable 408 or 409 as a server error', async () => {
    expect((await classified(429, { 'x-should-retry': 'false' })).error.type).toBe('too_many_requests');
    expect((await classified(422, { 'x-should-retry': 'true' })).error.type).toBe('invalid_request');
    expect((await classified(408, {})).error.type).toBe('server_error');
    expect((await classified(409, {})).error.type).toBe('server_error');
  });
});
