import { afterEach, describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { ACCESS_LIFETIME_MS, MARGIN_MS, PROFILE_ID, START_MS, editRecord, planError, rawRecord, readRecord, rotateAtFake, signedIn, startHarness, toRefreshWindow, CONDITION_WAIT, TOKEN_ATTEMPT_BOUND_MS } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const harness = async (): Promise<Harness> => {
  const h = await startHarness();
  harnesses.push(h);
  return h;
};

const readWork = (h: Harness) => h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).read(new AbortController().signal);

const TERMINAL_CODES = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'];

const REGISTRATION_FIELDS = ['client_id', 'subject', 'email', 'ext_agent_host_id', 'welcomeShown'] as const;

describe('a successful rotation (F8, I-C5)', () => {
  it('posts the documented form: refresh_token grant, the issued client id, the saved refresh token and the resource, with no scope', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    toRefreshWindow(h, START_MS);
    await readWork(h);
    const post = h.auth.records.find((record) => record.form['grant_type'] === 'refresh_token');
    expect(post?.form).toEqual({ grant_type: 'refresh_token', client_id: signIn.clientId, refresh_token: signIn.tokens.refresh_token, resource: 'https://api.openai.com/v1' });
  });

  it('replaces the access token, the refresh token and the generation in one write, and the old refresh token leaves the file', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const before = await readRecord(h, 'work');
    toRefreshWindow(h, START_MS);
    const read = await readWork(h);
    const after = await readRecord(h, 'work');
    expect(after?.['access_token']).toBe(read.bearer);
    expect(after?.['refresh_token']).not.toBe(signIn.tokens.refresh_token);
    expect(after?.['generation']).toBe((before?.['generation'] as number) + 1);
    expect(after?.['pendingRefresh']).toBeUndefined();
    expect(await rawRecord(h, 'work')).not.toContain(signIn.tokens.refresh_token);
    expect(h.auth.verifyAccessToken(read.bearer, 'https://api.openai.com/v1')).toBe('valid');
  });

  it('writes pendingRefresh with the current generation and the start time before the POST leaves', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const installed = await readRecord(h, 'work');
    toRefreshWindow(h, START_MS);
    const startedAt = h.clock.now();
    const gate = h.holdNextRefresh();
    const reading = readWork(h);
    await expect.poll(async () => (await readRecord(h, 'work'))?.['pendingRefresh'], CONDITION_WAIT).toEqual({ generation: installed?.['generation'], startedAt });
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    gate.release();
    await reading;
    expect((await readRecord(h, 'work'))?.['pendingRefresh']).toBeUndefined();
  });

  it('keeps the raw earliest_refresh_at as received and does not wait for it', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.rewriteRefresh((body) => ({ ...body, earliest_refresh_at: 'opaque-value-as-sent' }));
    toRefreshWindow(h, START_MS);
    await readWork(h);
    expect((await readRecord(h, 'work'))?.['earliestRefreshAt']).toBe('opaque-value-as-sent');
    expect(h.sleeps).toEqual([]);
  });

  it('feeds every issued access, refresh and ID token to the redactor', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    expect(h.secrets).toEqual(expect.arrayContaining([signIn.tokens.access_token, signIn.tokens.refresh_token, signIn.idToken]));
    toRefreshWindow(h, START_MS);
    await readWork(h);
    const after = await readRecord(h, 'work');
    expect(h.secrets).toEqual(expect.arrayContaining([after?.['access_token'], after?.['refresh_token']]));
  });

  it('a refresh that drops the required scope sets plan_disabled', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.rewriteRefresh((body) => ({ ...body, scope: 'openid profile email offline_access resource.invoke' }));
    toRefreshWindow(h, START_MS);
    const failure = await planError(readWork(h));
    expect(failure.code).toBe('plan_use_not_enabled');
    expect((await readRecord(h, 'work'))?.['state']).toBe('plan_disabled');
  });
});

describe('terminal refresh answers (F9, I-C6, I-C7)', () => {
  it.each(TERMINAL_CODES)('%s clears the tokens, keeps the registration and records the code as the cause', async (code) => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const before = await readRecord(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'error', code }]);
    toRefreshWindow(h, START_MS);
    expect((await planError(readWork(h))).code).toBe('sign_in_required');
    const after = await readRecord(h, 'work');
    expect(after).toMatchObject({ state: 'needs_sign_in', cause: code });
    expect(after?.['interrupted']).toBeUndefined();
    expect(after?.['access_token']).toBeUndefined();
    expect(after?.['refresh_token']).toBeUndefined();
    for (const field of REGISTRATION_FIELDS) expect(after?.[field], field).toEqual(before?.[field]);
    expect(after?.['id_token']).toBe(signIn.idToken);
    const raw = await rawRecord(h, 'work');
    expect(raw).not.toContain(signIn.tokens.access_token);
    expect(raw).not.toContain(signIn.tokens.refresh_token);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
  });

  it('a user disconnect learnt at the next refresh ends in needs_sign_in with the server code', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.disconnect(signIn.clientId);
    toRefreshWindow(h, START_MS);
    expect((await planError(readWork(h))).code).toBe('sign_in_required');
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'needs_sign_in', cause: 'refresh_token_invalidated' });
  });

  it('a terminal answer to a refresh whose intent survived a restart keeps the server code as cause and sets interrupted', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const installed = await readRecord(h, 'work');
    await rotateAtFake(h, signIn.clientId, signIn.tokens.refresh_token);
    await editRecord(h, 'work', (record) => ({ ...record, pendingRefresh: { generation: installed?.['generation'], startedAt: START_MS } }));
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    const refreshesBefore = h.auth.calls.tokenRefreshToken;
    toRefreshWindow(h, START_MS);
    expect((await planError(readWork(h))).code).toBe('sign_in_required');
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'needs_sign_in', cause: 'refresh_token_reused', interrupted: true, client_id: signIn.clientId });
    expect(h.auth.calls.tokenRefreshToken - refreshesBefore).toBe(1);
  });

  it('a terminal answer after a send of the same token went unanswered in this refresh sets interrupted', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'lose_response' }]);
    toRefreshWindow(h, START_MS);
    expect((await planError(readWork(h))).code).toBe('sign_in_required');
    expect(h.auth.calls.tokenRefreshToken).toBe(2);
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'needs_sign_in', cause: 'refresh_token_reused', interrupted: true });
  });

  it('invalid_client keeps everything, sets needs_sign_in with cause invalid_client and gives the registration sentence', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const before = await readRecord(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'error', code: 'invalid_client' }]);
    toRefreshWindow(h, START_MS);
    const failure = await planError(readWork(h));
    expect(failure.code).toBe('sign_in_required');
    expect(failure.message).toContain('the registration is no longer valid; sign out of this account and sign in again');
    const after = await readRecord(h, 'work');
    expect(after).toMatchObject({ state: 'needs_sign_in', cause: 'invalid_client' });
    expect(after?.['access_token']).toBe(before?.['access_token']);
    expect(after?.['refresh_token']).toBe(before?.['refresh_token']);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
  });
});

describe('transient refresh answers keep everything (I-C6) and are retried at most attempts - 1 times (I-C3)', () => {
  const unanswered: Array<[string, Parameters<Harness['auth']['scriptToken']>[1][number]]> = [
    ['a dropped connection', { kind: 'drop' }],
    ['HTTP 500', { kind: 'http', status: 500, body: '{"error":"server_error"}' }],
    ['HTTP 429', { kind: 'http', status: 429, body: '{"error":"rate_limited"}' }],
    ['an unparseable body', { kind: 'http', status: 502, body: 'not json' }],
    ['an unknown 4xx code', { kind: 'error', code: 'something_new' }],
  ];

  it.each(unanswered)('%s is retried to three sends and leaves the record as it was', async (_name, step) => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [step, step, step]);
    toRefreshWindow(h, START_MS);
    await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(3);
    const after = await readRecord(h, 'work');
    expect(after).toMatchObject({ state: 'active', refresh_token: signIn.tokens.refresh_token, access_token: signIn.tokens.access_token });
  });

  it('a 200 without a replacement refresh token adopts the access token and keeps the old refresh token (RFC 6749 section 6)', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const before = await readRecord(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'no_replacement_refresh_token' }]);
    toRefreshWindow(h, START_MS);
    const read = await readWork(h);
    expect(read.bearer).not.toBe(signIn.tokens.access_token);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect(await readRecord(h, 'work')).toMatchObject({
      state: 'active',
      access_token: read.bearer,
      refresh_token: signIn.tokens.refresh_token,
      generation: (before?.['generation'] as number) + 1,
    });
  });

  it('a 200 with expires_in equal to M is not adopted: the request goes on with the current token (tokenResponseProblem, O-R5-4)', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'expires_in', seconds: 121 }]);
    toRefreshWindow(h, START_MS);
    const read = await readWork(h);
    expect(read.bearer).toBe(signIn.tokens.access_token);
    expect((await readRecord(h, 'work'))?.['access_token']).toBe(signIn.tokens.access_token);
  });

  it('never sends a refresh token again once a 200 carried its replacement (SingleUseServer)', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    toRefreshWindow(h, START_MS);
    const first = await source.read(new AbortController().signal);
    expect(await source.rejected(first.generation, new AbortController().signal)).toBe('renewed');
    const sent = h.auth.records.filter((record) => record.form['grant_type'] === 'refresh_token').map((record) => record.form['refresh_token']);
    expect(sent).toHaveLength(2);
    expect(sent.filter((token) => token === signIn.tokens.refresh_token)).toHaveLength(1);
    expect(new Set(sent).size).toBe(2);
  });

  it('a 200 with expires_in of M + 1 s is adopted', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'expires_in', seconds: 122 }]);
    toRefreshWindow(h, START_MS);
    const read = await readWork(h);
    expect(read.bearer).not.toBe(signIn.tokens.access_token);
  });
});

describe('the wait between refresh attempts is nextWait of the gateway retry policy', () => {
  it('waits the equal-jitter backoff of base 500 ms between dropped attempts', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'drop' }, { kind: 'drop' }, { kind: 'drop' }]);
    toRefreshWindow(h, START_MS);
    await readWork(h);
    expect(h.sleeps).toHaveLength(2);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(h.sleeps[0]).toBeLessThanOrEqual(500);
    expect(h.sleeps[1]).toBeGreaterThanOrEqual(500);
    expect(h.sleeps[1]).toBeLessThanOrEqual(1000);
  });

  it('honours a Retry-After of 5 s on 503 by waiting 5000 ms, then succeeds', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'http', status: 503, body: '{}', headers: { 'retry-after': '5' } }]);
    toRefreshWindow(h, START_MS);
    const read = await readWork(h);
    expect(h.sleeps).toEqual([5000]);
    expect(h.auth.calls.tokenRefreshToken).toBe(2);
    expect(read.bearer).not.toBe(signIn.tokens.access_token);
  });

  it('a Retry-After longer than retry.maxMs (9 s on 429) ends the refresh as transient without sleeping or resending', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'http', status: 429, body: '{}', headers: { 'retry-after': '9' } }]);
    toRefreshWindow(h, START_MS);
    const read = await readWork(h);
    expect(h.sleeps).toEqual([]);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect(read.bearer).toBe(signIn.tokens.access_token);
    expect((await readRecord(h, 'work'))?.['refresh_token']).toBe(signIn.tokens.refresh_token);
  });
});

describe('a token answer is outside JSON, bounded by the one depth rule', () => {
  it('a 200 nested past MAX_JSON_DEPTH is an unparseable body: transient, not adopted and not resent', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    let nested: unknown = [];
    for (let level = 0; level < MAX_JSON_DEPTH; level += 1) nested = [nested];
    h.rewriteRefresh((body) => ({ ...body, nested }));
    toRefreshWindow(h, START_MS);
    const read = await readWork(h);
    expect(read.bearer).toBe(signIn.tokens.access_token);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect((await readRecord(h, 'work'))?.['access_token']).toBe(signIn.tokens.access_token);
  });
});

describe('the token-endpoint attempt bound T_a = 15 s (I-C3)', () => {
  it('abandons a send that never answers at T_a, counts it as unanswered and resends within the same refresh', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.holdNextRefresh();
    toRefreshWindow(h, START_MS);
    let settled = false;
    const reading = readWork(h).finally(() => {
      settled = true;
    });
    await expect.poll(() => h.pendingBounds(), CONDITION_WAIT).toContain(TOKEN_ATTEMPT_BOUND_MS);
    expect(settled).toBe(false);
    h.fireLatestBound(TOKEN_ATTEMPT_BOUND_MS);
    const read = await reading;
    expect(h.fetchUrls.filter((url) => url === h.auth.tokenUrl)).toHaveLength(2);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect(read.bearer).not.toBe(signIn.tokens.access_token);
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'active', access_token: read.bearer });
  });
});

describe('the write-ahead intent stays while the token it covers is still the stored one (design 14, InterruptedRecorded)', () => {
  const secondWindow = START_MS + ACCESS_LIFETIME_MS - MARGIN_MS;

  it('a 200 without a replacement after an unanswered send in the same refresh keeps pendingRefresh, and the next refresh_token_reused records interrupted', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'drop' }, { kind: 'no_replacement_refresh_token' }]);
    toRefreshWindow(h, START_MS);
    await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(2);
    const kept = await readRecord(h, 'work');
    expect(kept).toMatchObject({ state: 'active', refresh_token: signIn.tokens.refresh_token });
    expect(kept?.['pendingRefresh']).toBeDefined();
    toRefreshWindow(h, secondWindow);
    expect((await planError(readWork(h))).code).toBe('sign_in_required');
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'needs_sign_in', cause: 'refresh_token_reused', interrupted: true });
  });

  it('a 200 without a replacement after a pendingRefresh loaded at startup keeps pendingRefresh, and the next refresh_token_reused records interrupted', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const installed = await readRecord(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, pendingRefresh: { generation: installed?.['generation'], startedAt: START_MS } }));
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    h.auth.scriptToken('refresh_token', [{ kind: 'no_replacement_refresh_token' }]);
    toRefreshWindow(h, START_MS);
    await readWork(h);
    const kept = await readRecord(h, 'work');
    expect(kept).toMatchObject({ state: 'active', refresh_token: signIn.tokens.refresh_token });
    expect(kept?.['pendingRefresh']).toBeDefined();
    toRefreshWindow(h, secondWindow);
    expect((await planError(readWork(h))).code).toBe('sign_in_required');
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'needs_sign_in', cause: 'refresh_token_reused', interrupted: true });
  });

  it('a 200 with a replacement after an unanswered send clears pendingRefresh', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'drop' }]);
    toRefreshWindow(h, START_MS);
    await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(2);
    const after = await readRecord(h, 'work');
    expect(after).toMatchObject({ state: 'active' });
    expect(after?.['refresh_token']).not.toBe(signIn.tokens.refresh_token);
    expect(after?.['pendingRefresh']).toBeUndefined();
  });
});
