import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { credentialFileFor } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ACCOUNT, begin, browse, completeConfirmed, recordingLogger, sessionsDirectory, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway, RecordedEvent } from './plan-signin-support.ts';
import { PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const recordFile = (gateway: PlanGateway): string => credentialFileFor(sessionsDirectory(gateway.home), `plan/${PROFILE_ID}/${ACCOUNT}`);

const signInAgain = async (gateway: PlanGateway) => {
  const begun = await begin(gateway, { account: ACCOUNT });
  expect(begun.status).toBe(200);
  const callback = await browse(begun.body.authorizationUrl);
  return completeConfirmed(gateway, begun.body.attemptId, callback.toString());
};

const entryOf = async (gateway: PlanGateway): Promise<{ state: string; cause?: string } | undefined> => {
  const listed = await gateway.get(PLAN_ROUTES.accounts);
  return (listed.body.accounts as { label: string; state: string; cause?: string }[]).find((entry) => entry.label === ACCOUNT);
};

const withUnreadableRecord = async (plaintextTokenFiles: boolean, events: RecordedEvent[] = []): Promise<PlanGateway> => {
  const gateway = await startPlanGateway({ plaintextTokenFiles, logger: recordingLogger(events) });
  expect((await signInAgain(gateway)).body).toMatchObject({ outcome: 'signed_in' });
  await gateway.close();
  fs.writeFileSync(recordFile(gateway), '{ this is no record', { mode: 0o600 });
  fs.chmodSync(recordFile(gateway), 0o600);
  await gateway.restart();
  expect(await entryOf(gateway)).toMatchObject({ state: 'store_unreadable' });
  return gateway;
};

const STORES = [
  ['a record that does not parse', true],
  ['a record the encrypted store cannot open', false],
] as const;

describe('an account whose record cannot be read has a way forward (gateway-accounts C31, DECISION-3)', () => {
  it.for(STORES)('%s: sign-out forgets the record on this computer and reports that the revocation is not confirmed', async ([_name, plaintext]) => {
    const events: RecordedEvent[] = [];
    const gateway = await withUnreadableRecord(plaintext, events);
    events.length = 0;
    const signedOut = await gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: ACCOUNT });
    expect(signedOut.status).toBe(200);
    expect(signedOut.body).toMatchObject({ revocation: 'unconfirmed' });
    expect(fs.existsSync(recordFile(gateway))).toBe(false);
    expect(await entryOf(gateway)).toBeUndefined();
    expect(events.filter((event) => event.name === 'plan.sign_out').map((event) => event.data)).toMatchObject([{ account: ACCOUNT, end: 'cleared', revocation: 'unconfirmed' }]);
    expect((await signInAgain(gateway)).body).toMatchObject({ outcome: 'signed_in', account: { label: ACCOUNT, state: 'active' } });
    await gateway.close();
  });

  it.for(STORES)('%s: a sign-in with the same label replaces the record', async ([_name, plaintext]) => {
    const gateway = await withUnreadableRecord(plaintext);
    const completed = await signInAgain(gateway);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ outcome: 'signed_in', account: { label: ACCOUNT, state: 'active' } });
    expect(await entryOf(gateway)).toMatchObject({ state: 'active' });
    await gateway.close();
  });

  it('a readable record is not forgotten by the sign-out: it is signed out as before', async () => {
    const gateway = await startPlanGateway({ plaintextTokenFiles: true });
    expect((await signInAgain(gateway)).body).toMatchObject({ outcome: 'signed_in' });
    const signedOut = await gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: ACCOUNT });
    expect(signedOut.status).toBe(200);
    expect(fs.existsSync(recordFile(gateway))).toBe(true);
    expect(await entryOf(gateway)).toMatchObject({ state: 'registered' });
    await gateway.close();
  });
});
