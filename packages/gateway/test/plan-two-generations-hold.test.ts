import { afterEach, describe, expect, it } from 'vitest';
import { createEncryptedCredentialStore, momongaLayout } from '@momonga/foundation';
import type { ListableCredentialStore } from '@momonga/foundation';
import { testKernelLock } from '@momonga/testkit';
import { planRecordKeyOfPlaintext } from '../src/plan/session.ts';
import { NEVER_ENDED, PROFILE_ID, START_MS, errno, failingWrites, planError, readRecord, signInAtFake, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const work = { profile: PROFILE_ID, account: 'work' };

const OTHER_GENERATION_LOCK_BOUND_MS = 300;

const otherGenerationStore = (h: Harness): ListableCredentialStore =>
  createEncryptedCredentialStore({
    lock: testKernelLock(),
    directory: h.paths.sessions,
    stateDirectory: momongaLayout(h.home, process.platform, process.env).state,
    secretStore: { kind: 'none', reason: 'the harness keeps plaintext records' },
    plaintextTokenFiles: () => true,
    keyOfPlaintext: planRecordKeyOfPlaintext,
    lockTimeoutMs: OTHER_GENERATION_LOCK_BOUND_MS,
  });

const rotationPersistFails = async (h: Harness): Promise<{ installed: number; succeed(): void }> => {
  const installed = (await readRecord(h, 'work'))?.['generation'] as number;
  let failing = true;
  const store = failingWrites(h.store, (value) => {
    const record = JSON.parse(value) as { generation?: number; pendingRefresh?: unknown; state?: string };
    const rotated = record.generation === installed + 1 && record.pendingRefresh === undefined && record.state === 'active';
    return failing && rotated ? errno('ENOSPC') : undefined;
  });
  await h.reopen({ accounts: [work], store });
  return {
    installed,
    succeed: () => {
      failing = false;
    },
  };
};

describe('a generation whose record is ahead of disk keeps the record lock until the persist succeeded (I-C3, I-C5, PlanCredential.twoGensPersistFail)', () => {
  it('the other generation never sends the spent refresh token: its refresh and install end at their bound with the typed lock error', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const signIn = await signedIn(h, 'work');
    const persist = await rotationPersistFails(h);
    const other = await h.another({ accounts: [work], store: otherGenerationStore(h) });
    const source = h.sessions.authSource(work);
    const otherSource = other.authSource(work);
    toRefreshWindow(h, START_MS);
    const retry = h.holdNextBackoff();
    const rotated = await source.read(NEVER_ENDED);
    await retry.reached;
    expect(rotated.bearer).not.toBe(signIn.tokens.access_token);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect((await readRecord(h, 'work'))?.['refresh_token']).toBe(signIn.tokens.refresh_token);

    const failedBefore = h.events.filter((event) => event.name === 'plan.refresh' && event.data['outcome'] === 'failed').length;
    expect((await otherSource.read(NEVER_ENDED)).bearer).toBe(signIn.tokens.access_token);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    const failed = h.events.filter((event) => event.name === 'plan.refresh' && event.data['outcome'] === 'failed');
    expect(failed).toHaveLength(failedBefore + 1);
    expect(failed.at(-1)?.data['code']).toBe('plan_store_unwritable');

    const again = await signInAtFake(h);
    const install = await planError(
      other.install({ profile: PROFILE_ID, account: 'work', clientId: again.clientId, hostId: again.hostId, subject: again.subject, email: again.email, idToken: again.idToken, tokens: again.tokens }, NEVER_ENDED),
    );
    expect(install).toMatchObject({ code: 'plan_store_unwritable', retryable: true });
    expect(install.message).toContain(`timed out after ${OTHER_GENERATION_LOCK_BOUND_MS}ms waiting for lock`);

    persist.succeed();
    retry.release();
    await expect.poll(async () => (await readRecord(h, 'work'))?.['generation'], { timeout: 30_000, interval: 5 }).toBe(persist.installed + 1);
    expect((await readRecord(h, 'work'))?.['access_token']).toBe(rotated.bearer);
  });

  it('a sign-out of the same process in the dirty window runs under the held lock and completes', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const signIn = await signedIn(h, 'work');
    await rotationPersistFails(h);
    const source = h.sessions.authSource(work);
    toRefreshWindow(h, START_MS);
    const retry = h.holdNextBackoff();
    await source.read(NEVER_ENDED);
    await retry.reached;
    expect((await readRecord(h, 'work'))?.['refresh_token']).toBe(signIn.tokens.refresh_token);
    const report = await h.sessions.signOut(work, NEVER_ENDED);
    expect(report.revocation).toBe('confirmed');
    expect((await readRecord(h, 'work'))?.['state']).toBe('registered');
    retry.release();
    const other = await h.another({ accounts: [work], store: otherGenerationStore(h) });
    expect(other.authSource(work).status().state).not.toBe('active');
  });
});
