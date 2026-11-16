import { describe, expect, it } from 'vitest';
import { PROMPT_BODY_MAX_BYTES } from '@momonga/protocol';
import { DEFAULT_LIMITS, DEFAULT_TIMEOUT_MS, START_MS, expectError, startService } from './helpers.ts';

const DAY_MS = 86_400_000;

describe('run creation', () => {
  it('returns 202 with Location and a RunView carrying resolved limits and the default deadline', async () => {
    const env = await startService();
    const session = await env.createSession();

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'Say hello' } });

    expect(response.status).toBe(202);
    const run = response.json.run;
    expect(response.headers['location']).toBe(`/v1/runs/${run.id}`);
    expect(response.headers['idempotent-replayed']).toBeUndefined();
    expect(run).toMatchObject({
      sessionId: session.id,
      ordinal: 1,
      status: 'QUEUED',
      limits: DEFAULT_LIMITS,
      createdAt: START_MS,
      deadlineAt: START_MS + DEFAULT_TIMEOUT_MS,
      cancelRequested: false,
    });
    for (const field of ['leaseToken', 'leaseOwner', 'leaseExpiresAt', 'version', 'availableAt']) expect(run).not.toHaveProperty(field);
    expect((await env.http('GET', `/v1/runs/${run.id}`)).json.run).toEqual(run);
  });

  it('merges requested limits over the defaults and counts the deadline from creation', async () => {
    const env = await startService();
    const session = await env.createSession();
    env.clock.advance(5_000);

    const run = await env.createRun(session.id, { limits: { maxSteps: 7, loopThreshold: 2 }, timeoutMs: 60_000 });

    expect(run.limits).toEqual({ ...DEFAULT_LIMITS, maxSteps: 7, loopThreshold: 2 });
    expect(run.createdAt).toBe(START_MS + 5_000);
    expect(run.deadlineAt).toBe(START_MS + 65_000);
  });

  it('accepts the limit bounds inclusively', async () => {
    const env = await startService();
    const session = await env.createSession();
    const low = await env.createRun(session.id, { limits: { maxSteps: 1, maxTotalTokens: 1, approvalTtlMs: 1000, loopThreshold: 2 }, timeoutMs: 1000 });
    expect(low.limits).toEqual({ maxSteps: 1, maxTotalTokens: 1, approvalTtlMs: 1000, loopThreshold: 2 });
    const high = await env.createRun(session.id, { limits: { maxSteps: 1000, maxTotalTokens: 100_000_000, approvalTtlMs: 7 * DAY_MS, loopThreshold: 20 }, timeoutMs: 7 * DAY_MS });
    expect(high.limits).toEqual({ maxSteps: 1000, maxTotalTokens: 100_000_000, approvalTtlMs: 7 * DAY_MS, loopThreshold: 20 });
    expect(high.deadlineAt).toBe(START_MS + 7 * DAY_MS);
  });

  it.each([
    ['maxSteps 0', { limits: { maxSteps: 0 } }],
    ['maxSteps 1001', { limits: { maxSteps: 1001 } }],
    ['maxSteps fractional', { limits: { maxSteps: 1.5 } }],
    ['maxTotalTokens 0', { limits: { maxTotalTokens: 0 } }],
    ['maxTotalTokens above 100M', { limits: { maxTotalTokens: 100_000_001 } }],
    ['approvalTtlMs 999', { limits: { approvalTtlMs: 999 } }],
    ['approvalTtlMs above 7 d', { limits: { approvalTtlMs: 7 * DAY_MS + 1 } }],
    ['loopThreshold 1', { limits: { loopThreshold: 1 } }],
    ['loopThreshold 21', { limits: { loopThreshold: 21 } }],
    ['an unknown limit', { limits: { maxWidgets: 3 } }],
    ['timeoutMs 999', { timeoutMs: 999 }],
    ['timeoutMs above 7 d', { timeoutMs: 7 * DAY_MS + 1 }],
    ['an empty input', { input: '' }],
    ['a non-string input', { input: 42 }],
    ['an unknown field', { priority: 'high' }],
  ])('rejects %s with 400', async (_label, overrides) => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x', ...overrides } }), 400, 'invalid_request');
    expect((await env.http('GET', `/v1/sessions/${session.id}/runs`)).json.runs).toEqual([]);
  });

  it('rejects a missing input with 400', async () => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: {} }), 400, 'invalid_request');
  });

  it('measures the input length in code points', async () => {
    const env = await startService({ maxBodyBytes: 8 * 1024 * 1024 });
    const session = await env.createSession();
    expect((await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'a'.repeat(1_000_000) } })).status).toBe(202);
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'a'.repeat(1_000_001) } }), 400, 'invalid_request');
    expect((await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: '\u{1F600}'.repeat(600_000) } })).status).toBe(202);
  });

  it('returns 404 for an unknown session', async () => {
    const env = await startService();
    expectError(await env.http('POST', '/v1/sessions/ses_missing/runs', { body: { input: 'x' } }), 404, 'not_found');
  });

  it('returns 404 for an unknown run', async () => {
    const env = await startService();
    expectError(await env.http('GET', '/v1/runs/run_missing'), 404, 'not_found');
  });

  it('records previous_run_id as the session’s latest earlier run', async () => {
    const env = await startService();
    const session = await env.createSession();
    const otherSession = await env.createSession();
    const first = await env.createRun(session.id, { input: 'one' });
    await env.createRun(otherSession.id, { input: 'elsewhere' });
    const second = await env.createRun(session.id, { input: 'two' });
    const third = await env.createRun(session.id, { input: 'three' });

    const previous = (runId: string): unknown =>
      (env.raw().prepare('SELECT previous_run_id AS previous FROM runs WHERE id = ?').get(runId) as { previous: unknown }).previous;
    expect(previous(first.id)).toBeNull();
    expect(previous(second.id)).toBe(first.id);
    expect(previous(third.id)).toBe(second.id);
  });
});

describe('run idempotency', () => {
  it('replays a bare key and its sf-string form with the same run', async () => {
    const env = await startService();
    const session = await env.createSession();
    const target = `/v1/sessions/${session.id}/runs`;

    const first = await env.http('POST', target, { body: { input: 'x', timeoutMs: 5000 }, headers: { 'idempotency-key': 'abc-1' } });
    const bare = await env.http('POST', target, { body: { input: 'x', timeoutMs: 5000 }, headers: { 'idempotency-key': 'abc-1' } });
    const quoted = await env.http('POST', target, { body: { input: 'x', timeoutMs: 5000 }, headers: { 'idempotency-key': '"abc-1"' } });

    expect(first.status).toBe(202);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    for (const replay of [bare, quoted]) {
      expect(replay.status).toBe(202);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json.run.id).toBe(first.json.run.id);
    }
    expect((await env.http('GET', `/v1/sessions/${session.id}/runs`)).json.runs).toHaveLength(1);
  });

  it('digests the parsed body, so whitespace and key order do not matter', async () => {
    const env = await startService();
    const session = await env.createSession();
    const target = `/v1/sessions/${session.id}/runs`;
    const headers = { 'idempotency-key': 'order-1' };

    const first = await env.http('POST', target, { raw: '{"input":"x","timeoutMs":5000}', headers });
    const reordered = await env.http('POST', target, { raw: '{ "timeoutMs" : 5000 ,\n "input" : "x" }', headers });

    expect(first.status).toBe(202);
    expect(reordered.status).toBe(202);
    expect(reordered.json.run.id).toBe(first.json.run.id);
  });

  it('keeps absent optional fields absent in the digest', async () => {
    const env = await startService();
    const session = await env.createSession();
    const target = `/v1/sessions/${session.id}/runs`;
    const headers = { 'idempotency-key': 'absent-1' };

    const first = await env.http('POST', target, { body: { input: 'x' }, headers });
    const same = await env.http('POST', target, { body: { input: 'x' }, headers });
    const withEmptyLimits = await env.http('POST', target, { body: { input: 'x', limits: {} }, headers });

    expect(same.json.run.id).toBe(first.json.run.id);
    expectError(withEmptyLimits, 422, 'idempotency_key_reused');
  });

  it('rejects a reused key with a different body with 422', async () => {
    const env = await startService();
    const session = await env.createSession();
    const target = `/v1/sessions/${session.id}/runs`;
    await env.http('POST', target, { body: { input: 'first' }, headers: { 'idempotency-key': 'k-1' } });
    expectError(await env.http('POST', target, { body: { input: 'second' }, headers: { 'idempotency-key': 'k-1' } }), 422, 'idempotency_key_reused');
  });

  it('rejects a stored run whose request digest is NULL with 422', async () => {
    const env = await startService();
    const session = await env.createSession();
    const target = `/v1/sessions/${session.id}/runs`;
    const first = await env.http('POST', target, { body: { input: 'x' }, headers: { 'idempotency-key': 'legacy-1' } });
    env.raw().prepare('UPDATE runs SET request_digest = NULL WHERE id = ?').run(first.json.run.id);
    expectError(await env.http('POST', target, { body: { input: 'x' }, headers: { 'idempotency-key': 'legacy-1' } }), 422, 'idempotency_key_reused');
  });

  it('scopes keys to the session', async () => {
    const env = await startService();
    const one = await env.createSession();
    const two = await env.createSession();
    const a = await env.http('POST', `/v1/sessions/${one.id}/runs`, { body: { input: 'x' }, headers: { 'idempotency-key': 'shared' } });
    const b = await env.http('POST', `/v1/sessions/${two.id}/runs`, { body: { input: 'x' }, headers: { 'idempotency-key': 'shared' } });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(b.json.run.id).not.toBe(a.json.run.id);
  });

  it.each([
    ['an empty sf-string', '""'],
    ['a key longer than 200 characters', 'k'.repeat(201)],
    ['a key with a space', 'two words'],
    ['an unterminated sf-string', '"abc'],
  ])('rejects %s with 400', async (_label, key) => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x' }, headers: { 'idempotency-key': key } }), 400, 'invalid_request');
  });

  it('accepts a 200-character key', async () => {
    const env = await startService();
    const session = await env.createSession();
    expect((await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x' }, headers: { 'idempotency-key': 'k'.repeat(200) } })).status).toBe(202);
  });
});

describe('request framing', () => {
  it('rejects a body above maxBodyBytes with 413', async () => {
    const env = await startService({ maxBodyBytes: 1024 });
    expectError(await env.http('POST', '/v1/sessions', { body: { title: 'a'.repeat(2048) } }), 413, 'body_too_large');
  });

  it('rejects a body above the 2 MiB default with 413', async () => {
    const env = await startService();
    expectError(await env.http('POST', '/v1/sessions', { body: { title: 'a'.repeat(2 * 1024 * 1024 + 16) } }), 413, 'body_too_large');
  });

  it('reads a run request up to the prompt body bound, not maxBodyBytes', async () => {
    const env = await startService({ maxBodyBytes: 1024 });
    const session = await env.createSession();
    expect((await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'a'.repeat(2048) } })).status).toBe(202);
  });

  it('rejects a run request above the prompt body bound with 413', async () => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'a'.repeat(PROMPT_BODY_MAX_BYTES + 16) } }), 413, 'body_too_large');
  });

  it('rejects a non-JSON content type with 415', async () => {
    const env = await startService();
    const session = await env.createSession();
    expectError(
      await env.http('POST', `/v1/sessions/${session.id}/runs`, { raw: JSON.stringify({ input: 'x' }), contentType: 'text/plain' }),
      415,
      'unsupported_media_type',
    );
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { raw: JSON.stringify({ input: 'x' }), contentType: null }), 415, 'unsupported_media_type');
    expectError(
      await env.http('POST', `/v1/sessions/${session.id}/runs`, { raw: JSON.stringify({ input: 'x' }), contentType: 'application/merge-patch+json' }),
      415,
      'unsupported_media_type',
    );
  });

  it('accepts application/json with a charset parameter', async () => {
    const env = await startService();
    const session = await env.createSession();
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { raw: JSON.stringify({ input: 'x' }), contentType: 'application/json; charset=utf-8' });
    expect(response.status).toBe(202);
  });

  it('rejects malformed JSON with 400', async () => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { raw: '{"input":' }), 400, 'invalid_request');
  });

  it('answers a wrong method with 405 and an Allow header', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const allowOf = (header: string | undefined): string[] => (header ?? '').split(',').map((method) => method.trim()).filter((method) => method !== '' && method !== 'HEAD' && method !== 'OPTIONS').sort();

    const onRuns = await env.http('DELETE', `/v1/sessions/${session.id}/runs`);
    expect(onRuns.status).toBe(405);
    expect(allowOf(onRuns.headers['allow'])).toEqual(['GET', 'POST']);

    const onRun = await env.http('PUT', `/v1/runs/${run.id}`, { body: {} });
    expect(onRun.status).toBe(405);
    expect(allowOf(onRun.headers['allow'])).toEqual(['GET']);

    const onCancel = await env.http('GET', `/v1/runs/${run.id}/cancel`);
    expect(onCancel.status).toBe(405);
    expect(allowOf(onCancel.headers['allow'])).toEqual(['POST']);

    const onSession = await env.http('DELETE', `/v1/sessions/${session.id}`);
    expect(onSession.status).toBe(405);
    expect(allowOf(onSession.headers['allow'])).toEqual(['GET', 'PATCH']);
  });
});
