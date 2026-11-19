import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialFileFor } from '@momonga/foundation';
import type { ListableCredentialStore } from '@momonga/foundation';
import { createFakeSecretStore } from '@momonga/testkit';
import { NEVER_ENDED, PROFILE_ID, START_MS, errno, failingWrites, readRecord, recordKey, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const WORK = { profile: PROFILE_ID, account: 'work' };
const OFFICE = 'office';

const isRecordOf = (value: string, account: string, pending: boolean): boolean => {
  const parsed = JSON.parse(value) as { account: string; renamingTo?: string };
  return parsed.account === account && (parsed.renamingTo !== undefined) === pending;
};

const failingRemoveOf = (inner: ListableCredentialStore, key: string): ListableCredentialStore => ({
  ...inner,
  remove: (name, signal) => (name === key ? Promise.reject(errno('EIO')) : inner.remove(name, signal)),
  withKey: (name, action, signal, holdsAfter) =>
    inner.withKey(
      name,
      (entry) => action({ ...entry, remove: () => (name === key ? Promise.reject(errno('EIO')) : entry.remove()) }),
      signal,
      holdsAfter,
    ),
});

const waitForLoad = async (h: Harness): Promise<void> => {
  await vi.waitFor(async () => {
    expect(await readRecord(h, 'work')).toBeUndefined();
  });
  expect(await readRecord(h, OFFICE)).toMatchObject({ account: OFFICE });
};

describe('renaming a plan account moves its record, its active pointer and nothing else, and a rename cut short by a failure completes at the next load', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('moves the stored account to the new label and keeps it active', async () => {
    harness = await startHarness();
    await signedIn(harness, 'work');
    await harness.sessions.selectActive(WORK, NEVER_ENDED);
    const renamed = await harness.sessions.rename(WORK, OFFICE, NEVER_ENDED);
    expect(renamed).toEqual({ profile: PROFILE_ID, account: OFFICE });
    expect(await readRecord(harness, 'work')).toBeUndefined();
    expect(await readRecord(harness, OFFICE)).toMatchObject({ account: OFFICE, state: 'active' });
    expect(harness.sessions.activeLabel(PROFILE_ID)).toBe(OFFICE);
    expect((await harness.sessions.known(NEVER_ENDED)).map((entry) => entry.account)).toEqual([OFFICE]);
  });

  it('refuses a label that is already saved before it writes anything', async () => {
    harness = await startHarness();
    await signedIn(harness, 'work');
    await signedIn(harness, OFFICE);
    const before = await readRecord(harness, 'work');
    await expect(harness.sessions.rename(WORK, OFFICE, NEVER_ENDED)).rejects.toThrow('office is already saved; choose another label');
    expect(await readRecord(harness, 'work')).toEqual(before);
  });

  it('a failure before the pending state is written leaves the account as it was', async () => {
    harness = await startHarness();
    await signedIn(harness, 'work');
    const sessions = await harness.reopen({ store: failingWrites(harness.store, (value) => (value.includes('"renamingTo"') ? errno('EIO') : undefined)) });
    await expect(sessions.rename(WORK, OFFICE, NEVER_ENDED)).rejects.toThrow();
    const reopened = await harness.reopen();
    await reopened.load(WORK, NEVER_ENDED);
    expect(await readRecord(harness, 'work')).toMatchObject({ account: 'work' });
    expect(await readRecord(harness, 'work')).not.toHaveProperty('renamingTo');
    expect(await readRecord(harness, OFFICE)).toBeUndefined();
  });

  it('a failure after the pending state is written completes forward at the next load', async () => {
    harness = await startHarness();
    await signedIn(harness, 'work');
    const sessions = await harness.reopen({ store: failingWrites(harness.store, (value) => (isRecordOf(value, OFFICE, false) ? errno('EIO') : undefined)) });
    await expect(sessions.rename(WORK, OFFICE, NEVER_ENDED)).rejects.toThrow();
    expect(await readRecord(harness, 'work')).toMatchObject({ renamingTo: OFFICE });
    const reopened = await harness.reopen();
    await reopened.load(WORK, NEVER_ENDED);
    await waitForLoad(harness);
  });

  it('a failure after the new record is written completes forward at the next load, with the pointer moved', async () => {
    harness = await startHarness();
    await signedIn(harness, 'work');
    await harness.sessions.selectActive(WORK, NEVER_ENDED);
    const sessions = await harness.reopen({ store: failingRemoveOf(harness.store, recordKey('work')) });
    await expect(sessions.rename(WORK, OFFICE, NEVER_ENDED)).rejects.toThrow();
    expect(await readRecord(harness, OFFICE)).toMatchObject({ account: OFFICE });
    const reopened = await harness.reopen();
    await reopened.load(WORK, NEVER_ENDED);
    await waitForLoad(harness);
    expect(reopened.activeLabel(PROFILE_ID)).toBe(OFFICE);
  });

  it('after a sign-out, a remaining account of the profile is still activated through the same route', async () => {
    harness = await startHarness();
    await signedIn(harness, 'work');
    await signedIn(harness, OFFICE);
    await harness.sessions.signOut(WORK, NEVER_ENDED);
    await harness.sessions.selectActive({ profile: PROFILE_ID, account: OFFICE }, NEVER_ENDED);
    expect(harness.sessions.activeLabel(PROFILE_ID)).toBe(OFFICE);
    expect(await readRecord(harness, OFFICE)).toMatchObject({ state: 'active' });
  });

  it('an account is one encrypted record file under its label: a rename writes the file under the new label, removes the old one and carries the tokens', async () => {
    harness = await startHarness({ secretStore: createFakeSecretStore({}) });
    await signedIn(harness, 'work');
    const before = await readRecord(harness, 'work');
    await harness.sessions.rename(WORK, OFFICE, NEVER_ENDED);
    const oldFile = credentialFileFor(harness.paths.sessions, recordKey('work'));
    const newFile = credentialFileFor(harness.paths.sessions, recordKey(OFFICE));
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.readFileSync(newFile, 'utf8')).not.toContain(String(before?.refresh_token));
    expect(await harness.store.read(recordKey('work'), NEVER_ENDED)).toBeUndefined();
    expect(await readRecord(harness, OFFICE)).toMatchObject({ account: OFFICE, refresh_token: before?.refresh_token, access_token: before?.access_token });
  });

  it('a refresh that finds a rename cut short completes it first and refreshes under the new label: one label remains, with the refreshed tokens', async () => {
    harness = await startHarness();
    await signedIn(harness, 'work');
    const before = await readRecord(harness, 'work');
    const sessions = await harness.reopen({ store: failingWrites(harness.store, (value) => (isRecordOf(value, OFFICE, false) ? errno('EIO') : undefined)) });
    await expect(sessions.rename(WORK, OFFICE, NEVER_ENDED)).rejects.toThrow();
    expect(await readRecord(harness, 'work')).toMatchObject({ renamingTo: OFFICE });
    const refreshing = await harness.reopen();
    toRefreshWindow(harness, START_MS);
    await refreshing.authSource(WORK).read(NEVER_ENDED);
    expect(harness.auth.calls.tokenRefreshToken).toBeGreaterThan(0);
    const after = await harness.reopen();
    expect((await after.known(NEVER_ENDED)).map((entry) => entry.account)).toEqual([OFFICE]);
    expect(await readRecord(harness, 'work')).toBeUndefined();
    const office = await readRecord(harness, OFFICE);
    expect(office).toMatchObject({ account: OFFICE, state: 'active' });
    expect(office).not.toHaveProperty('renamingTo');
    expect(office?.access_token).not.toBe(before?.access_token);
  });

  it('a failure of the active pointer write alone leaves the account under its old label, and the next load moves the pointer and finishes the rename', async () => {
    let armed = false;
    harness = await startHarness({
      wrapFileSystem: (base) => ({
        ...base,
        rename: (from, to) => {
          if (armed && to.endsWith('plan-active.json')) {
            armed = false;
            return Promise.reject(errno('EIO'));
          }
          return base.rename(from, to);
        },
      }),
    });
    await signedIn(harness, 'work');
    await harness.sessions.selectActive(WORK, NEVER_ENDED);
    armed = true;
    await expect(harness.sessions.rename(WORK, OFFICE, NEVER_ENDED)).rejects.toThrow();
    expect(harness.sessions.activeLabel(PROFILE_ID)).toBe('work');
    expect(await readRecord(harness, 'work')).toMatchObject({ renamingTo: OFFICE });
    const reopened = await harness.reopen();
    await reopened.load(WORK, NEVER_ENDED);
    await waitForLoad(harness);
    expect(reopened.activeLabel(PROFILE_ID)).toBe(OFFICE);
  });
});
