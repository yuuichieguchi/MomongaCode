import { describe, expect, it } from 'vitest';
import { STREAM_IDLE_HEADER } from '@momonga/protocol';
import { planAdmissionReply, planErrorHttpReply, planErrorStreamReply } from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { postJson, readSse, userInput } from './gateway-helpers.ts';
import { RESOLVED_ACCOUNT, fakeAuth, startPlan } from './plan-auth-support.ts';

const REQUEST_ID = 'req_1';
const DEFERRED_HEADER = 'momonga-deferred';

type Row = {
  name: string;
  reply: (headers: Record<string, string>) => FakeUpstreamReply;
  status: number;
  type: string;
  code: string;
  param: string | null;
  sentence: string;
};

const withHeaders = (reply: FakeUpstreamReply, headers: Record<string, string>): FakeUpstreamReply => (Object.keys(headers).length === 0 ? reply : ({ ...reply, headers } as FakeUpstreamReply));

const byCode = (code: string, options: { status?: number; param?: string } = {}) => (headers: Record<string, string>) =>
  planErrorHttpReply(code, { ...options, ...(Object.keys(headers).length === 0 ? {} : { headers }) });

const byStatus = (status: number) => (headers: Record<string, string>) => withHeaders(planAdmissionReply(status, 'denied by policy'), headers);

const CREDENTIAL_SENTENCE = 'The sign-in of this account has expired. Run momonga auth login to sign in again';

const ROWS: Row[] = [
  { name: '1 usage limit', reply: byCode('subscription_sharing_usage_limit_exceeded'), status: 429, type: 'too_many_requests', code: 'plan_usage_limit', param: null, sentence: 'This account has reached the usage its plan allows for now. Wait for the usage to reset, or manage the usage in the ChatGPT settings' },
  { name: '2 workspace usage limit', reply: byCode('subscription_sharing_workplace_individual_usage_limit_exceeded', { status: 400 }), status: 429, type: 'too_many_requests', code: 'plan_workspace_usage_limit', param: null, sentence: 'This account has reached the usage its workspace allows. Ask the workspace admin to allow more' },
  { name: '3 usage unavailable', reply: byCode('subscription_sharing_usage_unavailable'), status: 502, type: 'server_error', code: 'plan_usage_unavailable', param: null, sentence: 'Try again later' },
  { name: '4 user unavailable', reply: byCode('subscription_sharing_user_unavailable'), status: 502, type: 'server_error', code: 'plan_user_unavailable', param: null, sentence: 'Try again later' },
  { name: '5 not eligible', reply: byCode('subscription_sharing_user_not_eligible'), status: 400, type: 'invalid_request', code: 'plan_not_eligible', param: null, sentence: 'This account cannot use its plan here. Sign in with another account, or use a model with an API key' },
  { name: '6 unsupported capability', reply: byCode('subscription_sharing_unsupported_capability', { param: 'temperature' }), status: 400, type: 'invalid_request', code: 'plan_unsupported_capability', param: 'temperature', sentence: 'The plan does not accept a setting of this request' },
  { name: '7 route not supported', reply: byCode('subscription_sharing_route_not_supported'), status: 400, type: 'invalid_request', code: 'plan_route_not_supported', param: null, sentence: 'The plan does not accept this kind of request' },
  { name: '8 invalid user', reply: byCode('subscription_sharing_invalid_user'), status: 400, type: 'invalid_request', code: 'plan_credential_rejected', param: null, sentence: CREDENTIAL_SENTENCE },
  { name: '9 scope not authorized', reply: byCode('chatpass_v2_scope_not_authorized'), status: 400, type: 'invalid_request', code: 'plan_grant_not_authorized', param: null, sentence: 'The plan did not authorize this sign-in for MomongaCode. Sign out of this account and sign in again' },
  { name: '9 invalid authorization context', reply: byCode('chatpass_v2_invalid_authorization_context'), status: 400, type: 'invalid_request', code: 'plan_grant_not_authorized', param: null, sentence: 'The plan did not authorize this sign-in for MomongaCode. Sign out of this account and sign in again' },
  { name: '10 401 without a code', reply: byStatus(401), status: 400, type: 'invalid_request', code: 'plan_credential_rejected', param: null, sentence: CREDENTIAL_SENTENCE },
  { name: '11 403 without a code', reply: byStatus(403), status: 400, type: 'invalid_request', code: 'plan_admission_denied', param: null, sentence: 'Admission was denied by a policy such as the serving region' },
  { name: '12 503 without a code', reply: byStatus(503), status: 502, type: 'server_error', code: 'plan_route_unavailable', param: null, sentence: 'Try again later' },
];

const STATUS_ROWS = ROWS.filter((row) => row.name.startsWith('10 ') || row.name.startsWith('11 ') || row.name.startsWith('12 '));

const UPSTREAM_STATUS: Readonly<Record<string, number>> = { '10': 401, '11': 403, '12': 503 };

const unlistedCodeReply = (status: number): FakeUpstreamReply => ({
  kind: 'error',
  status,
  body: { error: { code: 'some_new_code', message: 'x', param: null } },
  headers: { 'x-request-id': REQUEST_ID },
});

const bodyOf = (row: Row, message: string) => ({ error: { message, type: row.type, param: row.param, code: row.code, plan: RESOLVED_ACCOUNT } });

const ask = async (reply: FakeUpstreamReply, retry?: { maxAttempts: number; totalWaitMs: number }) => {
  const plan = await startPlan(fakeAuth(), () => true, [reply], retry);
  return plan.post();
};

const STREAM_REQUEST = { model: 'scripted/plan-model', input: userInput('hi'), stream: true };

const streamFrames = async (reply: FakeUpstreamReply, headers: Record<string, string> = {}) => {
  const plan = await startPlan(fakeAuth(), () => true, [reply]);
  return readSse(await postJson(plan.client, '/v1/responses', STREAM_REQUEST, headers));
};

describe('the 12 plan error rows reach the client with their status, type, code, param, message and plan (P-E12)', () => {
  it.each(ROWS)('answers row $name with the client status, type, code, param and message A', async (row) => {
    const answer = await ask(row.reply({}));
    expect(answer.status).toBe(row.status);
    expect(answer.body).toEqual(bodyOf(row, `${row.sentence}.`));
    expect(answer.headers['retry-after']).toBeUndefined();
    expect(answer.headers[DEFERRED_HEADER]).toBeUndefined();
  });

  it.each(ROWS)('appends the request id to row $name: message B', async (row) => {
    const answer = await ask(row.reply({ 'x-request-id': REQUEST_ID }));
    expect(answer.status).toBe(row.status);
    expect(answer.body).toEqual(bodyOf(row, `${row.sentence}. Request id: ${REQUEST_ID}`));
    expect(answer.headers[DEFERRED_HEADER]).toBeUndefined();
  });

  it.each(STATUS_ROWS)('adds the upstream code for status row $name only: message C', async (row) => {
    const answer = await ask(unlistedCodeReply(UPSTREAM_STATUS[row.name.split(' ')[0] ?? ''] ?? 0));
    expect(answer.status).toBe(row.status);
    expect(answer.body).toEqual(bodyOf(row, `${row.sentence} (upstream code some_new_code). Request id: ${REQUEST_ID}`));
    expect(answer.headers[DEFERRED_HEADER]).toBeUndefined();
  });

  it('never adds the upstream code for a code row: row 5 with a request id is message B', async () => {
    const row = ROWS.find((candidate) => candidate.code === 'plan_not_eligible');
    if (row === undefined) throw new Error('row 5 is missing');
    const answer = await ask(row.reply({ 'x-request-id': REQUEST_ID }));
    expect(answer.body).toEqual(bodyOf(row, `${row.sentence}. Request id: ${REQUEST_ID}`));
    expect(answer.body.error.message).not.toContain('(upstream code');
  });

  it.each(ROWS)('answers row $name, sent with the stream-idle header, as a 200 stream whose first frame is an error event', async (row) => {
    const [first] = await streamFrames(row.reply({}), { [STREAM_IDLE_HEADER]: '60000' });
    expect(first?.data).toMatchObject({ type: 'error', status: row.status });
    expect(first?.data.error).toEqual(bodyOf(row, `${row.sentence}.`).error);
  });

  it('carries retry_after_ms 30000 in the error event of row 1 sent with Retry-After 30', async () => {
    const row = ROWS[0];
    if (row === undefined) throw new Error('row 1 is missing');
    const [first] = await streamFrames(row.reply({ 'retry-after': '30' }), { [STREAM_IDLE_HEADER]: '60000' });
    expect(first?.data).toMatchObject({ type: 'error', status: 429, retry_after_ms: 30000 });
    expect(first?.data.error).toEqual(bodyOf(row, `${row.sentence}.`).error);
  });

  it.each([
    { upstream: 'subscription_sharing_usage_limit_exceeded', code: 'plan_usage_limit', message: 'This account has reached the usage its plan allows for now. Wait for the usage to reset, or manage the usage in the ChatGPT settings.' },
    { upstream: 'subscription_sharing_workplace_individual_usage_limit_exceeded', code: 'plan_workspace_usage_limit', message: 'This account has reached the usage its workspace allows. Ask the workspace admin to allow more.' },
  ])('answers an upstream response.failed $upstream as a response.failed terminal that carries plan', async ({ upstream, code, message }) => {
    const frames = await streamFrames(planErrorStreamReply(upstream, {}));
    const last = frames.at(-1)?.data;
    expect(last?.type).toBe('response.failed');
    expect(last?.response.error).toEqual({ code, message, type: 'too_many_requests', plan: RESOLVED_ACCOUNT });
    expect('retryAfterMs' in last.response.error).toBe(false);
  });

  it.each([
    { name: '1 usage limit', retryAfter: '30', deferred: undefined },
    { name: '2 workspace usage limit', retryAfter: '30', deferred: undefined },
  ])('keeps Retry-After on row $name: retry-after $retryAfter, no deferral', async ({ name, retryAfter, deferred }) => {
    const row = ROWS.find((candidate) => candidate.name === name);
    if (row === undefined) throw new Error(`row ${name} is missing`);
    const answer = await ask(row.reply({ 'retry-after': retryAfter }));
    expect(answer.headers['retry-after']).toBe(retryAfter);
    expect(answer.headers[DEFERRED_HEADER]).toBe(deferred);
    expect(answer.body).toEqual(bodyOf(row, `${row.sentence}.`));
  });

  it('keeps Retry-After on a retryable row: row 3 with Retry-After 120 and totalWaitMs 1 answers retry-after 120 and momonga-deferred true', async () => {
    const row = ROWS.find((candidate) => candidate.code === 'plan_usage_unavailable');
    if (row === undefined) throw new Error('row 3 is missing');
    const answer = await ask(row.reply({ 'retry-after': '120' }), { maxAttempts: 1, totalWaitMs: 1 });
    expect(answer.headers['retry-after']).toBe('120');
    expect(answer.headers[DEFERRED_HEADER]).toBe('true');
  });

  it('keeps Retry-After on a non-retryable row: row 5 with Retry-After 7 answers retry-after 7', async () => {
    const row = ROWS.find((candidate) => candidate.code === 'plan_not_eligible');
    if (row === undefined) throw new Error('row 5 is missing');
    const answer = await ask(row.reply({ 'retry-after': '7' }));
    expect(answer.headers['retry-after']).toBe('7');
    expect(answer.headers[DEFERRED_HEADER]).toBeUndefined();
  });
});
