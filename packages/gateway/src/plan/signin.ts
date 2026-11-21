import { createHash, timingSafeEqual } from 'node:crypto';
import type { PlanProfile } from '@momonga/config';
import { CLIENT_NAME, isRecord, parseOutsideJson, systemRandom } from '@momonga/foundation';
import type { Clock, FileSystem, KernelLockMechanism } from '@momonga/foundation';
import { PLAN_REVOCATION_UNCONFIRMED, PLAN_SIGN_IN_FAILURES, PLAN_SIGN_IN_FAILURE_RULES, PLAN_SIGN_IN_PENDING_CODE, PLAN_SIGN_OUT_IN_PROGRESS_CODE, PLAN_DISABLED_STATE, PLAN_SIGN_IN_FAILURE, PLAN_SIGN_IN_OUTCOMES, RETRY_OUTCOME, SIGNED_IN_OUTCOME, IDENTITY_UNCONFIRMED_OUTCOME, INVALID_GRANT_REASON } from '@momonga/protocol';
import type { NamedPlanAccountRef, PlanRevocationAnswer, PlanSignInBeginRequest, PlanSignInBeginResponse, PlanSignInFailure, PlanSignInIdentityUnconfirmed } from '@momonga/protocol';
import { GatewayError, invalidRequest } from '../core/errors.ts';
import { GATEWAY_CONFIG_DEFAULTS, PLAN_SESSION_DEFAULTS, PLAN_SIGN_IN_DEFAULTS } from '../defaults.ts';
import type { WaitPolicy } from '../core/retry.ts';
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
import { revokeRefreshToken } from './revoke.ts';
import type { PlanFetch, PlanSleep, RefreshTokens } from './refresh.ts';
import { createSerial } from './serial.ts';
import { OAUTH_ACCESS_DENIED, OAUTH_INVALID_GRANT } from './oauth-wire.ts';
import { planProfileNamed, requireOAuth } from './profiles.ts';
import type { PlanSessions, Registration } from './session.ts';

export type SignInSaved = { outcome: typeof SIGNED_IN_OUTCOME | typeof PLAN_DISABLED_STATE; ref: NamedPlanAccountRef; firstSignIn: boolean };

export type SignInEnd = SignInSaved | PlanSignInIdentityUnconfirmed | { outcome: typeof RETRY_OUTCOME; reason: typeof INVALID_GRANT_REASON };

export type PlanSignIn = {
  begin(request: PlanSignInBeginRequest, signal: AbortSignal): Promise<PlanSignInBeginResponse>;
  complete(attemptId: string, callbackUrl: string, signal: AbortSignal): Promise<SignInEnd>;
  confirm(attemptId: string, signal: AbortSignal): Promise<SignInSaved>;
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
  lock: KernelLockMechanism;
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
  exchanged?: Exchanged;
};

type Exchanged = { clientId: string; subject: string; email?: string; idToken: string; tokens: RefreshTokens; progress: Progress };

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
const STEP_CONFIRMATION = 9;
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
    const created = createIdTokenVerifier({ jwksUrl: requireOAuth(profile).jwksUrl, outbound: options.outbound, lifetime: options.lifetime, sleep: options.sleep, clock: options.clock });
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

  const revokeDropped = (attempt: Attempt): void => {
    const exchanged = attempt.exchanged;
    const refreshToken = exchanged?.tokens.refresh_token;
    if (exchanged === undefined || refreshToken === undefined) return;
    const retry = GATEWAY_CONFIG_DEFAULTS.retry;
    const waitPolicy: WaitPolicy = { totalWaitMs: retry.totalWaitMs, baseMs: retry.baseMs, maxMs: retry.maxMs, random: systemRandom.float };
    const report = (revocation: PlanRevocationAnswer, code?: string): void =>
      events('plan.sign_in_revoke', { profile: attempt.profile.id, account: attempt.account, revocation, ...(code === undefined ? {} : { code }) });
    options
      .outbound(options.lifetime, (fetch) =>
        revokeRefreshToken({
          ports: { fetch, sleep: options.sleep },
          clock: options.clock,
          profile: attempt.profile,
          clientId: exchanged.clientId,
          refreshToken,
          attempts: retry.maxAttempts,
          attemptTimeoutMs: PLAN_SESSION_DEFAULTS.revocationTimeoutMs,
          waitPolicy,
          maxBodyBytes: PLAN_SIGN_IN_DEFAULTS.authBodyBytes,
          signal: options.lifetime,
        }),
      )
      .then(
        (revocation) => report(revocation),
        (error: unknown) => report(PLAN_REVOCATION_UNCONFIRMED, endCodeOf(error)),
      );
  };

  const discard = (attempt: Attempt): void => {
    consume(attempt.id);
    revokeDropped(attempt);
  };

  const removeExpired = (): void => {
    const now = options.clock.now();
    for (const attempt of [...attempts.values()]) if (now >= attempt.expiresAt) discard(attempt);
  };

  let completing = 0;

  const waiting = (): boolean => {
    removeExpired();
    return completing > 0 || attempts.size > 0;
  };

  const beginAttempt = async (profile: PlanProfile, request: PlanSignInBeginRequest, signal: AbortSignal): Promise<Attempt> => {
    await options.sessions.pointerReady();
    const saved = await options.sessions.registrationToReplace({ profile: profile.id, account: request.account }, signal);
    if (saved?.state === 'signing_out') throw invalidRequest(PLAN_SIGN_OUT_IN_PROGRESS_CODE, `${request.account} is still signing out. Try again in a moment.`, null, CONFLICT_STATUS);
    const accountsExist = saved !== undefined || (await options.sessions.known(signal)).length > 0;
    const { hostId } = await ensureHostIdentity(options.fileSystem, options.hostFile, { accountsExist, lock: options.lock }).catch((error: unknown) => {
      throw hostIdentityFailure(error);
    });
    removeExpired();
    const key = attemptKey(profile.id, request.account);
    const replaced = pendingByAccount.get(key);
    const dropped = replaced === undefined ? undefined : attempts.get(replaced);
    if (dropped !== undefined) discard(dropped);
    const attempt: Attempt = {
      id: randomToken(PLAN_SIGN_IN_DEFAULTS.randomStateBytes),
      key,
      profile,
      account: request.account,
      state: randomToken(PLAN_SIGN_IN_DEFAULTS.randomStateBytes),
      nonce: randomToken(PLAN_SIGN_IN_DEFAULTS.randomStateBytes),
      verifier: randomToken(PLAN_SIGN_IN_DEFAULTS.verifierBytes),
      redirectUri: `http://127.0.0.1:${request.port}${requireOAuth(profile).callbackPath}`,
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
      return resetHostIdentity(options.fileSystem, options.hostFile, options.lock).catch((error: unknown) => {
        throw hostIdentityFailure(error);
      });
    });

  const begin = async (request: PlanSignInBeginRequest, signal: AbortSignal): Promise<PlanSignInBeginResponse> => {
    const profile = profileOf(request.profile);
    if (!Number.isInteger(request.port) || request.port < MIN_PORT || request.port > MAX_PORT) throw invalidRequest('invalid_port', `the port must be an integer from ${MIN_PORT} to ${MAX_PORT}`, 'port');
    const attempt = await hostGate.run(() => beginAttempt(profile, request, signal));
    const { saved, hostId } = attempt;
    const oauth = requireOAuth(profile);
    const url = new URL(oauth.authorizeUrl);
    const clientParams: Array<[string, string]> =
      oauth.client.kind === 'dynamic_registration'
        ? [
            ['client_id', saved?.clientId ?? oauth.client.registrationClientId],
            ...(saved === undefined ? [[oauth.client.registrationParameters.agentNameHint, CLIENT_NAME] as [string, string]] : []),
            [oauth.client.registrationParameters.hostId, hostId],
          ]
        : [['client_id', saved?.clientId ?? oauth.client.clientId]];
    const params: Array<[string, string]> = [
      ...clientParams,
      ['response_type', 'code'],
      ['redirect_uri', attempt.redirectUri],
      ['scope', [...oauth.identityScopes, ...oauth.useScopes].join(' ')],
      ...(oauth.sendResource ? [['resource', oauth.resource] as [string, string]] : []),
      ['state', attempt.state],
      ['nonce', attempt.nonce],
      ['code_challenge_method', 'S256'],
      ['code_challenge', challengeOf(attempt.verifier)],
      ...(request.reconsent === true ? [['prompt', 'consent'] as [string, string]] : []),
    ];
    for (const [name, value] of params) url.searchParams.set(name, value);
    return { attemptId: attempt.id, authorizationUrl: url.toString(), state: attempt.state, expiresAt: new Date(attempt.expiresAt).toISOString() };
  };

  const exchange = async (fetch: PlanFetch, attempt: Attempt, clientId: string, code: string, progress: Progress): Promise<RefreshTokens | { outcome: typeof RETRY_OUTCOME; reason: typeof INVALID_GRANT_REASON }> => {
    const { profile } = attempt;
    const oauth = requireOAuth(profile);
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      ...(oauth.sendResource ? { resource: oauth.resource } : {}),
    };
    const answer = await boundedSend(
      { fetch, sleep: options.sleep },
      oauth.tokenUrl,
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

  const unconfirmed = (attempt: Attempt, exchanged: Exchanged): PlanSignInIdentityUnconfirmed => ({
    outcome: IDENTITY_UNCONFIRMED_OUTCOME,
    attemptId: attempt.id,
    identity: { subject: exchanged.subject, ...(exchanged.email === undefined ? {} : { email: exchanged.email }) },
    expiresAt: new Date(attempt.expiresAt).toISOString(),
  });

  const awaitConfirmation = (attempt: Attempt, exchanged: Exchanged): PlanSignInIdentityUnconfirmed => {
    const waitingAttempt: Attempt = { ...attempt, expiresAt: options.clock.now() + PLAN_SIGN_IN_DEFAULTS.attemptTtlMs, exchanged };
    attempts.set(waitingAttempt.id, waitingAttempt);
    if (!pendingByAccount.has(waitingAttempt.key)) pendingByAccount.set(waitingAttempt.key, waitingAttempt.id);
    return unconfirmed(waitingAttempt, exchanged);
  };

  const install = async (attempt: Attempt, exchanged: Exchanged, signal: AbortSignal): Promise<SignInSaved> => {
    const ref = { profile: attempt.profile.id, account: attempt.account };
    exchanged.progress.endStep = STEP_INSTALL;
    const installed = await options.sessions.install(
      {
        ...ref,
        clientId: exchanged.clientId,
        hostId: attempt.hostId,
        subject: exchanged.subject,
        ...(exchanged.email === undefined ? {} : { email: exchanged.email }),
        idToken: exchanged.idToken,
        tokens: exchanged.tokens,
      },
      signal,
    );
    if (installed.outcome === 'rejected') throw signInFailure(PLAN_SIGN_IN_FAILURE.registrationSuperseded, attempt.profile);
    return { outcome: installed.outcome, ref, firstSignIn: installed.firstSignIn };
  };

  const confirm = async (attemptId: string, signal: AbortSignal): Promise<SignInSaved> => {
    await options.sessions.pointerReady();
    const waitingAttempt = attempts.get(attemptId);
    if (waitingAttempt === undefined) throw signInFailure(PLAN_SIGN_IN_FAILURE.attemptNotFound, undefined);
    const { exchanged } = waitingAttempt;
    if (options.clock.now() >= waitingAttempt.expiresAt) {
      discard(waitingAttempt);
      throw signInFailure(exchanged === undefined ? PLAN_SIGN_IN_FAILURE.attemptExpired : PLAN_SIGN_IN_FAILURE.identityLate, waitingAttempt.profile);
    }
    if (exchanged === undefined) throw signInFailure(PLAN_SIGN_IN_FAILURE.identityNotExchanged, waitingAttempt.profile);
    consume(attemptId);
    removeExpired();
    completing += 1;
    try {
      const end = await install(waitingAttempt, exchanged, signal);
      signInEvent(waitingAttempt, exchanged.progress, { outcome: end.outcome });
      return end;
    } catch (error) {
      signInEvent(waitingAttempt, exchanged.progress, { outcome: 'failed', failure: failureCodeOf(error) ?? endCodeOf(error) });
      throw error;
    } finally {
      completing -= 1;
    }
  };

  const completeAttempt = async (fetch: PlanFetch, attemptId: string, callbackUrl: string, signal: AbortSignal): Promise<SignInEnd> => {
    const exchangedBefore = attempts.get(attemptId);
    if (exchangedBefore?.exchanged !== undefined && options.clock.now() < exchangedBefore.expiresAt) return unconfirmed(exchangedBefore, exchangedBefore.exchanged);
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
    const oauth = requireOAuth(profile);
    let clientId: string;
    if (oauth.client.kind === 'dynamic_registration') {
      if (attempt.saved === undefined && returned === null) throw signInFailure(PLAN_SIGN_IN_FAILURE.registrationIncomplete, profile);
      if (attempt.saved !== undefined && returned !== null && returned !== attempt.saved.clientId) throw signInFailure(PLAN_SIGN_IN_FAILURE.clientMismatch, profile);
      clientId = attempt.saved?.clientId ?? returned ?? '';
    } else {
      const expectedClientId = attempt.saved?.clientId ?? oauth.client.clientId;
      if (returned !== null && returned !== expectedClientId) throw signInFailure(PLAN_SIGN_IN_FAILURE.clientMismatch, profile);
      clientId = expectedClientId;
    }
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
    const verdict = await verifierOf(profile)(idToken, { issuer: oauth.issuer, clientId, nonce: attempt.nonce, algorithms: oauth.idTokenAlgorithms });
    if (verdict.kind === 'keys_unavailable') throw signInFailure(PLAN_SIGN_IN_FAILURE.jwksUnavailable, profile);
    if (verdict.kind === 'invalid') throw signInFailure(PLAN_SIGN_IN_FAILURE.idTokenInvalid, profile, { check: verdict.check });
    progress.endStep = STEP_IDENTITY;
    if (attempt.saved?.subject !== undefined && attempt.saved.subject !== verdict.subject) throw signInFailure(PLAN_SIGN_IN_FAILURE.identityMismatch, profile);
    const exchanged: Exchanged = { clientId, subject: verdict.subject, ...(verdict.email === undefined ? {} : { email: verdict.email }), idToken, tokens, progress };
    if (attempt.saved?.subject === undefined) {
      progress.endStep = STEP_CONFIRMATION;
      return awaitConfirmation(attempt, exchanged);
    }
    return install(attempt, exchanged, signal);
  };

  const cancel = (attemptId: string): boolean => {
    const attempt = attempts.get(attemptId);
    if (attempt === undefined) return false;
    discard(attempt);
    return true;
  };

  return { begin, complete, confirm, cancel, waiting, resetHost };
};
