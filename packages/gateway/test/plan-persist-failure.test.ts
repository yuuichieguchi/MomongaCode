import { afterEach, describe, expect, it } from 'vitest';
import { ACCESS_LIFETIME_MS, MARGIN_MS, PROFILE_ID, SKEW_MS, START_MS, errno, failingWrites, planError, readRecord, signedIn, startHarness, toRefreshWindow, CONDITION_WAIT } from './plan-support.ts';
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

const signal = (): AbortSignal => new AbortController().signal;

const completionOf = (installedGeneration: number) => (value: string) => {
  const record = JSON.parse(value) as { generation?: number; pendingRefresh?: unknown };
  return record.generation === installedGeneration + 1 && record.pendingRefresh === undefined;
};

const failRotationWrite = async (h: Harness, code: string, times: number) => {
  const installed = (await readRecord(h, 'work'))?.['generation'] as number;
  let remaining = times;
  const isCompletion = completionOf(installed);
  const store = failingWrites(h.store, (value) => {
    if (remaining === 0 || !isCompletion(value)) return undefined;
    remaining -= 1;
    return errno(code);
  });
  await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }], store });
  return installed;
};

describe('a deterministic write failure after a rotation: store_unwritable (I-C11, NoRefreshWhileUnwritable)', () => {
  it('keeps the new tokens in memory, starts no further refresh, does not retry the write, and fails with plan_store_unwritable once the token expires', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    await failRotationWrite(h, 'EACCES', Number.POSITIVE_INFINITY);
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    toRefreshWindow(h, START_MS);
    const rotated = await source.read(signal());
    expect(rotated.bearer).not.toBe(signIn.tokens.access_token);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect(source.status()).toMatchObject({ state: 'store_unwritable' });
    expect(String(source.status().cause)).toContain('EACCES');
    expect(source.health()).toMatchObject({ ok: false, reason: 'store_unwritable' });
    expect(h.sleeps).not.toContain(30_000);

    const rotatedAt = h.clock.now();
    h.clock.set(rotatedAt + ACCESS_LIFETIME_MS - MARGIN_MS);
    expect((await source.read(signal())).bearer).toBe(rotated.bearer);
    h.clock.set(rotatedAt + ACCESS_LIFETIME_MS - SKEW_MS - 1);
    expect((await source.read(signal())).bearer).toBe(rotated.bearer);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);

    h.clock.set(rotatedAt + ACCESS_LIFETIME_MS - SKEW_MS);
    expect((await planError(source.read(signal()))).code).toBe('plan_store_unwritable');
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect((await readRecord(h, 'work'))?.['refresh_token']).toBe(signIn.tokens.refresh_token);
  });
});

describe('a transient write failure after a rotation: retried every 30 s (persist retry)', () => {
  it('retries the write after 30 000 ms and then the file holds the replacement and not the old refresh token', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const installed = await failRotationWrite(h, 'ENOSPC', 1);
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    toRefreshWindow(h, START_MS);
    const rotated = await source.read(signal());
    await expect.poll(async () => (await readRecord(h, 'work'))?.['generation'], CONDITION_WAIT).toBe(installed + 1);
    expect(h.sleeps).toContain(30_000);
    const after = await readRecord(h, 'work');
    expect(after?.['access_token']).toBe(rotated.bearer);
    expect(after?.['refresh_token']).not.toBe(signIn.tokens.refresh_token);
    expect(source.status()).toMatchObject({ state: 'active' });
  });
});
