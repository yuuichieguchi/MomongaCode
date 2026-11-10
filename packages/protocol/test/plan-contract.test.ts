import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BREAKER_VERDICTS,
  CREDENTIAL_EFFECTS,
  DEFAULT_RESPONSES_OUTPUT_BOUND,
  DEFAULT_SYSTEM_ROLE,
  DEFAULT_TOOL_PLACEMENT,
  ERROR_FALLBACKS,
  INPUT_CONTENT_KINDS,
  OUTPUT_BOUNDS,
  OUTPUT_BOUND_FIELDS,
  PLAN_ACCOUNT_STATES,
  PLAN_API_PREFIX,
  PLAN_ROUTES,
  REQUEST_TOOL_KINDS,
  RESPONSES_OUTPUT_BOUNDS,
  SYSTEM_ROLES,
  TARGET_BILLINGS,
  TOOL_PLACEMENTS,
  applyCapabilityOverride,
} from '../src/index.ts';
import type { Capabilities, PlanSignOutResponse } from '../src/index.ts';

const BASE: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'none',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 1,
  source: 'declared',
};

describe('billing kinds', () => {
  it('has the plan kind beside metered and local', () => {
    expect([...TARGET_BILLINGS]).toEqual(['metered', 'local', 'plan']);
  });
});

describe('how a route carries a requested output bound', () => {
  it('lists the chat-completions wire fields, the responses field and none', () => {
    expect([...OUTPUT_BOUNDS]).toEqual(['max_completion_tokens', 'max_tokens', 'max_output_tokens', 'none']);
    expect([...RESPONSES_OUTPUT_BOUNDS]).toEqual(['max_output_tokens', 'none']);
    expect(DEFAULT_RESPONSES_OUTPUT_BOUND).toBe('max_output_tokens');
  });

  it('leaves the fields a probe tries as the two chat-completions wire fields', () => {
    expect([...OUTPUT_BOUND_FIELDS]).toEqual(['max_completion_tokens', 'max_tokens']);
  });
});

describe('route carriage vocabularies', () => {
  it('names the instruction roles and the default', () => {
    expect([...SYSTEM_ROLES]).toEqual(['system', 'developer']);
    expect(DEFAULT_SYSTEM_ROLE).toBe('system');
  });

  it('names the tool placements and the default', () => {
    expect([...TOOL_PLACEMENTS]).toEqual(['top_level', 'additional_tools']);
    expect(DEFAULT_TOOL_PLACEMENT).toBe('top_level');
  });

  it('names the content kinds and the tool kinds a request can carry', () => {
    expect([...INPUT_CONTENT_KINDS]).toEqual(['file', 'audio', 'video']);
    expect([...REQUEST_TOOL_KINDS]).toEqual([
      'function',
      'custom',
      'programmatic_tool_calling',
      'image_generation',
      'file_search',
      'code_interpreter',
      'computer_use',
      'mcp',
      'tool_search',
    ]);
  });

  it('lets a declared override carry the new capabilities over a base', () => {
    const merged = applyCapabilityOverride(BASE, {
      outputBoundField: 'none',
      systemRole: 'developer',
      toolPlacement: 'additional_tools',
      inputKinds: { content: ['file'], tools: ['function'] },
    });
    expect(merged).toMatchObject({ outputBoundField: 'none', systemRole: 'developer', toolPlacement: 'additional_tools', inputKinds: { content: ['file'], tools: ['function'] } });
  });
});

describe('the error rule vocabulary', () => {
  it('names the breaker verdicts, the fallback answers and the credential effects', () => {
    expect([...BREAKER_VERDICTS]).toEqual(['failure', 'neutral']);
    expect([...ERROR_FALLBACKS]).toEqual(['next', 'stop']);
    expect([...CREDENTIAL_EFFECTS]).toEqual(['keep', 'pause', 'rejected']);
  });
});

describe('the plan admin routes', () => {
  it('sits under /v1/momonga/plan', () => {
    expect(PLAN_API_PREFIX).toBe('/v1/momonga/plan');
  });

  it('names every route of P5b once', () => {
    expect(PLAN_ROUTES).toEqual({
      signInBegin: '/sign-in/begin',
      signInComplete: '/sign-in/complete',
      signInCancel: '/sign-in/cancel',
      signOut: '/sign-out',
      accounts: '/accounts',
      accountsActive: '/accounts/active',
      accountResume: '/accounts/:account/resume',
      accountModels: '/accounts/:account/models',
      accountTargets: '/accounts/:account/targets',
      hostReset: '/host/reset',
    });
  });

  it('names the account states of the credential model', () => {
    expect([...PLAN_ACCOUNT_STATES]).toEqual(['active', 'plan_disabled', 'needs_sign_in', 'signing_out', 'registered', 'store_unreadable', 'store_unwritable']);
  });
});

describe('the sign-out response', () => {
  it('reports the revocation as confirmed, unconfirmed or none', () => {
    expectTypeOf<PlanSignOutResponse['revocation']>().toEqualTypeOf<'confirmed' | 'unconfirmed' | 'none'>();
    expectTypeOf<PlanSignOutResponse>().toEqualTypeOf<{ revocation: 'confirmed' | 'unconfirmed' | 'none'; usageUrl: string }>();
  });
});
