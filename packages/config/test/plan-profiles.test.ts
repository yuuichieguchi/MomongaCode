import { describe, expect, it } from 'vitest';
import { PLAN_PROFILES, assertPlanProfile, planProfileOf } from '@momonga/config';
import type { PlanProfile } from '@momonga/config';

const profile = (): PlanProfile => planProfileOf('chatgpt');

const clone = (): Record<string, unknown> => structuredClone(profile()) as unknown as Record<string, unknown>;

describe('the shipped plan profiles', () => {
  it('states an expired sign-in with no command: the surface names its own sign-in command where the message is shown', () => {
    const rejected = profile().errorRules.filter((rule) => rule.code === 'plan_credential_rejected');
    expect(rejected).toHaveLength(2);
    for (const rule of rejected) expect(rule.message).toBe('The sign-in of this account has expired');
  });

  it('holds exactly one profile, keyed by its id', () => {
    expect(Object.keys(PLAN_PROFILES)).toEqual(['chatgpt']);
    expect(profile().id).toBe('chatgpt');
  });

  it('names the adapter that carries the route', () => {
    expect(profile().adapter).toBe('open-responses');
  });

  it('refuses an unknown profile id', () => {
    expect(() => planProfileOf('nowhere')).toThrow(/nowhere/);
  });

  it('is valid against the profile schema', () => {
    expect(assertPlanProfile(structuredClone(profile()), 'test')).toEqual(profile());
  });
});

describe('the OAuth data of the ChatGPT profile', () => {
  it('holds the endpoints and scopes the sign-in pages state', () => {
    expect(profile().oauth).toEqual({
      issuer: 'https://auth.openai.com',
      discoveryUrl: 'https://auth.openai.com/.well-known/openid-configuration',
      authorizeUrl: 'https://auth.openai.com/api/accounts/authorize',
      tokenUrl: 'https://auth.openai.com/api/accounts/oauth/token',
      jwksUrl: 'https://auth.openai.com/.well-known/jwks.json',
      resource: 'https://api.openai.com/v1',
      identityScopes: ['openid', 'profile', 'email'],
      useScopes: ['offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      requiredScope: 'chatgpt.tokens.use.direct',
      registrationClientId: 'dynamic_agent_client',
      callbackPath: '/auth/callback',
      registrationParameters: { agentNameHint: 'agent_name_hint', hostId: 'ext_agent_host_id' },
      idTokenAlgorithms: ['RS256'],
    });
  });

  it('keeps every OAuth endpoint on the issuer origin', () => {
    const { oauth } = profile();
    const origin = new URL(oauth.issuer).origin;
    for (const url of [oauth.discoveryUrl, oauth.authorizeUrl, oauth.tokenUrl, oauth.jwksUrl]) expect(new URL(url).origin).toBe(origin);
  });

  it('requires the use scope among the requested scopes', () => {
    const { oauth } = profile();
    expect(oauth.useScopes).toContain(oauth.requiredScope);
  });
});

describe('what the route cannot carry, as data', () => {
  it('states the target defaults of the route and nothing unknown', () => {
    expect(profile().targetDefaults).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      billing: 'plan',
      capabilities: {
        sampling: { accepts: 'none' },
        outputBoundField: 'none',
        systemRole: 'developer',
        toolPlacement: 'additional_tools',
        inputKinds: { content: ['file'], tools: ['function', 'custom'] },
      },
    });
  });

  it('leaves promptCache and reasoning absent because the pages do not state them', () => {
    const { capabilities } = profile().targetDefaults;
    expect(capabilities).not.toHaveProperty('promptCache');
    expect(capabilities).not.toHaveProperty('reasoning');
  });

  it('binds the default base URL to the resource origin', () => {
    const { targetDefaults, oauth } = profile();
    expect(new URL(targetDefaults.baseUrl).origin).toBe(new URL(oauth.resource).origin);
  });
});

describe('the model list shape', () => {
  it('names where the list and the ids are and nothing about a capability', () => {
    expect(profile().catalog).toEqual({ path: '/models', listKey: 'models', filter: { field: 'visibility', equals: 'list' }, unusableWhen: { field: 'supported_in_api', equals: false, reason: 'not available through the API' }, idKey: 'slug', labelKey: 'display_name' });
  });
});

describe('the user-facing sentences', () => {
  it('holds OpenAI text for the identity, the invitation and the usage link', () => {
    const { messages, usageUrl } = profile();
    expect(usageUrl).toBe('https://chatgpt.com/settings/usage');
    expect(messages).toMatchObject({
      identityLabel: 'ChatGPT',
      pickerLabel: 'OpenAI (ChatGPT subscription)',
      apiKeyLabel: 'OpenAI (API key)',
      inviteTitle: 'Use your ChatGPT plan in this app.',
      description: 'Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.',
      planInUseLabel: 'Using ChatGPT plan',
      manageUsageLabel: 'Manage usage',
      usageLimitMessage: "Usage limit reached — Review your plan or this app's limit in ChatGPT settings.",
      signInExpiredMessage: 'ChatGPT sign-in expired',
      signInRequiredMessage: 'Not signed in to ChatGPT',
      firstSignIn: {
        title: "You're using your ChatGPT plan",
        body: 'Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.',
        action: 'Got it',
      },
    });
    expect(profile().loginLabel).toBe('Continue with ChatGPT');
    expect(profile().displayName).toBe('ChatGPT');
  });

  it('has a non-empty sentence for the two states OpenAI describes without quoting a message', () => {
    expect(profile().messages.planNotEnabledMessage.length).toBeGreaterThan(0);
    expect(profile().messages.notEligibleMessage.length).toBeGreaterThan(0);
  });
});

describe('the error rules', () => {
  const rule = (code: string) => profile().errorRules.find((entry) => entry.match.kind === 'code' && entry.match.codes.includes(code));
  const statusRule = (status: number) => profile().errorRules.find((entry) => entry.match.kind === 'status' && entry.match.status === status);

  it.each([
    ['subscription_sharing_usage_limit_exceeded', 'too_many_requests', 'plan_usage_limit', false, 'neutral', 'stop', 'pause'],
    ['subscription_sharing_workplace_individual_usage_limit_exceeded', 'too_many_requests', 'plan_workspace_usage_limit', false, 'neutral', 'stop', 'pause'],
    ['subscription_sharing_usage_unavailable', 'server_error', 'plan_usage_unavailable', true, 'failure', 'next', 'keep'],
    ['subscription_sharing_user_unavailable', 'server_error', 'plan_user_unavailable', true, 'failure', 'next', 'keep'],
    ['subscription_sharing_user_not_eligible', 'invalid_request', 'plan_not_eligible', false, 'failure', 'stop', 'keep'],
    ['subscription_sharing_unsupported_capability', 'invalid_request', 'plan_unsupported_capability', false, 'neutral', 'stop', 'keep'],
    ['subscription_sharing_route_not_supported', 'invalid_request', 'plan_route_not_supported', false, 'neutral', 'stop', 'keep'],
    ['subscription_sharing_invalid_user', 'invalid_request', 'plan_credential_rejected', false, 'failure', 'stop', 'rejected'],
    ['chatpass_v2_scope_not_authorized', 'invalid_request', 'plan_grant_not_authorized', false, 'failure', 'stop', 'keep'],
    ['chatpass_v2_invalid_authorization_context', 'invalid_request', 'plan_grant_not_authorized', false, 'failure', 'stop', 'keep'],
  ])('decides %s completely', (upstream, type, code, retryable, verdict, fallback, credential) => {
    expect(rule(upstream)).toMatchObject({ type, code, retryable, verdict, fallback, credential });
  });

  it.each([
    [401, 'invalid_request', 'plan_credential_rejected', false, 'failure', 'stop', 'rejected'],
    [403, 'invalid_request', 'plan_admission_denied', false, 'failure', 'stop', 'keep'],
    [503, 'server_error', 'plan_route_unavailable', true, 'failure', 'next', 'keep'],
  ])('decides an undocumented code on status %i', (status, type, code, retryable, verdict, fallback, credential) => {
    expect(statusRule(status)).toMatchObject({ type, code, retryable, verdict, fallback, credential });
  });

  it('refuses a profile without the not-signed-in sentence', () => {
    const copy = structuredClone(profile()) as unknown as { messages: Record<string, unknown> };
    delete copy.messages['signInRequiredMessage'];
    expect(() => assertPlanProfile(copy, 'test')).toThrow(/signInRequiredMessage/);
  });

  it('keeps the parameter the server names on an unsupported capability only', () => {
    const keeping = profile().errorRules.filter((entry) => entry.keepParam === true).map((entry) => entry.code);
    expect(keeping).toEqual(['plan_unsupported_capability']);
  });

  it('stops on every quota, eligibility and grant rule and never retries them', () => {
    for (const entry of profile().errorRules.filter((candidate) => candidate.credential === 'pause' || candidate.code === 'plan_not_eligible')) {
      expect(entry.fallback).toBe('stop');
      expect(entry.retryable).toBe(false);
    }
  });

  it('never matches one upstream code in two rules', () => {
    const codes = profile().errorRules.flatMap((entry) => (entry.match.kind === 'code' ? entry.match.codes : []));
    expect(new Set(codes).size).toBe(codes.length);
    const statuses = profile().errorRules.flatMap((entry) => (entry.match.kind === 'status' ? [entry.match.status] : []));
    expect(new Set(statuses).size).toBe(statuses.length);
  });
});

describe('the profile schema', () => {
  it('refuses a missing field', () => {
    const broken = clone();
    delete broken['usageUrl'];
    expect(() => assertPlanProfile(broken, 'broken')).toThrow(/broken/);
  });

  it('refuses a field it does not know', () => {
    expect(() => assertPlanProfile({ ...clone(), extra: 1 }, 'broken')).toThrow(/extra/);
  });

  it('refuses an endpoint that is not https', () => {
    const broken = clone();
    broken['oauth'] = { ...(broken['oauth'] as Record<string, unknown>), tokenUrl: 'http://auth.openai.com/api/accounts/oauth/token' };
    expect(() => assertPlanProfile(broken, 'broken')).toThrow(/tokenUrl/);
  });

  it('refuses an ID token algorithm other than a named one', () => {
    const broken = clone();
    broken['oauth'] = { ...(broken['oauth'] as Record<string, unknown>), idTokenAlgorithms: ['none'] };
    expect(() => assertPlanProfile(broken, 'broken')).toThrow(/idTokenAlgorithms/);
  });

  it('refuses an error rule with an unknown credential effect', () => {
    const broken = clone();
    const rules = structuredClone(profile().errorRules) as unknown as Record<string, unknown>[];
    rules[0] = { ...rules[0], credential: 'clear' };
    broken['errorRules'] = rules;
    expect(() => assertPlanProfile(broken, 'broken')).toThrow(/credential/);
  });
});
