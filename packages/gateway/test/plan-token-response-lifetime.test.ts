import { describe, expect, it } from 'vitest';
import { tokenResponseProblem } from '../src/plan/refresh.ts';

const answer = (expiresIn: number): Record<string, unknown> => ({
  access_token: 'access-value',
  refresh_token: 'refresh-value',
  token_type: 'Bearer',
  scope: 'openid offline_access',
  expires_in: expiresIn,
});

describe('tokenResponseProblem refuses a lifetime that does not exceed the refresh margin, for both grants (O-R5-4, section 6)', () => {
  it.each([{ refreshRequired: true }, { refreshRequired: false }])('names the problem for expires_in 121 with %j and accepts 122', (grant) => {
    expect(tokenResponseProblem(answer(121), grant)).toBe('the token response lifetime does not exceed the refresh margin');
    expect(tokenResponseProblem(answer(1), grant)).toBe('the token response lifetime does not exceed the refresh margin');
    expect(tokenResponseProblem(answer(122), grant)).toBeUndefined();
  });
});
