import { describe, expect, it } from 'vitest';
import { tokenResponseProblem } from '../src/plan/refresh.ts';

const answer = (expiresIn: unknown): Record<string, unknown> => ({
  access_token: 'access-value',
  refresh_token: 'refresh-value',
  token_type: 'Bearer',
  scope: 'openid offline_access',
  expires_in: expiresIn,
});

describe('tokenResponseProblem accepts every positive integer lifetime and refuses the rest (O-R5-5 item 1)', () => {
  it.each([{ refreshRequired: true }, { refreshRequired: false }])('accepts 1, 121 and 122 and refuses 0 and 1.5 with %j', (grant) => {
    for (const seconds of [1, 121, 122]) expect(tokenResponseProblem(answer(seconds), grant)).toBeUndefined();
    for (const seconds of [0, 1.5, -3]) expect(tokenResponseProblem(answer(seconds), grant)).toBe('the token response has no positive integer expires_in');
  });
});
