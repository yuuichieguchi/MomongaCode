import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCESS_LIFETIME_MS, MARGIN_MS, PROFILE_ID, SKEW_MS, START_MS, editRecord, planError, recordFileOf, profileFor, signedIn, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const PROFILE_SIGN_IN_REQUIRED = 'Not signed in to the profile under test';

const withOwnSentence = (auth: Parameters<typeof profileFor>[0]) => {
  const shipped = profileFor(auth);
  const messages = { ...shipped.messages, signInRequiredMessage: PROFILE_SIGN_IN_REQUIRED };
  return { ...shipped, messages };
};

const harness = async (): Promise<Harness> => {
  const h = await startHarness({ profile: withOwnSentence });
  harnesses.push(h);
  return h;
};

const pinned = (h: Harness, account: string) => h.sessions.authSource({ profile: PROFILE_ID, account });

describe('read: the bearer, the refresh margin M = 121 s and the skew S = 60 s', () => {
  it('returns the installed access token without a refresh while more than M remains', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.clock.set(START_MS + ACCESS_LIFETIME_MS - MARGIN_MS - 1);
    const read = await pinned(h, 'work').read(new AbortController().signal);
    expect(read.bearer).toBe(signIn.tokens.access_token);
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
  });

  it('refreshes first when exactly M remains and returns the new token with the next generation', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const source = pinned(h, 'work');
    const before = await source.read(new AbortController().signal);
    h.clock.set(START_MS + ACCESS_LIFETIME_MS - MARGIN_MS);
    const after = await source.read(new AbortController().signal);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect(after.bearer).not.toBe(signIn.tokens.access_token);
    expect(h.auth.verifyAccessToken(after.bearer, 'https://api.openai.com/v1')).toBe('valid');
    expect(after.generation).toBe(before.generation + 1);
  });

  it('shares one refresh among concurrent reads (single flight)', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const source = pinned(h, 'work');
    h.clock.set(START_MS + ACCESS_LIFETIME_MS - MARGIN_MS);
    const reads = await Promise.all([1, 2, 3, 4].map(() => source.read(new AbortController().signal)));
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect(new Set(reads.map((read) => read.bearer)).size).toBe(1);
  });

  it('proceeds with the current token after a transient refresh failure while more than S remains', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'drop' }, { kind: 'drop' }, { kind: 'drop' }]);
    h.clock.set(START_MS + ACCESS_LIFETIME_MS - SKEW_MS - 1);
    const read = await pinned(h, 'work').read(new AbortController().signal);
    expect(read.bearer).toBe(signIn.tokens.access_token);
    expect(h.auth.calls.tokenRefreshToken).toBe(3);
  });

  it('retries the refresh on the next call after a transient failure', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const source = pinned(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'drop' }, { kind: 'drop' }, { kind: 'drop' }]);
    h.clock.set(START_MS + ACCESS_LIFETIME_MS - MARGIN_MS);
    expect((await source.read(new AbortController().signal)).bearer).toBe(signIn.tokens.access_token);
    const next = await source.read(new AbortController().signal);
    expect(h.auth.calls.tokenRefreshToken).toBe(4);
    expect(next.bearer).not.toBe(signIn.tokens.access_token);
  });

  it('fails with retryable plan_credential_unavailable after a transient failure when S or less remains', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'drop' }, { kind: 'drop' }, { kind: 'drop' }]);
    h.clock.set(START_MS + ACCESS_LIFETIME_MS - SKEW_MS);
    const failure = await planError(pinned(h, 'work').read(new AbortController().signal));
    expect(failure).toMatchObject({ code: 'plan_credential_unavailable', retryable: true });
  });
});

describe('read: the state decides the failure, and no failure is skippable', () => {
  it.each(['signing_out', 'registered'])('state %s fails with sign_in_required, the not-signed-in sentence, and sends nothing', async (state) => {
    const h = await harness();
    await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, state }));
    await h.reopen();
    h.auth.scriptRevoke([{ kind: 'drop' }, { kind: 'drop' }, { kind: 'drop' }]);
    const refreshesBefore = h.auth.calls.tokenRefreshToken;
    const failure = await planError(pinned(h, 'work').read(new AbortController().signal));
    expect(failure.code).toBe('sign_in_required');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain(PROFILE_SIGN_IN_REQUIRED);
    expect(failure.message).not.toContain('ChatGPT sign-in expired');
    expect(h.auth.calls.tokenRefreshToken).toBe(refreshesBefore);
  });

  it('an account with no record fails with sign_in_required and the not-signed-in sentence', async () => {
    const h = await harness();
    const failure = await planError(pinned(h, 'nobody').read(new AbortController().signal));
    expect(failure).toMatchObject({ code: 'sign_in_required', retryable: false });
    expect(failure.message).toContain(PROFILE_SIGN_IN_REQUIRED);
  });

  it('state needs_sign_in fails with sign_in_required and the expired sentence, and sends nothing', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, state: 'needs_sign_in', cause: 'refresh_token_expired' }));
    await h.reopen();
    const refreshesBefore = h.auth.calls.tokenRefreshToken;
    const failure = await planError(pinned(h, 'work').read(new AbortController().signal));
    expect(failure).toMatchObject({ code: 'sign_in_required', retryable: false });
    expect(failure.message).toContain('ChatGPT sign-in expired');
    expect(failure.message).not.toContain(PROFILE_SIGN_IN_REQUIRED);
    expect(h.auth.calls.tokenRefreshToken).toBe(refreshesBefore);
  });

  it('a lost session carries the profile sentence for an expired sign-in', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'error', code: 'refresh_token_expired' }]);
    h.clock.set(START_MS + ACCESS_LIFETIME_MS - MARGIN_MS);
    const failure = await planError(pinned(h, 'work').read(new AbortController().signal));
    expect(failure.code).toBe('sign_in_required');
    expect(failure.message).toContain('ChatGPT sign-in expired');
  });

  it('state plan_disabled fails with plan_use_not_enabled and the profile sentence', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, state: 'plan_disabled' }));
    await h.reopen();
    const failure = await planError(pinned(h, 'work').read(new AbortController().signal));
    expect(failure).toMatchObject({ code: 'plan_use_not_enabled', retryable: false });
    expect(failure.message).toContain("ChatGPT plan use isn't enabled");
  });

  it('a record the store cannot read fails with plan_store_unreadable, not sign_in_required', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await fs.chmod(recordFileOf(h, 'work'), 0o644);
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    const failure = await planError(pinned(h, 'work').read(new AbortController().signal));
    expect(failure.code).toBe('plan_store_unreadable');
  });
});

describe('read: a target with no account follows the active-account pointer on every read', () => {
  it('reads the label from plan-active.json at each read, and fails with sign_in_required when the profile has no entry', async () => {
    const h = await harness();
    const unpinned = h.sessions.authSource({ profile: PROFILE_ID });
    expect((await planError(unpinned.read(new AbortController().signal))).code).toBe('sign_in_required');
    const work = await signedIn(h, 'work');
    h.auth.identity = { sub: 'sub-second-user', email: 'second@example.com' };
    const home = await signedIn(h, 'home');
    expect((await unpinned.read(new AbortController().signal)).bearer).toBe(home.tokens.access_token);
    await fs.writeFile(h.paths.active, JSON.stringify({ [PROFILE_ID]: 'work' }), { mode: 0o600 });
    expect((await unpinned.read(new AbortController().signal)).bearer).toBe(work.tokens.access_token);
  });
});
