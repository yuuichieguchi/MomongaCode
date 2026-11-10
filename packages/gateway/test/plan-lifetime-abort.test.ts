import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendRefresh } from '../src/plan/refresh.ts';
import { revokeRefreshToken } from '../src/plan/revoke.ts';
import { CONDITION_WAIT, PROFILE_ID, START_MS, readRecord, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
import type { Harness } from './plan-support.ts';
import { ATTEMPT_BOUND_MS, DISCOVERY_URL, ISSUER, REVOKE_URL, TOKEN_URL, WAIT_POLICY, boundOnlySleep, recordedFetch, sendClock, sendProfile } from './plan-send-fakes.ts';
import type { ParkedSleep } from './plan-send-fakes.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const CAP = 262_144;

const tokenAnswer = (): Response =>
  new Response(JSON.stringify({ access_token: 'access-after-abort', refresh_token: 'refresh-after-abort', token_type: 'Bearer', expires_in: 3600, scope: 'openid offline_access' }), { status: 200 });

const unavailable = (): Response => new Response('', { status: 503 });

const discoveryDocument = (): Response => new Response(JSON.stringify({ issuer: ISSUER, revocation_endpoint: REVOKE_URL }), { status: 200 });

const refresh = (fetch: ReturnType<typeof recordedFetch>['fetch'], sleep: ParkedSleep, signal: AbortSignal) =>
  sendRefresh({
    ports: { fetch, sleep: sleep.sleep },
    clock: sendClock(),
    tokenUrl: TOKEN_URL,
    form: { grant_type: 'refresh_token', refresh_token: 'refresh-under-test', client_id: 'client-under-test' },
    attempts: 3,
    attemptTimeoutMs: ATTEMPT_BOUND_MS,
    waitPolicy: WAIT_POLICY,
    maxBodyBytes: CAP,
    signal,
  });

const revoke = (fetch: ReturnType<typeof recordedFetch>['fetch'], sleep: ParkedSleep, signal: AbortSignal) =>
  revokeRefreshToken({
    ports: { fetch, sleep: sleep.sleep },
    clock: sendClock(),
    profile: sendProfile(),
    clientId: 'client-under-test',
    refreshToken: 'refresh-under-test',
    attempts: 3,
    attemptTimeoutMs: ATTEMPT_BOUND_MS,
    waitPolicy: WAIT_POLICY,
    maxBodyBytes: CAP,
    signal,
  });

const parkedAnswer = () => {
  let answer = (_response: Response): void => undefined;
  const answered = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  return { answered, answer };
};

describe('the lifetime signal ends the waits in which nothing is in flight and never cuts a send (P-G4)', () => {
  it('an abort during the refresh backoff ends the refresh transient with the attempts made and sends nothing more', async () => {
    const sleep = boundOnlySleep({ parkBackoffs: true });
    const fake = recordedFetch(() => unavailable());
    const lifetime = new AbortController();
    const ended = refresh(fake.fetch, sleep, lifetime.signal);
    await vi.waitFor(() => expect(sleep.backoffs).toHaveLength(1), CONDITION_WAIT);
    expect(sleep.backoffs[0]?.signal).toBeDefined();
    lifetime.abort(new Error('closing'));
    expect(await ended).toEqual({ kind: 'transient', attempts: 1 });
    expect(fake.calls).toHaveLength(1);
  });

  it('an abort while a send is in flight does not cut the send and the answer is used', async () => {
    const sleep = boundOnlySleep({ parkBackoffs: true });
    const parked = parkedAnswer();
    const fake = recordedFetch(() => parked.answered);
    const lifetime = new AbortController();
    const ended = refresh(fake.fetch, sleep, lifetime.signal);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1), CONDITION_WAIT);
    lifetime.abort(new Error('closing'));
    expect(fake.calls[0]?.init.signal?.aborted).toBe(false);
    parked.answer(tokenAnswer());
    expect(await ended).toMatchObject({ kind: 'adopted', attempts: 1 });
  });

  it('an abort before the first send ends the refresh with attempts 0', async () => {
    const sleep = boundOnlySleep({ parkBackoffs: true });
    const fake = recordedFetch(() => tokenAnswer());
    const lifetime = new AbortController();
    lifetime.abort(new Error('closing'));
    expect(await refresh(fake.fetch, sleep, lifetime.signal)).toEqual({ kind: 'transient', attempts: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  it('an abort during the revocation backoff rejects with the abort reason and sends no more', async () => {
    const sleep = boundOnlySleep({ parkBackoffs: true });
    const fake = recordedFetch((url) => (url === DISCOVERY_URL ? discoveryDocument() : unavailable()));
    const lifetime = new AbortController();
    const reason = new Error('closing');
    const ended = revoke(fake.fetch, sleep, lifetime.signal);
    await vi.waitFor(() => expect(sleep.backoffs).toHaveLength(1), CONDITION_WAIT);
    expect(sleep.backoffs[0]?.signal).toBeDefined();
    lifetime.abort(reason);
    await expect(ended).rejects.toBe(reason);
    expect(fake.calls.filter((call) => call.url === REVOKE_URL)).toHaveLength(1);
  });

  it('an abort while a revocation POST is in flight does not cut it', async () => {
    const sleep = boundOnlySleep({ parkBackoffs: true });
    const parked = parkedAnswer();
    const fake = recordedFetch((url) => (url === DISCOVERY_URL ? discoveryDocument() : parked.answered));
    const lifetime = new AbortController();
    const ended = revoke(fake.fetch, sleep, lifetime.signal);
    await vi.waitFor(() => expect(fake.calls.filter((call) => call.url === REVOKE_URL)).toHaveLength(1), CONDITION_WAIT);
    lifetime.abort(new Error('closing'));
    expect(fake.calls.at(-1)?.init.signal?.aborted).toBe(false);
    parked.answer(new Response('', { status: 200 }));
    expect(await ended).toBe('confirmed');
  });

  it('session.close() with a refresh parked in its backoff resolves and leaves the intent on disk', { timeout: 60_000 }, async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'http', status: 503 }]);
    const gate = h.holdNextBackoff();
    toRefreshWindow(h, START_MS);
    const reading = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).read(new AbortController().signal).catch(() => undefined);
    await gate.reached;
    let closed = false;
    const closing = h.sessions.close().then(() => {
      closed = true;
    });
    try {
      await vi.waitFor(() => expect(closed).toBe(true), CONDITION_WAIT);
    } finally {
      gate.release();
      await closing;
      await reading;
    }
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect((await readRecord(h, 'work'))?.['pendingRefresh']).toBeDefined();
    expect(h.events.find((event) => event.name === 'plan.refresh')?.data).toMatchObject({ outcome: 'transient', attempts: 1 });
  });
});
