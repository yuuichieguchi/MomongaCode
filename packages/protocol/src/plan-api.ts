import type { ErrorType } from './open-responses.ts';

export const USAGE_LIMIT_CODES = ['plan_usage_limit', 'plan_workspace_usage_limit', 'plan_usage_paused'] as const;
export type UsageLimitCode = (typeof USAGE_LIMIT_CODES)[number];

export const BREAKER_VERDICTS = ['failure', 'neutral'] as const;
export type BreakerVerdict = (typeof BREAKER_VERDICTS)[number];

export const ERROR_FALLBACKS = ['next', 'stop'] as const;
export type ErrorFallback = (typeof ERROR_FALLBACKS)[number];

export const CREDENTIAL_EFFECTS = ['keep', 'pause', 'rejected'] as const;
export type CredentialEffect = (typeof CREDENTIAL_EFFECTS)[number];

export type ErrorMatch = { kind: 'code'; codes: readonly string[] } | { kind: 'status'; status: number };

export type ErrorRule = {
  match: ErrorMatch;
  type: ErrorType;
  code: string;
  retryable: boolean;
  verdict: BreakerVerdict;
  fallback: ErrorFallback;
  credential: CredentialEffect;
  keepParam?: true;
  message: string;
};

export type ErrorRules = readonly ErrorRule[];

export type PlanProfileMessages = {
  identityLabel: string;
  pickerLabel: string;
  apiKeyLabel: string;
  inviteTitle: string;
  description: string;
  planInUseLabel: string;
  manageUsageLabel: string;
  usageLimitMessage: string;
  signInExpiredMessage: string;
  signInRequiredMessage: string;
  planNotEnabledMessage: string;
  notEligibleMessage: string;
  firstSignIn: { title: string; body: string; action: string };
};

export const PLAN_ACCOUNT_STATES = ['active', 'plan_disabled', 'needs_sign_in', 'signing_out', 'registered', 'store_unreadable', 'store_unwritable'] as const;
export type PlanAccountState = (typeof PLAN_ACCOUNT_STATES)[number];

export const SIGN_IN_REQUIRED_CODE = 'sign_in_required';

export const PLAN_API_PREFIX = '/v1/momonga/plan';

export const PLAN_ROUTES = {
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
} as const;

export type PlanAccountRef = { profile: string; account: string };

export type PlanAccountView = {
  profile: string;
  label: string;
  email?: string;
  state: PlanAccountState;
  active: boolean;
  pinnedBy: readonly string[];
  paused?: { until?: string };
  cause?: string;
};

export type PlanProfileView = { id: string; usageUrl: string; messages: PlanProfileMessages; loginLabel: string };

export type PlanAccountsResponse = { profiles: readonly PlanProfileView[]; accounts: readonly PlanAccountView[] };

export type PlanActiveRequest = PlanAccountRef;

export type PlanActiveResponse = { active: PlanAccountRef };

export type PlanSignInBeginRequest = PlanAccountRef & { port: number; reconsent?: boolean };

export type PlanSignInBeginResponse = { attemptId: string; authorizationUrl: string; state: string; expiresAt: string };

export type PlanSignInCompleteRequest = { attemptId: string; callbackUrl: string };

export type PlanSignInFailureRule = { status: number; type: ErrorType; template: string };

export const PLAN_SIGN_IN_FAILURE_RULES = {
  attempt_not_found: { status: 404, type: 'not_found', template: 'This sign-in attempt is no longer open.' },
  attempt_expired: { status: 400, type: 'invalid_request', template: 'This sign-in attempt expired before the browser returned.' },
  state_mismatch: { status: 400, type: 'invalid_request', template: 'The sign-in response did not belong to this attempt and was ignored.' },
  access_denied: { status: 400, type: 'invalid_request', template: 'Sign-in was cancelled in the browser.' },
  authorization_failed: { status: 400, type: 'invalid_request', template: '{identityLabel} refused the sign-in ({error}).' },
  registration_incomplete: { status: 400, type: 'invalid_request', template: '{identityLabel} did not return an app registration, so nothing was saved.' },
  client_mismatch: {
    status: 400,
    type: 'invalid_request',
    template: '{identityLabel} returned a different app registration than the one saved for this account. The saved account was left unchanged.',
  },
  registration_superseded: {
    status: 409,
    type: 'invalid_request',
    template: 'Another sign-in for this account finished first. An app registered during this attempt remains listed in {identityLabel} settings; you can remove it there.',
  },
  exchange_rejected: { status: 400, type: 'invalid_request', template: '{identityLabel} rejected the sign-in code ({error}).' },
  exchange_unavailable: { status: 502, type: 'server_error', template: '{identityLabel} could not be reached to finish the sign-in.' },
  token_response_invalid: { status: 502, type: 'server_error', template: '{identityLabel} returned a sign-in response this version cannot use ({reason}). Nothing was saved.' },
  id_token_invalid: { status: 400, type: 'invalid_request', template: 'The identity returned by {identityLabel} could not be verified ({check}). Nothing was saved.' },
  jwks_unavailable: { status: 502, type: 'server_error', template: 'The keys needed to verify the identity returned by {identityLabel} could not be fetched.' },
  identity_mismatch: { status: 400, type: 'invalid_request', template: 'The account that signed in is not the account saved under this label. Nothing was changed.' },
} as const satisfies Readonly<Record<string, PlanSignInFailureRule>>;

export type PlanSignInFailure = keyof typeof PLAN_SIGN_IN_FAILURE_RULES;

export const PLAN_SIGN_IN_FAILURES = Object.keys(PLAN_SIGN_IN_FAILURE_RULES) as readonly PlanSignInFailure[];

export const ID_TOKEN_CHECKS = ['algorithm', 'signature', 'issuer', 'audience', 'expired', 'nonce', 'subject'] as const;
export type IdTokenCheck = (typeof ID_TOKEN_CHECKS)[number];

export type PlanSignInCompleteResponse =
  | { outcome: 'signed_in' | 'plan_disabled'; account: PlanAccountView; firstSignIn: boolean }
  | { outcome: 'retry'; reason: 'invalid_grant' };

export type PlanSignInCancelRequest = { attemptId: string };

export type PlanSignInCancelResponse = { cancelled: boolean };

export type PlanSignOutRequest = PlanAccountRef;

export type PlanSignOutResponse = { revocation: 'confirmed' | 'unconfirmed'; usageUrl: string };

export type PlanResumeRequest = { profile: string };

export type PlanResumeResponse = { resumed: boolean };

export type PlanHostResetResponse = { hostId: string };

export type PlanModelsRequest = { profile: string; refresh?: boolean };

export type PlanCatalogEntry =
  | { slug: string; displayName: string; usable: true; contextWindow: number; maxOutputTokens: number }
  | { slug: string; displayName: string; usable: false; reason: string };

export type PlanModelsResponse = { readAt: string; models: readonly PlanCatalogEntry[] };

export type PlanTargetRequest = { profile: string; slug: string };

export type PlanTargetResponse = { target: string; alias: string };
