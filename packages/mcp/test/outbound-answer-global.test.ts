import { Response as UndiciResponse } from 'undici';
import { describe, expect, it } from 'vitest';
import { globalResponseOf } from '../src/remote-policy.ts';

describe('the answer of the outbound route is the global Response', () => {
  it('an OAuth error body is read as its text, with its status and headers', async () => {
    const refused = new UndiciResponse('{"error":"invalid_client"}', { status: 401, headers: { 'content-type': 'application/json' } });

    const answer = globalResponseOf(refused as never);

    expect(answer).toBeInstanceOf(Response);
    expect(answer.status).toBe(401);
    expect(answer.headers.get('content-type')).toBe('application/json');
    expect(await answer.text()).toBe('{"error":"invalid_client"}');
  });
});
