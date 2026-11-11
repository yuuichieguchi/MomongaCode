import { createHash, timingSafeEqual } from 'node:crypto';
import type { PlanProfile } from '@momonga/config';
import { CLIENT_NAME, isRecord, parseOutsideJson, systemRandom } from '@momonga/foundation';
import type { Clock, FileSystem } from '@momonga/foundation';
import { PLAN_SIGN_IN_FAILURES, PLAN_SIGN_IN_FAILURE_RULES, PLAN_SIGN_IN_PENDING_CODE, PLAN_SIGN_OUT_IN_PROGRESS_CODE, PLAN_DISABLED_STATE, PLAN_SIGN_IN_FAILURE, PLAN_SIGN_IN_OUTCOMES, RETRY_OUTCOME, SIGNED_IN_OUTCOME, INVALID_GRANT_REASON } from '@momonga/protocol';
import type { NamedPlanAccountRef, PlanSignInBeginRequest, PlanSignInBeginResponse, PlanSignInFailure } from '@momonga/protocol';
import { GatewayError, invalidRequest } from '../core/errors.ts';
import { PLAN_SIGN_IN_DEFAULTS } from '../defaults.ts';
import { hostIdentityFailure } from './auth-source.ts';
import { endCodeOf, eventScalar, noPlanEvents } from './events.ts';
import type { PlanEvents } from './events.ts';
import { ensureHostIdentity, resetHostIdentity } from './host-identity.ts';
import { CONFLICT_STATUS, SUCCESS_STATUS, answeredLater } from './http-status.ts';
import type { HostIdentity } from './host-identity.ts';
import { createIdTokenVerifier, idTokenFacts } from './id-token.ts';
import type { IdTokenFacts, IdTokenVerifier } from './id-token.ts';
import type { PlanOutbound } from './outbound.ts';
import { boundedSend, refreshRequiredFor, tokenResponseOf } from './refresh.ts';
import type { PlanFetch, PlanSleep, RefreshTokens } from './refresh.ts';
import { createSerial } from './serial.ts';
import { OAUTH_ACCESS_DENIED, OAUTH_INVALID_GRANT } from './oauth-wire.ts';
import { planProfileNamed } from './profiles.ts';
import type { PlanSessions, Registration } from './session.ts';

export type SignInEnd = { outcome: typeof SIGNED_IN_OUTCOME | typeof PLAN_DISABLED_STATE; ref: NamedPlanAccountRef; firstSignIn: boolean } | { outcome: typeof RETRY_OUTCOME; reason: typeof INVALID_GRANT_REASON };

export type PlanSignIn = {
  begin(request: PlanSignInBeginRequest, signal: AbortSignal): Promise<PlanSignInBeginResponse>;
  complete(attemptId: string, callbackUrl: string, signal: AbortSignal): Promise<SignInEnd>;
  cancel(attemptId: string): boolean;
  waiting(): boolean;
  resetHost(): Promise<HostIdentity>;
};

export type PlanSignInOptions = {
  profiles: Readonly<Record<string, PlanProfile>>;
  sessions: PlanSessions;
  clock: Clock;
  outbound: PlanOutbound;
  lifetime: AbortSignal;
  sleep: PlanSleep;
  fileSystem: FileSystem;
  hostFile: string;
  events?: PlanEvents;
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
  port: number;
  startedAt: number;
  expiresAt: number;
  hostId: string;
  saved: Registration | undefined;
};

type FailureValues = { error?: string; reason?: string; check?: string };

type Progress = { endStep: number; facts: IdTokenFacts; scope?: string; earliestRefreshAt?: string };

const STEP_ATTEMPT = 1;
const STEP_CALLBACK = 2;
const STEP_REGISTRATION = 3;
const STEP_REGISTER = 4;
const STEP_EXCHANGE = 5;
const STEP_TOKEN_RESPONSE = 6;
const STEP_ID_TOKEN = 7;
const STEP_IDENTITY = 8;
const STEP_INSTALL = 10;

const SIGN_IN_FAILURE_CODES: ReadonlySet<string> = new Set(PLAN_SIGN_IN_FAILURES);

const failureCodeOf = (error: unknown): string | undefined => {
  const code = error instanceof GatewayError ? error.body.code : null;
  return code !== null && SIGN_IN_FAILURE_CODES.has(code) ? code : undefined;
};

const MIN_PORT = 1;
const MAX_PORT = 65_535;

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
  const events = options.events ?? noPlanEvents;
  const hostGate = createSerial();

  const profileOf = (id: string): PlanProfile => planProfileNamed(options.profiles, id);

  const verifierOf = (profile: PlanProfile): IdTokenVerifier => {
    const existing = verifiers.get(profile.id);
    if (existing !== undefined) return existing;
    const created = createIdTokenVerifier({ jwksUrl: profile.oauth.jwksUrl, outbound: options.outbound, lifetime: options.lifetime, sleep: options.sleep, clock: options.clock });
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

  const removeExpired = (): void => {
    const now = options.clock.now();
    for (const attempt of [...attempts.values()]) if (now >= attempt.expiresAt) consume(attempt.id);
  };

  let completing = 0;

  const waiting = (): boolean => {
    removeExpired();
    return completing > 0 || attempts.size > 0;
  };

  const beginAttempt = async (profile: PlanProfile, request: PlanSignInBeginRequest, signal: AbortSignal): Promise<Attempt> => {
    await options.sessions.pointerReady();
    const saved = await options.sessions.registration({ profile: profile.id, account: request.account }, signal);
    if (saved?.state === 'signing_out') throw invalidRequest(PLAN_SIGN_OUT_IN_PROGRESS_CODE, `${request.account} is still signing out. Try again in a moment.`, null, CONFLICT_STATUS);
    const accountsExist = saved !== undefined || (await options.sessions.known(signal)).length > 0;
    const { hostId } = await ensureHostIdentity(options.fileSystem, options.hostFile, { accountsExist }).catch((error: unknown) => {
      throw hostIdentityFailure(error);
    });
    removeExpired();
    const key = attemptKey(profile.id, request.account);
    const replaced = pendingByAccount.get(key);
    if (replaced !== undefined) attempts.delete(replaced);
    const attempt: Attempt = {
      id: randomToken(PLAN_SIGN_IN_DEFAULTS.randomStateBytes),
      key,
      profile,
      account: request.account,
      state: randomToken(PLAN_SIGN_IN_DEFAULTS.randomStateBytes),
      nonce: randomToken(PLAN_SIGN_IN_DEFAULTS.randomStateBytes),
      verifier: randomToken(PLAN_SIGN_IN_DEFAULTS.verifierBytes),
      redirectUri: `http://127.0.0.1:${request.port}${profile.oauth.callbackPath}`,
      port: request.port,
      startedAt: options.clock.now(),
      expiresAt: options.clock.now() + PLAN_SIGN_IN_DEFAULTS.attemptTtlMs,
      hostId,
      saved,
    };
    attempts.set(attempt.id, attempt);
    pendingByAccount.set(key, attempt.id);
    return attempt;
  };

  const resetHost = (): Promise<HostIdentity> =>
    hostGate.run(async () => {
      if (waiting()) throw invalidRequest(PLAN_SIGN_IN_PENDING_CODE, 'A sign-in is waiting for the browser. Finish or cancel it, then reset the host.', null, CONFLICT_STATUS);
      return resetHostIdentity(options.fileSystem, options.hostFile).catch((error: unknown) => {
        throw hostIdentityFailure(error);
      });
    });

  const begin = async (request: PlanSignInBeginRequest, signal: AbortSignal): Promise<PlanSignInBeginResponse> => {
    const profile = profileOf(request.profile);
    if (!Number.isInteger(request.port) || request.port < MIN_PORT || request.port > MAX_PORT) throw invalidRequest('invalid_port', `the port must be an integer from ${MIN_PORT} to ${MAX_PORT}`, 'port');
    const attempt = await hostGate.run(() => beginAttempt(profile, request, signal));
    const { saved, hostId } = attempt;
    const oauth = profile.oauth;
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

  const exchange = async (fetch: PlanFetch, attempt: Attempt, clientId: string, code: string, progress: Progress): Promise<RefreshTokens | { outcome: typeof RETRY_OUTCOME; reason: typeof INVALID_GRANT_REASON }> => {
    const { profile } = attempt;
    const form = { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: profile.oauth.resource };
    const answer = await boundedSend(
      { fetch, sleep: options.sleep },
      profile.oauth.tokenUrl,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString() },
      PLAN_SIGN_IN_DEFAULTS.exchangeTimeoutMs,
      PLAN_SIGN_IN_DEFAULTS.authBodyBytes,
    );
    if (answer.kind === 'unanswered' || answeredLater(answer.status)) throw signInFailure(PLAN_SIGN_IN_FAILURE.exchangeUnavailable, profile);
    if (answer.truncated) {
      progress.endStep = STEP_TOKEN_RESPONSE;
      throw signInFailure(PLAN_SIGN_IN_FAILURE.tokenResponseInvalid, profile, { reason: OVERSIZE_REASON });
    }
    const body = parsedJson(answer.body);
    if (answer.status !== SUCCESS_STATUS) {
      const error = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : undefined;
      if (error === OAUTH_INVALID_GRANT) return { outcome: RETRY_OUTCOME, reason: INVALID_GRANT_REASON };
      throw signInFailure(PLAN_SIGN_IN_FAILURE.exchangeRejected, profile, { error: error === undefined ? `http_${answer.status}` : shownOAuthError(error) });
    }
    progress.endStep = STEP_TOKEN_RESPONSE;
    const scope = isRecord(body) ? body['scope'] : undefined;
    const reading = tokenResponseOf(body, { refreshRequired: typeof scope === 'string' && refreshRequiredFor(scope) });
    if ('problem' in reading) throw signInFailure(PLAN_SIGN_IN_FAILURE.tokenResponseInvalid, profile, { reason: reading.problem });
    return reading.tokens;
  };

  const signInEvent = (attempt: Attempt, progress: Progress, end: { outcome: (typeof PLAN_SIGN_IN_OUTCOMES)[number] } | { outcome: 'failed'; failure: string }): void => {
    const { facts } = progress;
    events('plan.sign_in', {
      profile: attempt.profile.id,
      account: attempt.account,
      ...end,
      endStep: progress.endStep,
      durationMs: options.clock.now() - attempt.startedAt,
      port: attempt.port,
      ...(facts.alg === undefined ? {} : { alg: eventScalar(facts.alg) }),
      ...(facts.kid === undefined ? {} : { kid: eventScalar(facts.kid) }),
      ...(facts.audShape === undefined ? {} : { audShape: facts.audShape }),
      ...(facts.claimNames === undefined ? {} : { claimNames: facts.claimNames.map(eventScalar) }),
      ...(progress.scope === undefined ? {} : { scope: eventScalar(progress.scope) }),
      ...(progress.earliestRefreshAt === undefined ? {} : { earliestRefreshAt: eventScalar(progress.earliestRefreshAt) }),
    });
  };

  const complete = async (attemptId: string, callbackUrl: string, signal: AbortSignal): Promise<SignInEnd> => {
    await options.sessions.pointerReady();
    return options.outbound(signal, async (fetch) => {
      completing += 1;
      try {
        return await completeAttempt(fetch, attemptId, callbackUrl, signal);
      } finally {
        completing -= 1;
      }
    });
  };

  const completeAttempt = async (fetch: PlanFetch, attemptId: string, callbackUrl: string, signal: AbortSignal): Promise<SignInEnd> => {
    const attempt = consume(attemptId);
    removeExpired();
    if (attempt === undefined) throw signInFailure(PLAN_SIGN_IN_FAILURE.attemptNotFound, undefined);
    const progress: Progress = { endStep: STEP_ATTEMPT, facts: {} };
    try {
      const end = await finishAttempt(fetch, attempt, callbackUrl, progress, signal);
      signInEvent(attempt, progress, { outcome: end.outcome });
      return end;
    } catch (error) {
      signInEvent(attempt, progress, { outcome: 'failed', failure: failureCodeOf(error) ?? endCodeOf(error) });
      throw error;
    }
  };

  const finishAttempt = async (fetch: PlanFetch, attempt: Attempt, callbackUrl: string, progress: Progress, signal: AbortSignal): Promise<SignInEnd> => {
    const { profile } = attempt;
    if (options.clock.now() >= attempt.expiresAt) throw signInFailure(PLAN_SIGN_IN_FAILURE.attemptExpired, profile);
    progress.endStep = STEP_CALLBACK;
    const query = callbackQuery(callbackUrl);
    const state = query?.get('state');
    if (query === undefined || state === null || state === undefined || !sameText(state, attempt.state)) throw signInFailure(PLAN_SIGN_IN_FAILURE.stateMismatch, profile);
    const error = query.get('error');
    if (error === OAUTH_ACCESS_DENIED) throw signInFailure(PLAN_SIGN_IN_FAILURE.accessDenied, profile);
    const code = query.get('code');
    if (error !== null || code === null) throw signInFailure(PLAN_SIGN_IN_FAILURE.authorizationFailed, profile, { error: shownOAuthError(error ?? undefined) });
    progress.endStep = STEP_REGISTRATION;
    const returned = query.get('client_id');
    if (attempt.saved === undefined && returned === null) throw signInFailure(PLAN_SIGN_IN_FAILURE.registrationIncomplete, profile);
    if (attempt.saved !== undefined && returned !== null && returned !== attempt.saved.clientId) throw signInFailure(PLAN_SIGN_IN_FAILURE.clientMismatch, profile);
    const clientId = attempt.saved?.clientId ?? returned ?? '';
    const ref = { profile: profile.id, account: attempt.account };
    progress.endStep = STEP_REGISTER;
    const registered = await options.sessions.register({ ...ref, clientId, hostId: attempt.hostId }, signal);
    if (registered.outcome === 'rejected') throw signInFailure(PLAN_SIGN_IN_FAILURE.registrationSuperseded, profile);
    progress.endStep = STEP_EXCHANGE;
    const tokens = await exchange(fetch, attempt, clientId, code, progress);
    if ('outcome' in tokens) return tokens;
    progress.scope = tokens.scope;
    if (tokens.earliest_refresh_at !== undefined) progress.earliestRefreshAt = tokens.earliest_refresh_at;
    const idToken = tokens.id_token;
    if (idToken === undefined) throw signInFailure(PLAN_SIGN_IN_FAILURE.tokenResponseInvalid, profile, { reason: NO_ID_TOKEN_REASON });
    progress.facts = idTokenFacts(idToken);
    progress.endStep = STEP_ID_TOKEN;
    const verdict = await verifierOf(profile)(idToken, { issuer: profile.oauth.issuer, clientId, nonce: attempt.nonce, algorithms: profile.oauth.idTokenAlgorithms });
    if (verdict.kind === 'keys_unavailable') throw signInFailure(PLAN_SIGN_IN_FAILURE.jwksUnavailable, profile);
    if (verdict.kind === 'invalid') throw signInFailure(PLAN_SIGN_IN_FAILURE.idTokenInvalid, profile, { check: verdict.check });
    progress.endStep = STEP_IDENTITY;
    if (attempt.saved?.subject !== undefined && attempt.saved.subject !== verdict.subject) throw signInFailure(PLAN_SIGN_IN_FAILURE.identityMismatch, profile);
    progress.endStep = STEP_INSTALL;
    const installed = await options.sessions.install(
      {
        ...ref,
        clientId,
        hostId: attempt.hostId,
        subject: verdict.subject,
        ...(verdict.email === undefined ? {} : { email: verdict.email }),
        idToken,
        tokens,
      },
      signal,
    );
    if (installed.outcome === 'rejected') throw signInFailure(PLAN_SIGN_IN_FAILURE.registrationSuperseded, profile);
    return { outcome: installed.outcome, ref, firstSignIn: installed.firstSignIn };
  };

  const cancel = (attemptId: string): boolean => consume(attemptId) !== undefined;

  return { begin, complete, cancel, waiting, resetHost };
};
