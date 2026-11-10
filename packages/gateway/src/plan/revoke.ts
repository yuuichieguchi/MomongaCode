import { JsonDepthError, isRecord, isRetryableHttp, parseOutsideJson, parseRetryAfter } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type { PlanProfile } from '@momonga/config';
import { nextWait } from '../core/retry.ts';
import type { WaitPolicy } from '../core/retry.ts';
import { boundedSend } from './refresh.ts';
import type { BoundedSendPorts, SendOutcome } from './refresh.ts';

export type RevocationAnswer = 'confirmed' | 'unconfirmed';

export type RevokeRequest = {
  ports: BoundedSendPorts;
  clock: Clock;
  profile: PlanProfile;
  clientId: string;
  refreshToken: string;
  attempts: number;
  attemptTimeoutMs: number;
  waitPolicy: WaitPolicy;
  maxBodyBytes: number;
  signal: AbortSignal;
};

const parsed = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof JsonDepthError) return undefined;
    throw error;
  }
};

const revocationEndpointOf = (profile: PlanProfile, outcome: SendOutcome): string | undefined => {
  if (outcome.kind !== 'answered' || outcome.status !== 200 || outcome.truncated) return undefined;
  const document = parsed(outcome.body);
  if (!isRecord(document) || document['issuer'] !== profile.oauth.issuer) return undefined;
  const endpoint = document['revocation_endpoint'];
  if (typeof endpoint !== 'string' || !URL.canParse(endpoint)) return undefined;
  return new URL(endpoint).origin === new URL(profile.oauth.issuer).origin ? endpoint : undefined;
};

const isEmptySuccess = (outcome: SendOutcome): boolean => outcome.kind === 'answered' && outcome.status === 200 && !outcome.truncated && outcome.body === '';

const mayResend = (outcome: SendOutcome): boolean => outcome.kind === 'unanswered' || isRetryableHttp(outcome.status, undefined);

export const revokeRefreshToken = async (request: RevokeRequest): Promise<RevocationAnswer> => {
  request.signal.throwIfAborted();
  const discovery = await boundedSend(request.ports, request.profile.oauth.discoveryUrl, { method: 'GET', headers: { accept: 'application/json' } }, request.attemptTimeoutMs, request.maxBodyBytes);
  const endpoint = revocationEndpointOf(request.profile, discovery);
  if (endpoint === undefined) return 'unconfirmed';
  const body = new URLSearchParams({ token: request.refreshToken, token_type_hint: 'refresh_token', client_id: request.clientId }).toString();
  const startedAt = request.clock.now();
  for (let attempt = 0; attempt < request.attempts; attempt += 1) {
    request.signal.throwIfAborted();
    const outcome = await boundedSend(request.ports, endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, request.attemptTimeoutMs, request.maxBodyBytes);
    if (isEmptySuccess(outcome)) return 'confirmed';
    if (!mayResend(outcome) || attempt + 1 >= request.attempts) return 'unconfirmed';
    const retryAfterMs = outcome.kind === 'answered' ? parseRetryAfter(outcome.headers.get('retry-after'), request.clock.now()) : undefined;
    const decision = nextWait({ attempt, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), elapsedMs: request.clock.now() - startedAt, policy: request.waitPolicy });
    if (decision.kind === 'leave') return 'unconfirmed';
    await request.ports.sleep(decision.ms, request.signal);
  }
  return 'unconfirmed';
};
