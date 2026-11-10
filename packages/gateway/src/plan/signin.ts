import { createHash, timingSafeEqual } from 'node:crypto';
import type { PlanProfile } from '@momonga/config';
import { CLIENT_NAME, SECRET_NAME_PATTERN, isRecord, parseOutsideJson, systemRandom } from '@momonga/foundation';
import type { Clock, FileSystem } from '@momonga/foundation';
import { PLAN_SIGN_IN_FAILURE_RULES } from '@momonga/protocol';
import type { PlanAccountRef, PlanSignInBeginRequest, PlanSignInBeginResponse, PlanSignInFailure } from '@momonga/protocol';
import { GatewayError, invalidRequest } from '../core/errors.ts';
import { PLAN_SIGN_IN_DEFAULTS } from '../defaults.ts';
import { hostIdentityFailure } from './auth-source.ts';
import { cappedSend } from './capped-send.ts';
import { ensureHostIdentity } from './host-identity.ts';
import { createIdTokenVerifier } from './id-token.ts';
import type { IdTokenVerifier } from './id-token.ts';
import { refreshRequiredFor, tokenResponseProblem } from './refresh.ts';
import type { BoundedSendPorts, PlanTokenResponse } from './refresh.ts';
import type { PlanSessions, Registration } from './session.ts';

export type SignInEnd = { outcome: 'signed_in' | 'plan_disabled'; ref: PlanAccountRef; firstSignIn: boolean } | { outcome: 'retry'; reason: 'invalid_grant' };

export type PlanSignIn = {
  begin(request: PlanSignInBeginRequest): Promise<PlanSignInBeginResponse>;
  complete(attemptId: string, callbackUrl: string): Promise<SignInEnd>;
  cancel(attemptId: string): boolean;
  waiting(): boolean;
};

export type PlanSignInOptions = {
  profiles: Readonly<Record<string, PlanProfile>>;
  sessions: PlanSessions;
  clock: Clock;
  ports: BoundedSendPorts;
  fileSystem: FileSystem;
  hostFile: string;
};

type Attempt = {
  id: string;
  key: string;
  profile: PlanProfile;
  account: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  hostId: string;
  saved: Registration | undefined;
};

type FailureValues = { error?: string; reason?: string; check?: string };

const LABEL = new RegExp(SECRET_NAME_PATTERN);

const MIN_PORT = 1;
const MAX_PORT = 65_535;

const CONFLICT_STATUS = 409;
const SUCCESS_STATUS = 200;
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR_FLOOR = 500;
const INVALID_GRANT = 'invalid_grant';
const ACCESS_DENIED = 'access_denied';
const UNSPECIFIED = 'unspecified';
const OVERSIZE_REASON = `the token response is larger than ${PLAN_SIGN_IN_DEFAULTS.authBodyBytes} bytes`;
const NO_ID_TOKEN_REASON = 'the token response has no ID token';

export const signInFailure = (code: PlanSignInFailure, profile: PlanProfile | undefined, values: FailureValues = {}): GatewayError => {
  const rule = PLAN_SIGN_IN_FAILURE_RULES[code];
  const filled: Readonly<Record<string, string>> = { ...(profile === undefined ? {} : { identityLabel: profile.messages.identityLabel }), ...values };
  const message = rule.template.replace(/\{(\w+)\}/g, (whole, name: string) => filled[name] ?? whole);
  return new GatewayError({ status: rule.status, type: rule.type, code, message });
};

export const shownOAuthError = (raw: string | undefined): string => {
  const kept = (raw ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, PLAN_SIGN_IN_DEFAULTS.errorTextChars);
  return kept === '' ? UNSPECIFIED : kept;
};

const randomToken = (bytes: number): string => Buffer.from(systemRandom.bytes(bytes)).toString('base64url');

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

const sameText = (left: string, right: string): boolean => timingSafeEqual(digest(left), digest(right));

const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

const attemptKey = (profile: string, account: string): string => `${profile}/${account}`;

const parsedJson = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch {
    return undefined;
  }
};

const callbackQuery = (callbackUrl: string): URLSearchParams | undefined => {
  try {
    return new URL(callbackUrl).searchParams;
  } catch {
    return undefined;
  }
};

export const createPlanSignIn = (options: PlanSignInOptions): PlanSignIn => {
  const attempts = new Map<string, Attempt>();
  const pendingByAccount = new Map<string, string>();
  const verifiers = new Map<string, IdTokenVerifier>();

  const profileOf = (id: string): PlanProfile => {
    const profile = Object.hasOwn(options.profiles, id) ? options.profiles[id] : undefined;
    if (profile === undefined) throw invalidRequest('plan_profile_unknown', `no plan profile is named ${JSON.stringify(id)}`, 'profile');
    return profile;
  };

  const verifierOf = (profile: PlanProfile): IdTokenVerifier => {
    const existing = verifiers.get(profile.id);
    if (existing !== undefined) return existing;
    const created = createIdTokenVerifier({ jwksUrl: profile.oauth.jwksUrl, ports: options.ports, clock: options.clock });
    verifiers.set(profile.id, created);
    return created;
  };

  const consume = (attemptId: string): Attempt | undefined => {
    const attempt = attempts.get(attemptId);
    if (attempt === undefined) return undefined;
    attempts.delete(attemptId);
    if (pendingByAccount.get(attempt.key) === attemptId) pendingByAccount.delete(attempt.key);
    return attempt;
  };

  let completing = 0;

  const waiting = (): boolean => completing > 0 || [...attempts.values()].some((attempt) => options.clock.now() < attempt.expiresAt);

  const begin = async (request: PlanSignInBeginRequest): Promise<PlanSignInBeginResponse> => {
    const profile = profileOf(request.profile);
    if (!LABEL.test(request.account)) throw invalidRequest('invalid_account_label', `the account label must match ${SECRET_NAME_PATTERN}`, 'account');
    if (!Number.isInteger(request.port) || request.port < MIN_PORT || request.port > MAX_PORT) throw invalidRequest('invalid_port', `the port must be an integer from ${MIN_PORT} to ${MAX_PORT}`, 'port');
    const saved = await options.sessions.registration({ profile: profile.id, account: request.account });
    if (saved?.state === 'signing_out') throw invalidRequest('plan_sign_out_in_progress', `${request.account} is still signing out. Try again in a moment.`, null, CONFLICT_STATUS);
    const accountsExist = saved !== undefined || (await options.sessions.known()).length > 0;
    const { hostId } = await ensureHostIdentity(options.fileSystem, options.hostFile, { accountsExist }).catch((error: unknown) => {
      throw hostIdentityFailure(error);
    });
    const key = attemptKey(profile.id, request.account);
    const replaced = pendingByAccount.get(key);
    if (replaced !== undefined) attempts.delete(replaced);
    const oauth = profile.oauth;
    const attempt: Attempt = {
      id: randomToken(PLAN_SIGN_IN_DEFAULTS.randomStateBytes),
      key,
      profile,
      account: request.account,
      state: randomToken(PLAN_SIGN_IN_DEFAULTS.randomStateBytes),
      nonce: randomToken(PLAN_SIGN_IN_DEFAULTS.randomStateBytes),
      verifier: randomToken(PLAN_SIGN_IN_DEFAULTS.verifierBytes),
      redirectUri: `http://127.0.0.1:${request.port}${oauth.callbackPath}`,
      expiresAt: options.clock.now() + PLAN_SIGN_IN_DEFAULTS.attemptTtlMs,
      hostId,
      saved,
    };
    attempts.set(attempt.id, attempt);
    pendingByAccount.set(key, attempt.id);
    const url = new URL(oauth.authorizeUrl);
    const params: Array<[string, string]> = [
      ['client_id', saved?.clientId ?? oauth.registrationClientId],
      ...(saved === undefined ? [[oauth.registrationParameters.agentNameHint, CLIENT_NAME] as [string, string]] : []),
      [oauth.registrationParameters.hostId, hostId],
      ['response_type', 'code'],
      ['redirect_uri', attempt.redirectUri],
      ['scope', [...oauth.identityScopes, ...oauth.useScopes].join(' ')],
      ['resource', oauth.resource],
      ['state', attempt.state],
      ['nonce', attempt.nonce],
      ['code_challenge_method', 'S256'],
      ['code_challenge', challengeOf(attempt.verifier)],
      ...(saved?.idToken === undefined ? [] : [['id_token_hint', saved.idToken] as [string, string]]),
      ...(saved?.email === undefined ? [] : [['login_hint', saved.email] as [string, string]]),
      ...(request.reconsent === true ? [['prompt', 'consent'] as [string, string]] : []),
    ];
    for (const [name, value] of params) url.searchParams.set(name, value);
    return { attemptId: attempt.id, authorizationUrl: url.toString(), state: attempt.state, expiresAt: new Date(attempt.expiresAt).toISOString() };
  };

  const exchange = async (attempt: Attempt, clientId: string, code: string): Promise<PlanTokenResponse | { outcome: 'retry'; reason: 'invalid_grant' }> => {
    const { profile } = attempt;
    const form = { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: profile.oauth.resource };
    const answer = await cappedSend(
      options.ports,
      profile.oauth.tokenUrl,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString() },
      PLAN_SIGN_IN_DEFAULTS.exchangeTimeoutMs,
      PLAN_SIGN_IN_DEFAULTS.authBodyBytes,
    );
    if (answer.kind === 'unanswered' || answer.status === TOO_MANY_REQUESTS || answer.status >= SERVER_ERROR_FLOOR) throw signInFailure('exchange_unavailable', profile);
    if (answer.truncated) throw signInFailure('token_response_invalid', profile, { reason: OVERSIZE_REASON });
    const body = parsedJson(answer.body);
    if (answer.status !== SUCCESS_STATUS) {
      const error = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : undefined;
      if (error === INVALID_GRANT) return { outcome: 'retry', reason: INVALID_GRANT };
      throw signInFailure('exchange_rejected', profile, { error: error === undefined ? `http_${answer.status}` : shownOAuthError(error) });
    }
    const scope = isRecord(body) ? body['scope'] : undefined;
    const problem = tokenResponseProblem(body, { refreshRequired: typeof scope === 'string' && refreshRequiredFor(scope) });
    if (problem !== undefined) throw signInFailure('token_response_invalid', profile, { reason: problem });
    return body as PlanTokenResponse;
  };

  const complete = async (attemptId: string, callbackUrl: string): Promise<SignInEnd> => {
    completing += 1;
    try {
      return await completeAttempt(attemptId, callbackUrl);
    } finally {
      completing -= 1;
    }
  };

  const completeAttempt = async (attemptId: string, callbackUrl: string): Promise<SignInEnd> => {
    const attempt = consume(attemptId);
    if (attempt === undefined) throw signInFailure('attempt_not_found', undefined);
    const { profile } = attempt;
    if (options.clock.now() >= attempt.expiresAt) throw signInFailure('attempt_expired', profile);
    const query = callbackQuery(callbackUrl);
    const state = query?.get('state');
    if (query === undefined || state === null || state === undefined || !sameText(state, attempt.state)) throw signInFailure('state_mismatch', profile);
    const error = query.get('error');
    if (error === ACCESS_DENIED) throw signInFailure('access_denied', profile);
    const code = query.get('code');
    if (error !== null || code === null) throw signInFailure('authorization_failed', profile, { error: shownOAuthError(error ?? undefined) });
    const returned = query.get('client_id');
    if (attempt.saved === undefined && returned === null) throw signInFailure('registration_incomplete', profile);
    if (attempt.saved !== undefined && returned !== null && returned !== attempt.saved.clientId) throw signInFailure('client_mismatch', profile);
    const clientId = attempt.saved?.clientId ?? returned ?? '';
    const ref = { profile: profile.id, account: attempt.account };
    const registered = await options.sessions.register({ ...ref, clientId, hostId: attempt.hostId });
    if (registered.outcome === 'rejected') throw signInFailure('registration_superseded', profile);
    const tokens = await exchange(attempt, clientId, code);
    if ('outcome' in tokens) return tokens;
    const idToken = tokens.id_token;
    if (idToken === undefined) throw signInFailure('token_response_invalid', profile, { reason: NO_ID_TOKEN_REASON });
    const verdict = await verifierOf(profile)(idToken, { issuer: profile.oauth.issuer, clientId, nonce: attempt.nonce, algorithms: profile.oauth.idTokenAlgorithms });
    if (verdict.kind === 'keys_unavailable') throw signInFailure('jwks_unavailable', profile);
    if (verdict.kind === 'invalid') throw signInFailure('id_token_invalid', profile, { check: verdict.check });
    if (attempt.saved?.subject !== undefined && attempt.saved.subject !== verdict.subject) throw signInFailure('identity_mismatch', profile);
    const installed = await options.sessions.install({
      ...ref,
      clientId,
      hostId: attempt.hostId,
      subject: verdict.subject,
      ...(verdict.email === undefined ? {} : { email: verdict.email }),
      idToken,
      tokens,
    });
    if (installed.outcome === 'rejected') throw signInFailure('registration_superseded', profile);
    return { outcome: installed.outcome, ref, firstSignIn: installed.firstSignIn };
  };

  const cancel = (attemptId: string): boolean => consume(attemptId) !== undefined;

  return { begin, complete, cancel, waiting };
};
