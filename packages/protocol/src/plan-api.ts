import type { ErrorType } from './open-responses.ts';

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
  planNotEnabledMessage: string;
  notEligibleMessage: string;
  firstSignIn: { title: string; body: string; action: string };
};

export const PLAN_ACCOUNT_STATES = ['active', 'plan_disabled', 'needs_sign_in', 'signing_out', 'registered', 'store_unreadable', 'store_unwritable'] as const;
export type PlanAccountState = (typeof PLAN_ACCOUNT_STATES)[number];

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

export const PLAN_SIGN_IN_FAILURES = ['attempt_not_found', 'access_denied', 'registration_incomplete', 'registration_superseded'] as const;
export type PlanSignInFailure = (typeof PLAN_SIGN_IN_FAILURES)[number];

export type PlanSignInCompleteResponse =
  | { outcome: 'signed_in' | 'plan_disabled'; account: PlanAccountView; firstSignIn: boolean }
  | { outcome: 'retry'; reason: 'invalid_grant' };

export type PlanSignInCancelRequest = { attemptId: string };

export type PlanSignOutRequest = PlanAccountRef;

export type PlanSignOutResponse = { revocation: 'confirmed' | 'unconfirmed'; usageUrl: string };

export type PlanResumeRequest = { profile: string };

export type PlanCatalogEntry =
  | { slug: string; displayName: string; usable: true; contextWindow: number; maxOutputTokens: number }
  | { slug: string; displayName: string; usable: false; reason: string };

export type PlanModelsResponse = { readAt: string; models: readonly PlanCatalogEntry[] };

export type PlanTargetRequest = { profile: string; slug: string };

export type PlanTargetResponse = { target: string; alias: string };
