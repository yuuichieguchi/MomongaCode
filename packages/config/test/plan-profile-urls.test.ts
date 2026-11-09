import { describe, expect, it } from 'vitest';
import { assertPlanProfile, planProfileOf } from '../src/plan-profiles.ts';

const withOAuth = (change: Record<string, string>): unknown => {
  const shipped = structuredClone(planProfileOf('chatgpt')) as unknown as { oauth: Record<string, unknown> };
  return { ...shipped, oauth: { ...shipped.oauth, ...change } };
};

describe('profile URLs follow transportUrlProblem (O-R5-3 g, I-C2)', () => {
  it('accepts loopback http URLs for a test profile', () => {
    const loopback = 'http://127.0.0.1:4100';
    expect(() =>
      assertPlanProfile(
        withOAuth({ issuer: loopback, discoveryUrl: `${loopback}/.well-known/openid-configuration`, tokenUrl: `${loopback}/token`, authorizeUrl: `${loopback}/authorize`, jwksUrl: `${loopback}/jwks`, resource: `${loopback}/v1` }),
        'loopback profile',
      ),
    ).not.toThrow();
  });

  it('still refuses plain http to a remote host and a URL carrying userinfo', () => {
    expect(() => assertPlanProfile(withOAuth({ tokenUrl: 'http://auth.openai.com/token' }), 'remote http')).toThrow();
    expect(() => assertPlanProfile(withOAuth({ tokenUrl: 'https://user:secret@auth.openai.com/token' }), 'userinfo')).toThrow();
    expect(() => assertPlanProfile(withOAuth({ tokenUrl: 'http://localhost:4100/token' }), 'loopback by name')).not.toThrow();
  });
});
