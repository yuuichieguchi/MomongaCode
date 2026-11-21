import { defineProductSchema, transportUrlMessage, transportUrlProblem } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import {
  BREAKER_VERDICTS,
  CREDENTIAL_EFFECTS,
  ERROR_FALLBACKS,
  ERROR_TYPES,
  INPUT_CONTENT_KINDS,
  REQUEST_TOOL_KINDS,
  SYSTEM_ROLES,
  TOOL_PLACEMENTS,
} from '@momonga/protocol';
import type { CapabilitiesCore, ErrorRules, PlanProfileMessages, TargetBilling } from '@momonga/protocol';
import { describeSchemaErrors } from './schema-errors.ts';

export type PlanProfileCapabilities = Partial<Pick<CapabilitiesCore, 'sampling' | 'outputBoundField' | 'systemRole' | 'toolPlacement' | 'inputKinds'>>;

export type PlanProfileOAuthClient =
  | { kind: 'dynamic_registration'; registrationClientId: string; registrationParameters: { agentNameHint: string; hostId: string } }
  | { kind: 'public'; clientId: string };

export type PlanProfileOAuth = {
  issuer: string;
  discoveryUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  resource: string;
  sendResource: boolean;
  identityScopes: string[];
  useScopes: string[];
  requiredScope: string;
  client: PlanProfileOAuthClient;
  callbackPath: string;
  callbackPort?: number;
  idTokenAlgorithms: string[];
};

export type PlanProfileCatalogUnusableRule =
  | { field: string; equals: boolean; reason: string }
  | { field: string; absent: true; reason: string };

export type PlanProfileCatalogReasoning = {
  effortsPath: string[];
  defaultPath: string[];
};

export type PlanProfileCatalog = {
  path: string;
  listKey: string;
  filter: { field: string; equals: string };
  unusableWhen: PlanProfileCatalogUnusableRule;
  idKey: string;
  labelKey: string;
  reasoning: PlanProfileCatalogReasoning;
};

export const PLAN_REQUEST_ENCODINGS = ['identity', 'zstd'] as const;

export type PlanRequestEncoding = (typeof PLAN_REQUEST_ENCODINGS)[number];

export type PlanProfileRequestWire = { encoding: PlanRequestEncoding; sessionHeaders: string[] };

export type PlanProfile = {
  id: string;
  adapter: 'open-responses';
  displayName: string;
  usageUrl: string;
  loginLabel: string;
  messages: PlanProfileMessages;
  oauth: PlanProfileOAuth;
  targetDefaults: { baseUrl: string; billing: TargetBilling; capabilities: PlanProfileCapabilities };
  requestWire: PlanProfileRequestWire;
  errorRules: ErrorRules;
  catalog: PlanProfileCatalog;
};

const NON_EMPTY_STRING = { type: 'string', minLength: 1 } as const;
const HTTPS_URL = { type: 'string', pattern: '^https://[^\\s]+$' } as const;
const TRANSPORT_URL = { type: 'string', pattern: '^[^\\s]+$' } as const;
const NON_EMPTY_STRINGS = { type: 'array', items: NON_EMPTY_STRING, minItems: 1 } as const;

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false }) as const;

const INPUT_KINDS_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'array', items: { enum: [...INPUT_CONTENT_KINDS] }, uniqueItems: true },
    tools: { type: 'array', items: { enum: [...REQUEST_TOOL_KINDS] }, uniqueItems: true },
  },
  required: ['content', 'tools'],
  additionalProperties: false,
} as const;

const SAMPLING_NONE_SCHEMA = { type: 'object', properties: { accepts: { const: 'none' } }, required: ['accepts'], additionalProperties: false } as const;

const ERROR_RULE_SCHEMA = {
  type: 'object',
  properties: {
    match: {
      oneOf: [
        { type: 'object', properties: { kind: { const: 'code' }, codes: NON_EMPTY_STRINGS }, required: ['kind', 'codes'], additionalProperties: false },
        { type: 'object', properties: { kind: { const: 'status' }, status: { type: 'integer', minimum: 100, maximum: 599 } }, required: ['kind', 'status'], additionalProperties: false },
      ],
    },
    type: { enum: [...ERROR_TYPES] },
    code: NON_EMPTY_STRING,
    retryable: { type: 'boolean' },
    verdict: { enum: [...BREAKER_VERDICTS] },
    fallback: { enum: [...ERROR_FALLBACKS] },
    credential: { enum: [...CREDENTIAL_EFFECTS] },
    keepParam: { const: true },
    message: NON_EMPTY_STRING,
    cause: NON_EMPTY_STRING,
  },
  required: ['match', 'type', 'code', 'retryable', 'verdict', 'fallback', 'credential', 'message'],
  additionalProperties: false,
} as const;

const PLAN_PROFILE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9._-]*$' },
    adapter: { const: 'open-responses' },
    displayName: NON_EMPTY_STRING,
    usageUrl: HTTPS_URL,
    loginLabel: NON_EMPTY_STRING,
    messages: {
      type: 'object',
      properties: {
        identityLabel: NON_EMPTY_STRING,
        pickerLabel: NON_EMPTY_STRING,
        apiKeyLabel: NON_EMPTY_STRING,
        inviteTitle: NON_EMPTY_STRING,
        description: NON_EMPTY_STRING,
        planInUseLabel: NON_EMPTY_STRING,
        manageUsageLabel: NON_EMPTY_STRING,
        usageLimitMessage: NON_EMPTY_STRING,
        signInExpiredMessage: NON_EMPTY_STRING,
        signInRequiredMessage: NON_EMPTY_STRING,
        planNotEnabledMessage: NON_EMPTY_STRING,
        notEligibleMessage: NON_EMPTY_STRING,
        firstSignIn: object({ title: NON_EMPTY_STRING, body: NON_EMPTY_STRING, action: NON_EMPTY_STRING }),
      },
      required: [
        'identityLabel',
        'pickerLabel',
        'apiKeyLabel',
        'inviteTitle',
        'description',
        'planInUseLabel',
        'manageUsageLabel',
        'usageLimitMessage',
        'signInExpiredMessage',
        'signInRequiredMessage',
        'planNotEnabledMessage',
        'notEligibleMessage',
        'firstSignIn',
      ],
      additionalProperties: false,
    },
    oauth: {
      type: 'object',
      properties: {
        issuer: TRANSPORT_URL,
        discoveryUrl: TRANSPORT_URL,
        authorizeUrl: TRANSPORT_URL,
        tokenUrl: TRANSPORT_URL,
        jwksUrl: TRANSPORT_URL,
        resource: TRANSPORT_URL,
        sendResource: { type: 'boolean' },
        identityScopes: NON_EMPTY_STRINGS,
        useScopes: NON_EMPTY_STRINGS,
        requiredScope: NON_EMPTY_STRING,
        client: {
          oneOf: [
            object({
              kind: { const: 'dynamic_registration' },
              registrationClientId: NON_EMPTY_STRING,
              registrationParameters: object({ agentNameHint: NON_EMPTY_STRING, hostId: NON_EMPTY_STRING }),
            }),
            object({ kind: { const: 'public' }, clientId: NON_EMPTY_STRING }),
          ],
        },
        callbackPath: { type: 'string', pattern: '^/[^\\s]*$' },
        callbackPort: { type: 'integer', minimum: 1, maximum: 65535 },
        idTokenAlgorithms: { type: 'array', items: { enum: ['RS256', 'ES256'] }, minItems: 1, uniqueItems: true },
      },
      required: ['issuer', 'discoveryUrl', 'authorizeUrl', 'tokenUrl', 'jwksUrl', 'resource', 'sendResource', 'identityScopes', 'useScopes', 'requiredScope', 'client', 'callbackPath', 'idTokenAlgorithms'],
      additionalProperties: false,
    },
    targetDefaults: object({
      baseUrl: TRANSPORT_URL,
      billing: { const: 'plan' },
      capabilities: {
        type: 'object',
        properties: {
          sampling: SAMPLING_NONE_SCHEMA,
          outputBoundField: { enum: ['max_output_tokens', 'none'] },
          systemRole: { enum: [...SYSTEM_ROLES] },
          toolPlacement: { enum: [...TOOL_PLACEMENTS] },
          inputKinds: INPUT_KINDS_SCHEMA,
        },
        additionalProperties: false,
      },
    }),
    requestWire: object({
      encoding: { enum: [...PLAN_REQUEST_ENCODINGS] },
      sessionHeaders: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9-]+$' }, uniqueItems: true },
    }),
    errorRules: { type: 'array', items: ERROR_RULE_SCHEMA, minItems: 1 },
    catalog: object({
      path: { type: 'string', pattern: '^/[^\\s]*$' },
      listKey: NON_EMPTY_STRING,
      filter: object({ field: NON_EMPTY_STRING, equals: NON_EMPTY_STRING }),
      unusableWhen: {
        oneOf: [
          object({ field: NON_EMPTY_STRING, equals: { type: 'boolean' }, reason: NON_EMPTY_STRING }),
          object({ field: NON_EMPTY_STRING, absent: { const: true }, reason: NON_EMPTY_STRING }),
        ],
      },
      idKey: NON_EMPTY_STRING,
      labelKey: NON_EMPTY_STRING,
      reasoning: object({ effortsPath: NON_EMPTY_STRINGS, defaultPath: NON_EMPTY_STRINGS }),
    }),
  },
  required: ['id', 'adapter', 'displayName', 'usageUrl', 'loginLabel', 'messages', 'oauth', 'targetDefaults', 'requestWire', 'errorRules', 'catalog'],
  additionalProperties: false,
} as const;

const validatePlanProfile: ProductValidator<PlanProfile> = defineProductSchema('config/plan-profile', PLAN_PROFILE_SCHEMA);

export const assertPlanProfile = (value: unknown, source: string): PlanProfile => {
  const verdict = validatePlanProfile(value);
  if (!verdict.valid) throw new Error(`${source}: invalid plan profile at ${describeSchemaErrors(verdict.errors)}`);
  const { oauth, targetDefaults } = verdict.value;
  const transports: Array<[string, string]> = [
    ['oauth.issuer', oauth.issuer],
    ['oauth.discoveryUrl', oauth.discoveryUrl],
    ['oauth.authorizeUrl', oauth.authorizeUrl],
    ['oauth.tokenUrl', oauth.tokenUrl],
    ['oauth.jwksUrl', oauth.jwksUrl],
    ['oauth.resource', oauth.resource],
    ['targetDefaults.baseUrl', targetDefaults.baseUrl],
  ];
  for (const [field, url] of transports) {
    const problem = transportUrlProblem(url);
    if (problem !== undefined) throw new Error(`${source}: invalid plan profile: ${transportUrlMessage(field, url, problem)}`);
  }
  return verdict.value;
};

const CHATGPT_PROFILE_DATA = {
  id: 'chatgpt',
  adapter: 'open-responses',
  displayName: 'ChatGPT',
  usageUrl: 'https://chatgpt.com/settings/usage',
  loginLabel: 'Continue with ChatGPT',
  messages: {
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
    planNotEnabledMessage: "ChatGPT plan use isn't enabled",
    notEligibleMessage: 'ChatGPT plan usage is unavailable for the selected user, workspace, or policy.',
    firstSignIn: {
      title: "You're using your ChatGPT plan",
      body: 'Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.',
      action: 'Got it',
    },
  },
  oauth: {
    issuer: 'https://auth.openai.com',
    discoveryUrl: 'https://auth.openai.com/.well-known/openid-configuration',
    authorizeUrl: 'https://auth.openai.com/api/accounts/authorize',
    tokenUrl: 'https://auth.openai.com/api/accounts/oauth/token',
    jwksUrl: 'https://auth.openai.com/.well-known/jwks.json',
    resource: 'https://api.openai.com/v1',
    sendResource: true,
    identityScopes: ['openid', 'profile', 'email'],
    useScopes: ['offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
    requiredScope: 'chatgpt.tokens.use.direct',
    client: {
      kind: 'dynamic_registration',
      registrationClientId: 'dynamic_agent_client',
      registrationParameters: { agentNameHint: 'agent_name_hint', hostId: 'ext_agent_host_id' },
    },
    callbackPath: '/auth/callback',
    idTokenAlgorithms: ['RS256'],
  },
  targetDefaults: {
    baseUrl: 'https://api.openai.com/v1',
    billing: 'plan',
    capabilities: {
      sampling: { accepts: 'none' },
      outputBoundField: 'none',
      systemRole: 'developer',
      toolPlacement: 'additional_tools',
      inputKinds: { content: ['file'], tools: ['function', 'custom'] },
    },
  },
  requestWire: { encoding: 'zstd', sessionHeaders: ['session-id', 'thread-id', 'x-client-request-id'] },
  errorRules: [
    {
      match: { kind: 'code', codes: ['subscription_sharing_usage_limit_exceeded'] },
      type: 'too_many_requests',
      code: 'plan_usage_limit',
      retryable: false,
      verdict: 'neutral',
      fallback: 'stop',
      credential: 'pause',
      message: 'This account has reached the usage its plan allows for now. Wait for the usage to reset, or manage the usage in the ChatGPT settings',
    },
    {
      match: { kind: 'code', codes: ['subscription_sharing_workplace_individual_usage_limit_exceeded'] },
      type: 'too_many_requests',
      code: 'plan_workspace_usage_limit',
      retryable: false,
      verdict: 'neutral',
      fallback: 'stop',
      credential: 'pause',
      message: 'This account has reached the usage its workspace allows. Ask the workspace admin to allow more',
    },
    {
      match: { kind: 'code', codes: ['subscription_sharing_usage_unavailable'] },
      type: 'server_error',
      code: 'plan_usage_unavailable',
      retryable: true,
      verdict: 'failure',
      fallback: 'next',
      credential: 'keep',
      message: 'Try again later',
    },
    {
      match: { kind: 'code', codes: ['subscription_sharing_user_unavailable'] },
      type: 'server_error',
      code: 'plan_user_unavailable',
      retryable: true,
      verdict: 'failure',
      fallback: 'next',
      credential: 'keep',
      message: 'Try again later',
    },
    {
      match: { kind: 'code', codes: ['subscription_sharing_user_not_eligible'] },
      type: 'invalid_request',
      code: 'plan_not_eligible',
      retryable: false,
      verdict: 'failure',
      fallback: 'stop',
      credential: 'keep',
      message: 'This account cannot use its plan here. Sign in with another account, or use a model with an API key',
    },
    {
      match: { kind: 'code', codes: ['subscription_sharing_unsupported_capability'] },
      type: 'invalid_request',
      code: 'plan_unsupported_capability',
      retryable: false,
      verdict: 'neutral',
      fallback: 'stop',
      credential: 'keep',
      keepParam: true,
      message: 'The plan does not accept a setting of this request',
      cause: 'The route does not carry the named parameter',
    },
    {
      match: { kind: 'code', codes: ['subscription_sharing_route_not_supported'] },
      type: 'invalid_request',
      code: 'plan_route_not_supported',
      retryable: false,
      verdict: 'neutral',
      fallback: 'stop',
      credential: 'keep',
      message: 'The plan does not accept this kind of request',
      cause: 'The route is POST /v1/responses',
    },
    {
      match: { kind: 'code', codes: ['subscription_sharing_invalid_user'] },
      type: 'invalid_request',
      code: 'plan_credential_rejected',
      retryable: false,
      verdict: 'failure',
      fallback: 'stop',
      credential: 'rejected',
      message: 'The sign-in of this account has expired',
      cause: 'The upstream refused the credential after a forced refresh',
    },
    {
      match: { kind: 'code', codes: ['chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'] },
      type: 'invalid_request',
      code: 'plan_grant_not_authorized',
      retryable: false,
      verdict: 'failure',
      fallback: 'stop',
      credential: 'keep',
      message: 'The plan did not authorize this sign-in for MomongaCode. Sign out of this account and sign in again',
      cause: 'Check the client and the grant',
    },
    {
      match: { kind: 'status', status: 401 },
      type: 'invalid_request',
      code: 'plan_credential_rejected',
      retryable: false,
      verdict: 'failure',
      fallback: 'stop',
      credential: 'rejected',
      message: 'The sign-in of this account has expired',
      cause: 'The upstream refused the credential after a forced refresh',
    },
    {
      match: { kind: 'status', status: 403 },
      type: 'invalid_request',
      code: 'plan_admission_denied',
      retryable: false,
      verdict: 'failure',
      fallback: 'stop',
      credential: 'keep',
      message: 'Admission was denied by a policy such as the serving region',
    },
    {
      match: { kind: 'status', status: 503 },
      type: 'server_error',
      code: 'plan_route_unavailable',
      retryable: true,
      verdict: 'failure',
      fallback: 'next',
      credential: 'keep',
      message: 'Try again later',
    },
  ],
  catalog: {
    path: '/models',
    listKey: 'models',
    filter: { field: 'visibility', equals: 'list' },
    unusableWhen: { field: 'supported_in_api', equals: false, reason: 'not available through the API' },
    idKey: 'slug',
    labelKey: 'display_name',
    reasoning: { effortsPath: ['supported_reasoning_levels'], defaultPath: ['default_reasoning_level'] },
  },
} as const satisfies Record<string, unknown>;

const GROK_PROFILE_DATA = {
  id: 'grok',
  adapter: 'open-responses',
  displayName: 'Grok',
  usageUrl: 'https://grok.com/?_s=usage',
  loginLabel: 'Continue with Grok',
  messages: {
    identityLabel: 'Grok',
    pickerLabel: 'xAI (Grok subscription)',
    apiKeyLabel: 'xAI (API key)',
    inviteTitle: 'Use your Grok plan in this app.',
    description: 'Complete eligible AI requests in this app with usage included in your Grok plan.',
    planInUseLabel: 'Using Grok plan',
    manageUsageLabel: 'Manage usage',
    usageLimitMessage: 'Usage limit reached — Review your plan or usage in Grok settings.',
    signInExpiredMessage: 'Grok sign-in expired',
    signInRequiredMessage: 'Not signed in to Grok',
    planNotEnabledMessage: "Grok plan use isn't enabled",
    notEligibleMessage: 'Grok plan usage is unavailable for the selected account or subscription tier.',
    firstSignIn: {
      title: "You're using your Grok plan",
      body: 'Eligible usage in this app uses your Grok plan. Manage usage in your Grok settings.',
      action: 'Got it',
    },
  },
  oauth: {
    issuer: 'https://auth.x.ai',
    discoveryUrl: 'https://auth.x.ai/.well-known/openid-configuration',
    authorizeUrl: 'https://auth.x.ai/oauth2/authorize',
    tokenUrl: 'https://auth.x.ai/oauth2/token',
    jwksUrl: 'https://auth.x.ai/.well-known/jwks.json',
    resource: 'https://api.x.ai/v1',
    sendResource: false,
    identityScopes: ['openid', 'profile', 'email'],
    useScopes: ['offline_access', 'grok-cli:access', 'api:access'],
    requiredScope: 'api:access',
    client: { kind: 'public', clientId: 'b1a00492-073a-47ea-816f-4c329264a828' },
    callbackPath: '/callback',
    callbackPort: 56121,
    idTokenAlgorithms: ['ES256'],
  },
  targetDefaults: {
    baseUrl: 'https://api.x.ai/v1',
    billing: 'plan',
    capabilities: {
      outputBoundField: 'max_output_tokens',
      systemRole: 'developer',
      toolPlacement: 'top_level',
      inputKinds: { content: [], tools: ['function'] },
    },
  },
  requestWire: { encoding: 'identity', sessionHeaders: [] },
  errorRules: [
    {
      match: { kind: 'status', status: 401 },
      type: 'invalid_request',
      code: 'plan_credential_rejected',
      retryable: false,
      verdict: 'failure',
      fallback: 'stop',
      credential: 'rejected',
      message: 'The sign-in of this account has expired',
      cause: 'The upstream refused the credential after a forced refresh',
    },
    {
      match: { kind: 'status', status: 403 },
      type: 'invalid_request',
      code: 'plan_not_eligible',
      retryable: false,
      verdict: 'failure',
      fallback: 'stop',
      credential: 'keep',
      message: 'This account cannot use its plan here. Sign in with another account, or use a model with an API key',
    },
    {
      match: { kind: 'status', status: 429 },
      type: 'too_many_requests',
      code: 'plan_usage_limit',
      retryable: false,
      verdict: 'neutral',
      fallback: 'stop',
      credential: 'pause',
      message: 'This account has reached the usage its plan allows for now. Wait for the usage to reset, or manage the usage in the Grok settings',
    },
    {
      match: { kind: 'status', status: 503 },
      type: 'server_error',
      code: 'plan_route_unavailable',
      retryable: true,
      verdict: 'failure',
      fallback: 'next',
      credential: 'keep',
      message: 'Try again later',
    },
  ],
  catalog: {
    path: '/models',
    listKey: 'data',
    filter: { field: 'object', equals: 'model' },
    unusableWhen: { field: 'completion_text_token_price', absent: true, reason: 'not a text generation model' },
    idKey: 'id',
    labelKey: 'id',
    reasoning: { effortsPath: ['capabilities', 'reasoning_effort'], defaultPath: ['capabilities', 'default_reasoning_effort'] },
  },
} as const satisfies Record<string, unknown>;

const SHIPPED_PROFILES: readonly PlanProfile[] = [
  assertPlanProfile(structuredClone(CHATGPT_PROFILE_DATA), 'shipped plan profile chatgpt'),
  assertPlanProfile(structuredClone(GROK_PROFILE_DATA), 'shipped plan profile grok'),
];

export const PLAN_PROFILES: Readonly<Record<string, PlanProfile>> = Object.fromEntries(SHIPPED_PROFILES.map((profile) => [profile.id, profile]));

export const planProfileOf = (id: string): PlanProfile => {
  const profile = Object.hasOwn(PLAN_PROFILES, id) ? PLAN_PROFILES[id] : undefined;
  if (profile === undefined) throw new Error(`unknown plan profile ${JSON.stringify(id)}; the shipped profiles are ${Object.keys(PLAN_PROFILES).map((known) => JSON.stringify(known)).join(', ')}`);
  return profile;
};
