import { describe, expect, it } from 'vitest';
import { tokenResponseOf, tokenResponseProblem } from '../src/plan/refresh.ts';

const answer = (members: Record<string, unknown>): Record<string, unknown> => ({
  access_token: 'access-value',
  refresh_token: 'refresh-value',
  token_type: 'Bearer',
  scope: 'openid offline_access',
  expires_in: 3600,
  ...members,
});

const lifetimeOf = (expiresIn: unknown): unknown => {
  const reading = tokenResponseOf(answer({ expires_in: expiresIn }), { refreshRequired: true });
  if ('problem' in reading) throw new Error(reading.problem);
  return reading.tokens.expires_in;
};

describe('tokenResponseProblem accepts every finite positive lifetime and refuses the rest', () => {
  it.each([{ refreshRequired: true }, { refreshRequired: false }])('accepts 1, 121, 122, 1.5 and 0.25 and refuses 0, -3, Infinity, NaN and text with %j', (grant) => {
    for (const seconds of [1, 121, 122, 1.5, 0.25, 3599.9]) expect(tokenResponseProblem(answer({ expires_in: seconds }), grant)).toBeUndefined();
    for (const seconds of [0, -3, Number.POSITIVE_INFINITY, Number.NaN, '3600']) expect(tokenResponseProblem(answer({ expires_in: seconds }), grant)).toBe('the token response has no positive expires_in');
  });

  it('schedules on the whole seconds of the lifetime, never below one second', () => {
    expect(lifetimeOf(3599.9)).toBe(3599);
    expect(lifetimeOf(1.5)).toBe(1);
    expect(lifetimeOf(0.25)).toBe(1);
    expect(lifetimeOf(3600)).toBe(3600);
  });
});

describe('the token type is read without regard to case and may be absent', () => {
  it.each(['Bearer', 'bearer', 'BEARER'])('accepts %s', (tokenType) => {
    expect(tokenResponseProblem(answer({ token_type: tokenType }), { refreshRequired: true })).toBeUndefined();
  });

  it('accepts an absent or null token type', () => {
    const { token_type: _type, ...without } = answer({});
    expect(tokenResponseProblem(without, { refreshRequired: true })).toBeUndefined();
    expect(tokenResponseProblem(answer({ token_type: null }), { refreshRequired: true })).toBeUndefined();
  });

  it('refuses a present type that is not bearer', () => {
    for (const tokenType of ['mac', 'DPoP', '', 7]) expect(tokenResponseProblem(answer({ token_type: tokenType }), { refreshRequired: true })).toBe('the token response is not a Bearer token');
  });
});
