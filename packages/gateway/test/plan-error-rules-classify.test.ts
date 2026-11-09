import { describe, expect, it } from 'vitest';
import { planProfileOf } from '@momonga/config';
import type { ClassifiedError, ErrorType } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { CHAT_COMPLETIONS_VOCABULARY } from '../src/adapters/chat-completions/vocabulary.ts';
import { createUpstreamClassifier } from '../src/adapters/shared/classify.ts';
import { StreamFailure } from '../src/adapters/shared/failures.ts';
import { httpErrorOf, nestedErrorDetail } from '../src/adapters/shared/http-error.ts';
import { START_MS } from './gateway-helpers.ts';

const RULES = planProfileOf('chatgpt').errorRules;
const classify = createUpstreamClassifier('plan route', RULES);

type Decision = { type: ErrorType; code: string; retryable: boolean; verdict: 'failure' | 'neutral'; fallback: 'next' | 'stop'; credential: 'keep' | 'pause' | 'rejected' };

type Row = { upstream: string | null; status: number; decision: Decision; param?: string };

const decision = (type: ErrorType, code: string, retryable: boolean, verdict: Decision['verdict'], fallback: Decision['fallback'], credential: Decision['credential']): Decision => ({
  type,
  code,
  retryable,
  verdict,
  fallback,
  credential,
});

const SECTION_7: readonly Row[] = [
  { upstream: 'subscription_sharing_usage_limit_exceeded', status: 429, decision: decision('too_many_requests', 'plan_usage_limit', false, 'neutral', 'stop', 'pause') },
  { upstream: 'subscription_sharing_workplace_individual_usage_limit_exceeded', status: 429, decision: decision('too_many_requests', 'plan_workspace_usage_limit', false, 'neutral', 'stop', 'pause') },
  { upstream: 'subscription_sharing_workplace_individual_usage_limit_exceeded', status: 400, decision: decision('too_many_requests', 'plan_workspace_usage_limit', false, 'neutral', 'stop', 'pause') },
  { upstream: 'subscription_sharing_usage_unavailable', status: 503, decision: decision('server_error', 'plan_usage_unavailable', true, 'failure', 'next', 'keep') },
  { upstream: 'subscription_sharing_user_unavailable', status: 503, decision: decision('server_error', 'plan_user_unavailable', true, 'failure', 'next', 'keep') },
  { upstream: 'subscription_sharing_user_not_eligible', status: 403, decision: decision('invalid_request', 'plan_not_eligible', false, 'failure', 'stop', 'keep') },
  { upstream: 'subscription_sharing_unsupported_capability', status: 400, param: 'temperature', decision: decision('invalid_request', 'plan_unsupported_capability', false, 'neutral', 'stop', 'keep') },
  { upstream: 'subscription_sharing_route_not_supported', status: 403, decision: decision('invalid_request', 'plan_route_not_supported', false, 'neutral', 'stop', 'keep') },
  { upstream: 'subscription_sharing_invalid_user', status: 401, decision: decision('invalid_request', 'plan_credential_rejected', false, 'failure', 'stop', 'rejected') },
  { upstream: 'chatpass_v2_scope_not_authorized', status: 403, decision: decision('invalid_request', 'plan_grant_not_authorized', false, 'failure', 'stop', 'keep') },
  { upstream: 'chatpass_v2_invalid_authorization_context', status: 403, decision: decision('invalid_request', 'plan_grant_not_authorized', false, 'failure', 'stop', 'keep') },
  { upstream: null, status: 401, decision: decision('invalid_request', 'plan_credential_rejected', false, 'failure', 'stop', 'rejected') },
  { upstream: null, status: 403, decision: decision('invalid_request', 'plan_admission_denied', false, 'failure', 'stop', 'keep') },
  { upstream: null, status: 503, decision: decision('server_error', 'plan_route_unavailable', true, 'failure', 'next', 'keep') },
];

const responseOf = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: (async function* chunks() {
    yield Buffer.from(JSON.stringify(body));
  })(),
});

const bodyOf = (row: { upstream: string | null; param?: string }): unknown =>
  row.upstream === null ? { detail: 'the request was not admitted' } : { error: { code: row.upstream, message: `the route answers ${row.upstream}`, param: row.param ?? null } };

const classifiedHttp = async (status: number, body: unknown, headers: Record<string, string> = {}): Promise<ClassifiedError> =>
  classify(await httpErrorOf(responseOf(status, body, headers), createFakeClock(START_MS), nestedErrorDetail, CHAT_COMPLETIONS_VOCABULARY));

const decisionOf = (classified: ClassifiedError): Record<string, unknown> => {
  const extended = classified as ClassifiedError & Record<string, unknown>;
  return {
    type: classified.error.type,
    code: classified.error.code,
    retryable: classified.retryable,
    verdict: extended['verdict'],
    fallback: extended['fallback'],
    credential: extended['credential'],
  };
};

describe('a profile classifies its upstream errors as data, one rule per row of section 7 (M4, I-E1)', () => {
  it.each(SECTION_7.map((row) => [`${row.upstream ?? '(no code)'} at ${row.status}`, row] as const))('classifies %s to its full decision', async (_name, row) => {
    const classified = await classifiedHttp(row.status, bodyOf(row));
    expect(decisionOf(classified)).toEqual(row.decision);
    if (row.param !== undefined) expect(classified.error.param).toBe(row.param);
  });

  it('gives an undocumented code on a documented status the status rule and keeps the original code in the message', async () => {
    const classified = await classifiedHttp(503, { error: { code: 'subscription_sharing_not_yet_documented', message: 'try later', param: null } });
    expect(decisionOf(classified)).toEqual(decision('server_error', 'plan_route_unavailable', true, 'failure', 'next', 'keep'));
    expect(classified.error.message).toContain('subscription_sharing_not_yet_documented');
  });

  it('leaves a code on an undocumented status to the generic path, with no rule decision attached', async () => {
    const ruled = await classifiedHttp(429, bodyOf(SECTION_7[0] as Row));
    expect(decisionOf(ruled)['credential']).toBe('pause');
    const classified = await classifiedHttp(418, { error: { code: 'teapot_refusal', message: 'short and stout', param: null } });
    expect(classified.error.code).toBe('teapot_refusal');
    expect(classified.error.type).toBe('invalid_request');
    expect(decisionOf(classified)).toMatchObject({ verdict: undefined, fallback: undefined, credential: undefined });
  });

  it('never makes a usage-limit class retryable and never clears a credential (I-E3, I-E4)', async () => {
    for (const row of SECTION_7) {
      const classified = decisionOf(await classifiedHttp(row.status, bodyOf(row)));
      expect(['keep', 'pause', 'rejected']).toContain(classified['credential']);
      if (classified['credential'] === 'pause') expect(classified['retryable']).toBe(false);
    }
  });
});

describe('the same upstream failure gets the same decision on both arrival paths (I-E2)', () => {
  const codeRows = SECTION_7.filter((row): row is Row & { upstream: string } => row.upstream !== null);

  it.each(codeRows.map((row) => [`${row.upstream} at ${row.status}`, row] as const))('decides %s in a response.failed event as it does in an HTTP body', async (_name, row) => {
    const http = decisionOf(await classifiedHttp(row.status, bodyOf(row)));
    const stream = decisionOf(classify(new StreamFailure(row.upstream, 'server_error', `the route answers ${row.upstream}`)));
    expect(stream).toEqual(http);
    expect(stream).toEqual(row.decision);
  });
});

describe('a classified plan error keeps the status, body shape, code and request id (P3, O21)', () => {
  it('records every response header whose name ends in request-id, the top-level body keys, the status and the upstream code', async () => {
    const classified = await classifiedHttp(429, bodyOf(SECTION_7[0] as Row), {
      'x-request-id': 'req_0001',
      'openai-request-id': 'req_0002',
      'x-request-id-hint': 'not-an-id',
      'retry-after': '30',
    });
    const upstream = (classified as ClassifiedError & { upstream?: unknown }).upstream;
    expect(upstream).toEqual({
      status: 429,
      bodyKeys: ['error'],
      code: 'subscription_sharing_usage_limit_exceeded',
      requestIds: { 'x-request-id': 'req_0001', 'openai-request-id': 'req_0002' },
    });
  });

  it('matches the header name case-insensitively and records a body without an error object by its own keys', async () => {
    const classified = await classifiedHttp(403, { detail: 'the request was not admitted' }, { 'X-Request-ID': 'req_0003' });
    const upstream = (classified as ClassifiedError & { upstream?: unknown }).upstream;
    expect(upstream).toEqual({ status: 403, bodyKeys: ['detail'], code: null, requestIds: { 'x-request-id': 'req_0003' } });
  });

  it('ends the user-visible message with the request id', async () => {
    const classified = await classifiedHttp(503, bodyOf({ upstream: 'subscription_sharing_usage_unavailable' }), { 'x-request-id': 'req_0004' });
    expect(classified.error.code).toBe('plan_usage_unavailable');
    expect(classified.error.message.endsWith('req_0004')).toBe(true);
  });
});
