import { isRecord, parseRetryAfter } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { nextWait } from '../core/retry.ts';
import type { WaitPolicy } from '../core/retry.ts';

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

export const PLAN_TERMINAL_REFRESH_CODES = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'] as const;

export const PLAN_CONFIGURATION_REFRESH_CODES = ['invalid_client'] as const;

export const PLAN_REFRESH_INTERRUPTED_CAUSE = 'refresh_interrupted';

export type SendOutcome = { kind: 'answered'; status: number; headers: Headers; body: string } | { kind: 'unanswered' };

export type BoundedSendPorts = { fetch: PlanFetch; sleep: PlanSleep };

export const boundedSend = async (ports: BoundedSendPorts, url: string, init: RequestInit, boundMs: number): Promise<SendOutcome> => {
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
    return { kind: 'answered', status: response.status, headers: response.headers, body: await response.text() };
  })().catch((): SendOutcome => ({ kind: 'unanswered' }));
  const outcome = await Promise.race([sent, bound.then((): SendOutcome => ({ kind: 'unanswered' }))]);
  boundControl.abort();
  fetchControl.abort();
  await bound;
  return outcome;
};

const scopesOf = (scope: string): string[] => scope.split(' ').filter((entry) => entry !== '');

export const grantsScope = (scope: string, wanted: string): boolean => scopesOf(scope).includes(wanted);

export const tokenResponseProblem = (body: unknown, { marginMs, refreshRequired }: { marginMs: number; refreshRequired: boolean }): string | undefined => {
  if (!isRecord(body)) return 'the token response is not a JSON object';
  if (typeof body['access_token'] !== 'string' || body['access_token'] === '') return 'the token response has no access token';
  if (body['token_type'] !== 'Bearer') return 'the token response is not a Bearer token';
  if (typeof body['scope'] !== 'string') return 'the token response has no granted scope';
  const expiresIn = body['expires_in'];
  if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn * 1000 <= marginMs) return 'the token response has no expires_in longer than the refresh margin';
  if (refreshRequired && (typeof body['refresh_token'] !== 'string' || body['refresh_token'] === '')) return 'the token response has no refresh token';
  if (body['id_token'] !== undefined && typeof body['id_token'] !== 'string') return 'the token response has a malformed ID token';
  if (body['earliest_refresh_at'] !== undefined && typeof body['earliest_refresh_at'] !== 'string') return 'the token response has a malformed earliest_refresh_at';
  return undefined;
};

export const refreshRequiredFor = (scope: string): boolean => grantsScope(scope, 'offline_access');

export type RefreshAnswer =
  | { kind: 'adopted'; tokens: PlanTokenResponse }
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
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export const classifyRefreshAnswer = (outcome: SendOutcome, { marginMs, nowMs }: { marginMs: number; nowMs: number }): RefreshAnswer => {
  const resend = !answeredForResend(outcome);
  if (outcome.kind === 'unanswered') return { kind: 'transient', resend };
  const body = parsedBody(outcome.body);
  if (outcome.status === SUCCESS_STATUS) {
    return tokenResponseProblem(body, { marginMs, refreshRequired: true }) === undefined ? { kind: 'adopted', tokens: body as PlanTokenResponse } : { kind: 'transient', resend };
  }
  const code = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : undefined;
  const errorClass = code === undefined ? undefined : REFRESH_ERROR_CLASSES.get(code);
  if (code !== undefined && errorClass !== undefined) return { kind: errorClass, code };
  const retryAfterMs = parseRetryAfter(outcome.headers.get('retry-after'), nowMs);
  return { kind: 'transient', resend, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
};

export const terminalCause = ({ code, interrupted }: { code: string; interrupted: boolean }): string => (interrupted ? PLAN_REFRESH_INTERRUPTED_CAUSE : code);

export type RefreshEnd = { kind: 'adopted'; tokens: PlanTokenResponse } | { kind: 'terminal'; code: string } | { kind: 'configuration'; code: string } | { kind: 'transient' };

export type RefreshRequest = {
  ports: BoundedSendPorts;
  clock: Clock;
  tokenUrl: string;
  form: Record<string, string>;
  attempts: number;
  attemptTimeoutMs: number;
  marginMs: number;
  waitPolicy: WaitPolicy;
};

export const sendRefresh = async (request: RefreshRequest): Promise<RefreshEnd> => {
  const startedAt = request.clock.now();
  for (let attempt = 0; attempt < request.attempts; attempt += 1) {
    const outcome = await boundedSend(
      request.ports,
      request.tokenUrl,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(request.form).toString() },
      request.attemptTimeoutMs,
    );
    const answer = classifyRefreshAnswer(outcome, { marginMs: request.marginMs, nowMs: request.clock.now() });
    if (answer.kind !== 'transient') return answer;
    if (!answer.resend || attempt + 1 >= request.attempts) return { kind: 'transient' };
    const decision = nextWait({
      attempt,
      ...(answer.retryAfterMs === undefined ? {} : { retryAfterMs: answer.retryAfterMs }),
      elapsedMs: request.clock.now() - startedAt,
      policy: request.waitPolicy,
    });
    if (decision.kind === 'leave') return { kind: 'transient' };
    await request.ports.sleep(decision.ms);
  }
  return { kind: 'transient' };
};
