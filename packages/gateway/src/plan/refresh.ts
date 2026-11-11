import { JsonDepthError, isRecord, parseOutsideJson, parseRetryAfter } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { readTextLimited } from '../adapters/shared/body-reading.ts';
import { nextWait } from '../core/retry.ts';
import type { WaitPolicy } from '../core/retry.ts';
import { PLAN_SESSION_DEFAULTS } from '../defaults.ts';
import { OAUTH_INVALID_GRANT } from './oauth-wire.ts';

export type PlanFetch = (url: string, init: RequestInit) => Promise<Response>;

export type PlanSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export type PlanTokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
  earliest_refresh_at?: string;
};

export const PLAN_TERMINAL_REFRESH_CODES = [OAUTH_INVALID_GRANT, 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'] as const;

export const PLAN_CONFIGURATION_REFRESH_CODES = ['invalid_client'] as const;

export type SendOutcome = { kind: 'answered'; status: number; headers: Headers; body: string; truncated: boolean } | { kind: 'unanswered' };

const EMPTY_BODY: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: async function* () {} };

export const responseBytes = (response: Response): AsyncIterable<Uint8Array> => response.body ?? EMPTY_BODY;

export const lazyRefreshMarginMs = (lifetimeMs: number): number => Math.min(PLAN_SESSION_DEFAULTS.marginMs, Math.max(PLAN_SESSION_DEFAULTS.skewMs, Math.floor(lifetimeMs / 2)));

export type BoundedSendPorts = { fetch: PlanFetch; sleep: PlanSleep };

export const boundedSend = async (ports: BoundedSendPorts, url: string, init: RequestInit, boundMs: number, maxBytes: number): Promise<SendOutcome> => {
  const fetchControl = new AbortController();
  const boundControl = new AbortController();
  const bound = ports.sleep(boundMs, boundControl.signal).then(
    (): 'elapsed' => 'elapsed',
    (error: unknown): 'cancelled' => {
      if (boundControl.signal.aborted) return 'cancelled';
      throw error;
    },
  );
  const sent = (async (): Promise<SendOutcome> => {
    const response = await ports.fetch(url, { ...init, redirect: 'manual', signal: fetchControl.signal });
    const read = await readTextLimited(responseBytes(response), maxBytes);
    return { kind: 'answered', status: response.status, headers: response.headers, body: read.text, truncated: read.truncated };
  })().catch((): SendOutcome => ({ kind: 'unanswered' }));
  const outcome = await Promise.race([sent, bound.then((): SendOutcome => ({ kind: 'unanswered' }))]);
  boundControl.abort();
  fetchControl.abort();
  await bound;
  return outcome;
};

const scopesOf = (scope: string): string[] => scope.split(' ').filter((entry) => entry !== '');

export const grantsScope = (scope: string, wanted: string): boolean => scopesOf(scope).includes(wanted);

export type RefreshTokens = Omit<PlanTokenResponse, 'refresh_token'> & { refresh_token?: string };

export type TokenResponseReading = { tokens: RefreshTokens } | { problem: string };

const nonEmptyText = (value: unknown): value is string => typeof value === 'string' && value !== '';

export const tokenResponseOf = (body: unknown, { refreshRequired }: { refreshRequired: boolean }): TokenResponseReading => {
  if (!isRecord(body)) return { problem: 'the token response is not a JSON object' };
  const { access_token: accessToken, token_type: tokenType, scope, expires_in: expiresIn, refresh_token: refreshToken, id_token: idToken, earliest_refresh_at: earliestRefreshAt } = body;
  if (!nonEmptyText(accessToken)) return { problem: 'the token response has no access token' };
  if (tokenType !== 'Bearer') return { problem: 'the token response is not a Bearer token' };
  if (typeof scope !== 'string') return { problem: 'the token response has no granted scope' };
  if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn <= 0) return { problem: 'the token response has no positive integer expires_in' };
  if (refreshRequired && !nonEmptyText(refreshToken)) return { problem: 'the token response has no refresh token' };
  if (refreshToken !== undefined && !nonEmptyText(refreshToken)) return { problem: 'the token response has a malformed refresh token' };
  if (idToken !== undefined && typeof idToken !== 'string') return { problem: 'the token response has a malformed ID token' };
  if (earliestRefreshAt !== undefined && typeof earliestRefreshAt !== 'string') return { problem: 'the token response has a malformed earliest_refresh_at' };
  return {
    tokens: {
      access_token: accessToken,
      token_type: tokenType,
      expires_in: expiresIn,
      scope,
      ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      ...(idToken === undefined ? {} : { id_token: idToken }),
      ...(earliestRefreshAt === undefined ? {} : { earliest_refresh_at: earliestRefreshAt }),
    },
  };
};

export const tokenResponseProblem = (body: unknown, requirement: { refreshRequired: boolean }): string | undefined => {
  const reading = tokenResponseOf(body, requirement);
  return 'problem' in reading ? reading.problem : undefined;
};

export const refreshRequiredFor = (scope: string): boolean => grantsScope(scope, 'offline_access');

export type RefreshAnswer =
  | { kind: 'adopted'; tokens: RefreshTokens }
  | { kind: 'terminal'; code: string }
  | { kind: 'configuration'; code: string }
  | { kind: 'transient'; resend: boolean; retryAfterMs?: number };

type ErrorClass = 'terminal' | 'configuration';

const REFRESH_ERROR_CLASSES: ReadonlyMap<string, ErrorClass> = new Map<string, ErrorClass>([
  ...PLAN_TERMINAL_REFRESH_CODES.map((code): [string, ErrorClass] => [code, 'terminal']),
  ...PLAN_CONFIGURATION_REFRESH_CODES.map((code): [string, ErrorClass] => [code, 'configuration']),
]);

const SUCCESS_STATUS = 200;

export const answeredForResend = (outcome: SendOutcome): boolean => outcome.kind === 'answered' && outcome.status === SUCCESS_STATUS;

const parsedBody = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof JsonDepthError) return undefined;
    throw error;
  }
};

export const classifyRefreshAnswer = (outcome: SendOutcome, nowMs: number): RefreshAnswer => {
  const resend = !answeredForResend(outcome);
  if (outcome.kind === 'unanswered') return { kind: 'transient', resend };
  const body = outcome.truncated ? undefined : parsedBody(outcome.body);
  if (outcome.status === SUCCESS_STATUS) {
    const reading = tokenResponseOf(body, { refreshRequired: false });
    return 'tokens' in reading ? { kind: 'adopted', tokens: reading.tokens } : { kind: 'transient', resend };
  }
  const code = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : undefined;
  const errorClass = code === undefined ? undefined : REFRESH_ERROR_CLASSES.get(code);
  if (code !== undefined && errorClass !== undefined) return { kind: errorClass, code };
  const retryAfterMs = parseRetryAfter(outcome.headers.get('retry-after'), nowMs);
  return { kind: 'transient', resend, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
};

export const sendWasInterrupted = ({ intentLoaded, unansweredBefore }: { intentLoaded: boolean; unansweredBefore: boolean }): boolean => intentLoaded || unansweredBefore;

export type RefreshEnd =
  | { kind: 'adopted'; tokens: RefreshTokens; unansweredBefore: boolean; attempts: number }
  | { kind: 'terminal'; code: string; unansweredBefore: boolean; attempts: number }
  | { kind: 'configuration'; code: string; attempts: number }
  | { kind: 'transient'; attempts: number };

export type RefreshRequest = {
  ports: BoundedSendPorts;
  clock: Clock;
  tokenUrl: string;
  form: Record<string, string>;
  attempts: number;
  attemptTimeoutMs: number;
  waitPolicy: WaitPolicy;
  maxBodyBytes: number;
  signal: AbortSignal;
};

export const sendRefresh = async (request: RefreshRequest): Promise<RefreshEnd> => {
  const startedAt = request.clock.now();
  let unansweredBefore = false;
  let attempts = 0;
  while (attempts < request.attempts) {
    if (request.signal.aborted) return { kind: 'transient', attempts };
    const outcome = await boundedSend(
      request.ports,
      request.tokenUrl,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(request.form).toString() },
      request.attemptTimeoutMs,
      request.maxBodyBytes,
    );
    attempts += 1;
    const answer = classifyRefreshAnswer(outcome, request.clock.now());
    if (answer.kind === 'terminal' || answer.kind === 'adopted') return { ...answer, unansweredBefore, attempts };
    if (answer.kind !== 'transient') return { ...answer, attempts };
    unansweredBefore ||= outcome.kind === 'unanswered';
    if (!answer.resend || attempts >= request.attempts) return { kind: 'transient', attempts };
    const decision = nextWait({
      attempt: attempts - 1,
      ...(answer.retryAfterMs === undefined ? {} : { retryAfterMs: answer.retryAfterMs }),
      elapsedMs: request.clock.now() - startedAt,
      policy: request.waitPolicy,
    });
    if (decision.kind === 'leave') return { kind: 'transient', attempts };
    try {
      await request.ports.sleep(decision.ms, request.signal);
    } catch (error) {
      if (request.signal.aborted) return { kind: 'transient', attempts };
      throw error;
    }
  }
  return { kind: 'transient', attempts };
};
