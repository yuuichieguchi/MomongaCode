import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_NAME_PATTERN, createMemoryCredentialStore } from '@momonga/foundation';
import type { ListableCredentialStore } from '@momonga/foundation';
import { GatewayError } from '../src/core/errors.ts';
import { planRouteError } from '../src/plan/api.ts';
import { catalogKey, createPlanCatalog } from '../src/plan/catalog.ts';
import { fakeAuth } from './plan-auth-support.ts';
import { PROFILE_ID, editRecord, recordFileOf, recordKey, signedIn, startHarness } from './plan-support.ts';
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

const work = { profile: PROFILE_ID, account: 'work' };

const signal = (): AbortSignal => new AbortController().signal;

const LISTED_FILE = 'listed-record.json';

const KEY_PROBLEM = 'the record key does not name a plan account';

type ListingStore = { store: ListableCredentialStore; reads: string[] };

const listingOnly = (inner: ListableCredentialStore, key: string): ListingStore => {
  const reads: string[] = [];
  return {
    reads,
    store: {
      read: (asked) => {
        reads.push(asked);
        return inner.read(asked, new AbortController().signal);
      },
      remove: (asked) => inner.remove(asked, new AbortController().signal),
      write: (asked, value) => inner.write(asked, value, new AbortController().signal),
      update: (asked, change) => inner.update(asked, change, new AbortController().signal),
      withKey: (asked, action) => inner.withKey(asked, action, new AbortController().signal),
      listKeys: async () => ({ keys: [{ key, file: LISTED_FILE }], problems: [] }),
    },
  };
};

describe('a listed record key names a plan account only when its profile and account have the label shape (K3b)', () => {
  it.for([
    { name: 'an account with a space', key: `plan/${PROFILE_ID}/leaked label`, shown: 'leaked label' },
    { name: 'an account with a leading dot', key: `plan/${PROFILE_ID}/.leaked-label`, shown: '.leaked-label' },
    { name: 'an account of 129 characters', key: `plan/${PROFILE_ID}/${'q'.repeat(129)}`, shown: 'q'.repeat(129) },
    { name: 'a profile with a space', key: 'plan/leaked profile/work', shown: 'leaked profile' },
  ])('a key with $name is a record problem that quotes nothing of the key and is not loaded as an account', async ({ key, shown }) => {
    const h = await harness();
    const listing = listingOnly(h.store, key);
    await h.reopen({ store: listing.store });
    expect(h.sessions.listProblems()).toEqual([{ file: LISTED_FILE, cause: KEY_PROBLEM }]);
    expect(h.warnings).toContain(`could not list ${LISTED_FILE}: ${KEY_PROBLEM}`);
    expect(h.warnings.filter((warning) => warning.includes(shown))).toEqual([]);
    expect(await h.sessions.known(new AbortController().signal)).toEqual([]);
    expect(listing.reads).toEqual([]);
  });

  it('a key whose profile and account have the label shape is loaded as an account', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const listing = listingOnly(h.store, `plan/${PROFILE_ID}/work`);
    await h.reopen({ store: listing.store });
    expect(h.sessions.listProblems()).toEqual([]);
    expect((await h.sessions.known(new AbortController().signal)).map((account) => ({ profile: account.profile, account: account.account }))).toEqual([work]);
  });
});

const BROKEN_TOKEN = 'leaked-file-text';

const BROKEN_JSON = `{"a":${BROKEN_TOKEN}}`;

type Shown = { status: unknown; warnings: string[]; listProblems: unknown; failure: { code: unknown; message: unknown }; body: unknown };

const shownFor = async (h: Harness): Promise<Shown> => {
  await h.reopen({ accounts: [work] });
  const source = h.sessions.authSource(work);
  const error = await source.read(signal()).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  const translated = planRouteError(error);
  return {
    status: source.status(),
    warnings: [...h.warnings],
    listProblems: h.sessions.listProblems(),
    failure: { code: (error as { code?: unknown } | undefined)?.code, message: (error as { message?: unknown } | undefined)?.message },
    body: translated instanceof GatewayError ? translated.body : undefined,
  };
};

const STORED: ReadonlyArray<{ name: string; change: Record<string, unknown>; shown: string; text: string }> = [
  { name: 'an account that does not match the label pattern', change: { account: 'leaked label' }, shown: 'leaked label', text: `the plan record names an account that does not match ${SECRET_NAME_PATTERN}` },
  { name: 'a profile that does not match the label pattern', change: { profile: 'leaked profile' }, shown: 'leaked profile', text: `the plan record names a profile that does not match ${SECRET_NAME_PATTERN}` },
  { name: 'an unknown state', change: { state: 'leaked-state' }, shown: 'leaked-state', text: 'the plan record has an unknown state' },
  { name: 'another version', change: { version: 73_519 }, shown: '73519', text: 'the plan record has a version this build does not read; it reads version 1' },
];

describe('a stored plan record that is refused is described by its file and field, never by a value read from it (K3b)', () => {
  it.for(STORED)('a record with $name is refused with the text of the rule in the status, the warning, the list problems and the error body', async ({ change, shown, text }) => {
    const h = await harness();
    await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, ...change }));
    const seen = await shownFor(h);
    expect(seen.status).toEqual({ state: 'store_unreadable', cause: text });
    expect(seen.warnings).toContain(`the plan session of ${PROFILE_ID} account work cannot be read: ${text}`);
    expect(seen.listProblems).toEqual([{ file: path.basename(recordFileOf(h, 'work')), cause: text }]);
    expect(seen.failure).toEqual({ code: 'plan_store_unreadable', message: text });
    expect(seen.body).toEqual({ type: 'server_error', code: 'plan_store_unreadable', message: text, param: null });
    expect(JSON.stringify(seen)).not.toContain(shown);
  });

  it('a record that is not valid JSON is refused with a text that holds no fragment of the file', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await h.store.write(recordKey('work'), BROKEN_JSON, new AbortController().signal);
    const text = 'the plan record is not valid JSON';
    const seen = await shownFor(h);
    expect(seen.status).toEqual({ state: 'store_unreadable', cause: text });
    expect(seen.warnings).toContain(`the plan session of ${PROFILE_ID} account work cannot be read: ${text}`);
    expect(seen.listProblems).toEqual([{ file: path.basename(recordFileOf(h, 'work')), cause: text }]);
    expect(seen.failure).toEqual({ code: 'plan_store_unreadable', message: text });
    expect(seen.body).toEqual({ type: 'server_error', code: 'plan_store_unreadable', message: text, param: null });
    expect(JSON.stringify(seen)).not.toContain(BROKEN_TOKEN);
  });
});

describe('a stored plan catalog record that is refused does not quote the entry it refuses (K3b)', () => {
  it('a catalog record that is not valid JSON is refused as plan_store_unreadable with a text that holds no fragment of the record', async () => {
    const h = await harness();
    const store = createMemoryCredentialStore();
    await store.write(catalogKey(PROFILE_ID, 'work'), BROKEN_JSON, new AbortController().signal);
    const catalog = createPlanCatalog({
      store,
      clock: h.clock,
      outbound: () => Promise.reject(new Error('the stored record is refused before any send')),
      sleep: () => Promise.resolve(),
    });
    const failure = await catalog.read({ profile: h.profile, account: 'work', refresh: false, auth: fakeAuth(), signal: signal() }).then(
      () => undefined,
      (error: unknown) => error as { code?: unknown; message?: unknown },
    );
    expect({ code: failure?.code, message: failure?.message }).toEqual({
      code: 'plan_store_unreadable',
      message: `the plan model list of ${PROFILE_ID} account work cannot be read: the plan catalog record is not valid JSON`,
    });
    expect(String(failure?.message)).not.toContain(BROKEN_TOKEN);
  });

  it('an unrecognised entry is refused as plan_store_unreadable without the slug read from the record', async () => {
    const h = await harness();
    const store = createMemoryCredentialStore();
    await store.write(catalogKey(PROFILE_ID, 'work'), JSON.stringify({ readAt: new Date(h.clock.now()).toISOString(), models: { 'leaked-slug': { contextWindow: 'wide' } } }), new AbortController().signal);
    const catalog = createPlanCatalog({
      store,
      clock: h.clock,
      outbound: () => Promise.reject(new Error('the stored record is refused before any send')),
      sleep: () => Promise.resolve(),
    });
    const failure = await catalog.read({ profile: h.profile, account: 'work', refresh: false, auth: fakeAuth(), signal: signal() }).then(
      () => undefined,
      (error: unknown) => error as { code?: unknown; message?: unknown },
    );
    expect({ code: failure?.code, message: failure?.message }).toEqual({
      code: 'plan_store_unreadable',
      message: `the plan model list of ${PROFILE_ID} account work cannot be read: the plan catalog record has an unrecognised entry`,
    });
  });
});
