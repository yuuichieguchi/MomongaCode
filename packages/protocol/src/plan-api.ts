import type { ErrorType } from './open-responses.ts';
import type { NamedPlanAccountRef } from './plan-account.ts';

export type { PlanAccountRef } from './plan-account.ts';

export const USAGE_LIMIT_CODE = 'plan_usage_limit' as const;
export const WORKSPACE_USAGE_LIMIT_CODE = 'plan_workspace_usage_limit' as const;
export const USAGE_PAUSED_CODE = 'plan_usage_paused' as const;
export const SIGN_IN_REQUIRED_CODE = 'sign_in_required' as const;
export const PLAN_CREDENTIAL_REJECTED_CODE = 'plan_credential_rejected' as const;
export const PLAN_USE_NOT_ENABLED_CODE = 'plan_use_not_enabled' as const;
export const PLAN_NOT_ELIGIBLE_CODE = 'plan_not_eligible' as const;
export const PLAN_STORE_UNREADABLE_CODE = 'plan_store_unreadable' as const;
export const PLAN_STORE_UNWRITABLE_CODE = 'plan_store_unwritable' as const;
export const PLAN_HOST_IDENTITY_UNAVAILABLE_CODE = 'plan_host_identity_unavailable' as const;
export const PLAN_CREDENTIAL_UNAVAILABLE_CODE = 'plan_credential_unavailable' as const;
export const PLAN_ACCOUNT_NOT_SELECTABLE_CODE = 'plan_account_not_selectable' as const;
export const PLAN_PROFILE_UNKNOWN_CODE = 'plan_profile_unknown' as const;
export const PLAN_ACCOUNT_NOT_FOUND_CODE = 'plan_account_not_found' as const;
export const PLAN_SIGN_IN_PENDING_CODE = 'plan_sign_in_pending' as const;
export const PLAN_SIGN_OUT_IN_PROGRESS_CODE = 'plan_sign_out_in_progress' as const;
export const CAPABILITIES_UNKNOWN_CODE = 'capabilities_unknown' as const;

export const USAGE_LIMIT_CODES = [USAGE_LIMIT_CODE, WORKSPACE_USAGE_LIMIT_CODE, USAGE_PAUSED_CODE] as const;

export const PLAN_CODES = [
  USAGE_LIMIT_CODE,
  WORKSPACE_USAGE_LIMIT_CODE,
  USAGE_PAUSED_CODE,
  SIGN_IN_REQUIRED_CODE,
  PLAN_USE_NOT_ENABLED_CODE,
  PLAN_NOT_ELIGIBLE_CODE,
  PLAN_STORE_UNREADABLE_CODE,
  PLAN_STORE_UNWRITABLE_CODE,
  PLAN_HOST_IDENTITY_UNAVAILABLE_CODE,
  PLAN_CREDENTIAL_UNAVAILABLE_CODE,
  PLAN_ACCOUNT_NOT_SELECTABLE_CODE,
  PLAN_SIGN_IN_PENDING_CODE,
  PLAN_SIGN_OUT_IN_PROGRESS_CODE,
  CAPABILITIES_UNKNOWN_CODE,
] as const;

export const PLAN_STORE_UNREADABLE_STATE = 'store_unreadable' as const;
export const PLAN_STORE_UNWRITABLE_STATE = 'store_unwritable' as const;
export const PLAN_STORE_STATES = [PLAN_STORE_UNREADABLE_STATE, PLAN_STORE_UNWRITABLE_STATE] as const;
export type PlanStoreState = (typeof PLAN_STORE_STATES)[number];

export const PLAN_HEALTH_REASONS = [SIGN_IN_REQUIRED_CODE, PLAN_USE_NOT_ENABLED_CODE, USAGE_PAUSED_CODE, ...PLAN_STORE_STATES] as const;
export type PlanHealthReason = (typeof PLAN_HEALTH_REASONS)[number];
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
  cause?: string;
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

export const PLAN_DISABLED_STATE = 'plan_disabled' as const;

export const PLAN_ACCOUNT_STATES = ['active', PLAN_DISABLED_STATE, 'needs_sign_in', 'signing_out', 'registered', ...PLAN_STORE_STATES] as const;
export type PlanAccountState = (typeof PLAN_ACCOUNT_STATES)[number];

export const PLAN_API_PREFIX = '/v1/momonga/plan';

export const PLAN_ROUTES = {
  signInBegin: '/sign-in/begin',
  signInComplete: '/sign-in/complete',
  signInCancel: '/sign-in/cancel',
  signOut: '/sign-out',
  accountRename: '/accounts/rename',
  accounts: '/accounts',
  accountsActive: '/accounts/active',
  accountResume: '/accounts/:account/resume',
  accountModels: '/accounts/:account/models',
  accountTargets: '/accounts/:account/targets',
  hostReset: '/host/reset',
} as const;

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

export type PlanExternalCliView = { command: string; loginCommand: string; installHint: string };

export type PlanProfileView = { id: string; usageUrl: string; messages: PlanProfileMessages; loginLabel: string; usesHostIdentity?: boolean; externalCli?: PlanExternalCliView };

export type PlanListProblem = { file: string; cause: string };

export type PlanAccountsResponse = { profiles: readonly PlanProfileView[]; accounts: readonly PlanAccountView[]; listProblems?: readonly PlanListProblem[] };

export type PlanActiveRequest = NamedPlanAccountRef;

export type PlanActiveResponse = { active: NamedPlanAccountRef };

export type PlanSignInBeginRequest = NamedPlanAccountRef & { port: number; reconsent?: boolean };

export type PlanSignInBeginResponse = { attemptId: string; authorizationUrl: string; state: string; expiresAt: string };

export type PlanSignInCompleteRequest = { attemptId: string; callbackUrl: string } | { attemptId: string; identityConfirmed: true };

export type PlanSignInFailureRule = { status: number; type: ErrorType; template: string };

export const PLAN_SIGN_IN_FAILURE = {
  attemptNotFound: 'attempt_not_found',
  attemptExpired: 'attempt_expired',
  stateMismatch: 'state_mismatch',
  accessDenied: 'access_denied',
  authorizationFailed: 'authorization_failed',
  registrationIncomplete: 'registration_incomplete',
  clientMismatch: 'client_mismatch',
  registrationSuperseded: 'registration_superseded',
  exchangeRejected: 'exchange_rejected',
  exchangeUnavailable: 'exchange_unavailable',
  tokenResponseInvalid: 'token_response_invalid',
  idTokenInvalid: 'id_token_invalid',
  jwksUnavailable: 'jwks_unavailable',
  identityMismatch: 'identity_mismatch',
  identityNotExchanged: 'identity_not_exchanged',
  identityLate: 'identity_late',
} as const;

export const PLAN_SIGN_IN_FAILURE_RULES = {
  [PLAN_SIGN_IN_FAILURE.attemptNotFound]: { status: 404, type: 'not_found', template: 'This sign-in attempt is no longer open.' },
  [PLAN_SIGN_IN_FAILURE.attemptExpired]: { status: 400, type: 'invalid_request', template: 'This sign-in attempt expired before the browser returned.' },
  [PLAN_SIGN_IN_FAILURE.stateMismatch]: { status: 400, type: 'invalid_request', template: 'The sign-in response did not belong to this attempt and was ignored.' },
  [PLAN_SIGN_IN_FAILURE.accessDenied]: { status: 400, type: 'invalid_request', template: 'Sign-in was cancelled in the browser.' },
  [PLAN_SIGN_IN_FAILURE.authorizationFailed]: { status: 400, type: 'invalid_request', template: '{identityLabel} refused the sign-in ({error}).' },
  [PLAN_SIGN_IN_FAILURE.registrationIncomplete]: { status: 400, type: 'invalid_request', template: '{identityLabel} did not return an app registration, so nothing was saved.' },
  [PLAN_SIGN_IN_FAILURE.clientMismatch]: {
    status: 400,
    type: 'invalid_request',
    template: '{identityLabel} returned a different app registration than the one saved for this account. The saved account was left unchanged.',
  },
  [PLAN_SIGN_IN_FAILURE.registrationSuperseded]: {
    status: 409,
    type: 'invalid_request',
    template: 'Another sign-in for this account finished first. An app registered during this attempt remains listed in {identityLabel} settings; you can remove it there.',
  },
  [PLAN_SIGN_IN_FAILURE.exchangeRejected]: { status: 400, type: 'invalid_request', template: '{identityLabel} rejected the sign-in code ({error}).' },
  [PLAN_SIGN_IN_FAILURE.exchangeUnavailable]: { status: 502, type: 'server_error', template: '{identityLabel} could not be reached to finish the sign-in.' },
  [PLAN_SIGN_IN_FAILURE.tokenResponseInvalid]: { status: 502, type: 'server_error', template: '{identityLabel} returned a sign-in response this version cannot use ({reason}). Nothing was saved.' },
  [PLAN_SIGN_IN_FAILURE.idTokenInvalid]: { status: 400, type: 'invalid_request', template: 'The identity returned by {identityLabel} could not be verified ({check}). Nothing was saved.' },
  [PLAN_SIGN_IN_FAILURE.jwksUnavailable]: { status: 502, type: 'server_error', template: 'The keys needed to verify the identity returned by {identityLabel} could not be fetched.' },
  [PLAN_SIGN_IN_FAILURE.identityMismatch]: { status: 400, type: 'invalid_request', template: 'The account that signed in is not the account saved under this label. Nothing was changed.' },
  [PLAN_SIGN_IN_FAILURE.identityNotExchanged]: { status: 409, type: 'invalid_request', template: 'This sign-in attempt has no account identity to confirm yet: the browser has not returned.' },
  [PLAN_SIGN_IN_FAILURE.identityLate]: { status: 409, type: 'invalid_request', template: 'The identity returned by {identityLabel} arrived after this sign-in attempt had ended. Nothing was saved.' },
} as const satisfies Readonly<Record<string, PlanSignInFailureRule>>;

export type PlanSignInFailure = keyof typeof PLAN_SIGN_IN_FAILURE_RULES;

export const PLAN_SIGN_IN_FAILURES = Object.keys(PLAN_SIGN_IN_FAILURE_RULES) as readonly PlanSignInFailure[];

export const ID_TOKEN_CHECKS = ['algorithm', 'signature', 'issuer', 'audience', 'expired', 'nonce', 'subject'] as const;
export type IdTokenCheck = (typeof ID_TOKEN_CHECKS)[number];

export const SIGNED_IN_OUTCOME = 'signed_in' as const;
export const RETRY_OUTCOME = 'retry' as const;
export const IDENTITY_UNCONFIRMED_OUTCOME = 'identity_unconfirmed' as const;
export const PLAN_SIGN_IN_OUTCOMES = [SIGNED_IN_OUTCOME, PLAN_DISABLED_STATE, RETRY_OUTCOME, IDENTITY_UNCONFIRMED_OUTCOME] as const;
export const INVALID_GRANT_REASON = 'invalid_grant' as const;

export type PlanSignInIdentity = { subject: string; email?: string };

export type PlanSignInIdentityUnconfirmed = { outcome: typeof IDENTITY_UNCONFIRMED_OUTCOME; attemptId: string; identity: PlanSignInIdentity; expiresAt: string };

export type PlanSignInCompleteResponse =
  | { outcome: typeof SIGNED_IN_OUTCOME | typeof PLAN_DISABLED_STATE; account: PlanAccountView; firstSignIn: boolean }
  | PlanSignInIdentityUnconfirmed
  | { outcome: typeof RETRY_OUTCOME; reason: typeof INVALID_GRANT_REASON };

export type PlanSignInCancelRequest = { attemptId: string };

export type PlanSignInCancelResponse = { cancelled: boolean };

export type PlanSignOutRequest = NamedPlanAccountRef;

export type PlanRenameRequest = NamedPlanAccountRef & { to: string };

export type PlanRenameResponse = { renamed: NamedPlanAccountRef };

export const PLAN_REVOCATION_CONFIRMED = 'confirmed' as const;
export const PLAN_REVOCATION_UNCONFIRMED = 'unconfirmed' as const;
export const PLAN_REVOCATION_NONE = 'none' as const;
export const PLAN_REVOCATION_ANSWERS = [PLAN_REVOCATION_CONFIRMED, PLAN_REVOCATION_UNCONFIRMED] as const;
export type PlanRevocationAnswer = (typeof PLAN_REVOCATION_ANSWERS)[number];
export const PLAN_REVOCATIONS = [...PLAN_REVOCATION_ANSWERS, PLAN_REVOCATION_NONE] as const;
export type PlanRevocation = (typeof PLAN_REVOCATIONS)[number];

export type PlanSignOutResponse = { revocation: PlanRevocation; usageUrl: string };

export type PlanResumeRequest = { profile: string };

export type PlanResumeResponse = { resumed: boolean };

export type PlanHostResetResponse = { hostId: string };

export type PlanModelsRequest = { profile: string; refresh?: boolean };

export type PlanCatalogEntry =
  | { slug: string; displayName: string; usable: true; contextWindow: number; maxOutputTokens: number }
  | { slug: string; displayName: string; usable: false; reason: string };

export type PlanModelsResponse = { readAt: string; models: readonly PlanCatalogEntry[] };

export type PlanTargetRequest = { profile: string; slug: string };

export type PlanTargetResponse = { model: string };
