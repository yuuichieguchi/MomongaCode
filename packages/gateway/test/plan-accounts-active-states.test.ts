import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialFileFor } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { PlanAccountNotSelectableError } from '../src/plan/session.ts';
import { ACCOUNT, begin, browse, completeConfirmed, sessionsDirectory, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway } from './plan-signin-support.ts';
import { PROFILE_ID, START_MS, errno, failingWrites, readRecord, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SPARE = 'spare';

const notSelectable = (label: string) => ({
  type: 'invalid_request',
  code: 'plan_account_not_selectable',
  message: `${label} has no verified sign-in to switch to. Sign in to it first.`,
  param: null,
});

const recordFile = (gateway: PlanGateway, account: string): string => credentialFileFor(sessionsDirectory(gateway.home), `plan/${PROFILE_ID}/${account}`);

const signInAs = async (gateway: PlanGateway, account: string): Promise<void> => {
  const begun = await begin(gateway, { account });
  expect(begun.status).toBe(200);
  const callback = await browse(begun.body.authorizationUrl);
  const completed = await completeConfirmed(gateway, begun.body.attemptId, callback.toString());
  expect(completed.body).toMatchObject({ outcome: 'signed_in', account: { label: account } });
};

const withSpareRecordEdited = async (change: (record: Record<string, unknown>) => Record<string, unknown>, plaintextTokenFiles = true): Promise<PlanGateway> => {
  const gateway = await startPlanGateway({ plaintextTokenFiles });
  await signInAs(gateway, ACCOUNT);
  await signInAs(gateway, SPARE);
  expect((await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: ACCOUNT })).status).toBe(200);
  await gateway.close();
  const file = recordFile(gateway, SPARE);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify(change(record)), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  await gateway.restart();
  return gateway;
};

const spareEntry = async (gateway: PlanGateway): Promise<{ state: string; paused?: unknown } | undefined> => {
  const listed = await gateway.get(PLAN_ROUTES.accounts);
  return (listed.body.accounts as { label: string; state: string; paused?: unknown }[]).find((entry) => entry.label === SPARE);
};

const selectSpare = (gateway: PlanGateway) => gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: SPARE });

const hold = (): { reached: Promise<void>; reach(): void; released: Promise<void>; release(): void } => {
  let reach = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, reach, released, release };
};

describe('accounts/active accepts exactly the states whose saved-account action is activate (O-R5-6 J 2)', () => {
  it.each([
    ['plan_disabled', (record: Record<string, unknown>) => ({ ...record, state: 'plan_disabled' })],
    ['needs_sign_in', (record: Record<string, unknown>) => ({ ...record, state: 'needs_sign_in', cause: 'refresh_token_expired' })],
    ['registered', (record: Record<string, unknown>) => ({ ...record, state: 'registered' })],
  ] as const)('refuses %s with 409 plan_account_not_selectable and keeps the pointer', async (state, change) => {
    const gateway = await withSpareRecordEdited(change);
    expect(await spareEntry(gateway)).toMatchObject({ state });
    const moved = await selectSpare(gateway);
    expect(moved.status).toBe(409);
    expect(moved.body.error).toEqual(notSelectable(SPARE));
    const listed = await gateway.get(PLAN_ROUTES.accounts);
    expect((listed.body.accounts as { label: string; active: boolean }[]).find((entry) => entry.label === SPARE)?.active).toBe(false);
    await gateway.close();
  });

  it('refuses store_unreadable with 409 plan_account_not_selectable and keeps the pointer', async () => {
    const gateway = await withSpareRecordEdited((envelope) => {
      const tag = envelope['tag'] as string;
      return { ...envelope, tag: `${tag[0] === '0' ? '1' : '0'}${tag.slice(1)}` };
    }, false);
    expect(await spareEntry(gateway)).toMatchObject({ state: 'store_unreadable' });
    const moved = await selectSpare(gateway);
    expect(moved.status).toBe(409);
    expect(moved.body.error).toEqual(notSelectable(SPARE));
    await gateway.close();
  });

  it('refuses an account with no record with 409 plan_account_not_selectable', async () => {
    const gateway = await startPlanGateway();
    const moved = await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: 'nobody' });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toEqual(notSelectable('nobody'));
    await gateway.close();
  });

  it('refuses an account that is still signing out with 409 plan_account_not_selectable', async () => {
    const gateway = await startPlanGateway();
    const revoke = hold();
    let signingOut: Promise<unknown> = Promise.resolve();
    try {
      expect((await signIn(gateway)).completed.status).toBe(200);
      gateway.auth.scriptRevoke([{ kind: 'hold', reached: revoke.reach, released: revoke.released }]);
      signingOut = gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: ACCOUNT });
      await revoke.reached;
      const moved = await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: ACCOUNT });
      expect(moved.status).toBe(409);
      expect(moved.body.error).toEqual(notSelectable(ACCOUNT));
    } finally {
      revoke.release();
      await signingOut;
      await gateway.close();
    }
  });

  it.each([
    ['active', (record: Record<string, unknown>) => ({ ...record, state: 'active' })],
    ['a paused active account', (record: Record<string, unknown>) => ({ ...record, state: 'active', paused: {} })],
  ] as const)('selects %s with 200 and moves the pointer', async (named, change) => {
    const gateway = await withSpareRecordEdited(change);
    const before = await spareEntry(gateway);
    expect(before?.state).toBe('active');
    expect(before?.paused !== undefined).toBe(named !== 'active');
    const moved = await selectSpare(gateway);
    expect(moved.status).toBe(200);
    const listed = await gateway.get(PLAN_ROUTES.accounts);
    expect((listed.body.accounts as { label: string; active: boolean }[]).find((entry) => entry.label === SPARE)?.active).toBe(true);
    await gateway.close();
  });
});

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

describe('the session engine refuses to select an account in state store_unwritable (O-R5-6 J 2)', () => {
  it('rejects selectActive with PlanAccountNotSelectableError and the (G) 8 text', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    const installed = (await readRecord(h, 'work'))?.['generation'] as number;
    const store = failingWrites(h.store, (value) => {
      const record = JSON.parse(value) as { generation?: number; pendingRefresh?: unknown };
      return record.generation === installed + 1 && record.pendingRefresh === undefined ? errno('EACCES') : undefined;
    });
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }], store });
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    toRefreshWindow(h, START_MS);
    await source.read(new AbortController().signal);
    expect(source.status()).toMatchObject({ state: 'store_unwritable' });

    const selected = h.sessions.selectActive({ profile: PROFILE_ID, account: 'work' }, new AbortController().signal);
    await expect(selected).rejects.toBeInstanceOf(PlanAccountNotSelectableError);
    await expect(selected).rejects.toThrow('work has no verified sign-in to switch to. Sign in to it first.');
  });
});
