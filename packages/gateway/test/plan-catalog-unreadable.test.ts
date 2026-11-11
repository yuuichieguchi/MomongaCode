import { describe, expect, it } from 'vitest';
import { planProfileOf } from '@momonga/config';
import { createMemoryCredentialStore } from '@momonga/foundation';
import type { ListableCredentialStore } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { catalogKey, createPlanCatalog } from '../src/plan/catalog.ts';
import { fakeAuth } from './plan-auth-support.ts';
import { NEVER_ENDED, PROFILE_ID, START_MS, errno } from './plan-support.ts';

const profile = planProfileOf(PROFILE_ID);

const KEY = catalogKey(PROFILE_ID, 'work');

const boundSleep = (_ms: number, sleepSignal?: AbortSignal): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    sleepSignal?.addEventListener('abort', () => reject(sleepSignal.reason), { once: true });
  });

const listedBody = (slug: string): string => {
  const { listKey, idKey, labelKey, filter } = profile.catalog;
  return JSON.stringify({ [listKey]: [{ [idKey]: slug, [labelKey]: slug, [filter.field]: filter.equals, context_window: 200000 }] });
};

const setup = (wrap: (store: ListableCredentialStore) => ListableCredentialStore = (store) => store) => {
  const store = createMemoryCredentialStore();
  const fetched: string[] = [];
  let slug = 'first-model';
  const catalog = createPlanCatalog({
    store: wrap(store),
    clock: createFakeClock(START_MS),
    outbound: (_signal, use) =>
      use(async () => {
        fetched.push(slug);
        return new Response(listedBody(slug), { status: 200 });
      }),
    sleep: boundSleep,
  });
  const read = (refresh: boolean) => catalog.read({ profile, account: 'work', refresh, auth: fakeAuth(), signal: NEVER_ENDED });
  return {
    store,
    catalog,
    fetched,
    read,
    serve: (next: string) => {
      slug = next;
    },
  };
};

describe('the model list is fetched when its saved record cannot be read (N-CAT-1)', () => {
  it('refresh=1 over a record that is not valid JSON returns the fetched list and replaces the record', async () => {
    const { store, fetched, read } = setup();
    await store.write(KEY, '{"readAt": broken', NEVER_ENDED);
    const answer = await read(true);
    expect(answer.models.map((entry) => entry.slug)).toEqual(['first-model']);
    expect(fetched).toEqual(['first-model']);
    expect(JSON.parse((await store.read(KEY, NEVER_ENDED)) ?? '')).toMatchObject({ readAt: answer.readAt, models: { 'first-model': { contextWindow: 200000 } } });
  });

  it('refresh=1 does not read the saved record at all', async () => {
    const reads: string[] = [];
    const { read } = setup((store) => ({
      ...store,
      read: (key, signal) => {
        reads.push(key);
        return Promise.reject(errno('EIO'));
      },
    }));
    expect((await read(true)).models.map((entry) => entry.slug)).toEqual(['first-model']);
    expect(reads).toEqual([]);
  });

  it('without refresh, an answer in memory whose record can no longer be read falls back to the fetch, and the fetched list replaces the record', async () => {
    const { store, fetched, read, serve } = setup();
    await read(true);
    await store.write(KEY, 'not a record', NEVER_ENDED);
    serve('second-model');
    const answer = await read(false);
    expect(answer.models.map((entry) => entry.slug)).toEqual(['second-model']);
    expect(fetched).toEqual(['first-model', 'second-model']);
    expect(JSON.parse((await store.read(KEY, NEVER_ENDED)) ?? '')).toMatchObject({ models: { 'second-model': {} } });
  });

  it('without refresh, a fresh answer whose record is as it was written is served from memory', async () => {
    const { fetched, read } = setup();
    const first = await read(true);
    expect(await read(false)).toBe(first);
    expect(fetched).toEqual(['first-model']);
  });

  it('a read of the record ended by the asker is that end, not a fetch', async () => {
    const asker = new AbortController();
    const reason = new Error('the request ended');
    let failing = false;
    const { fetched, catalog, read } = setup((store) => ({
      ...store,
      read: (key, signal) => {
        if (!failing) return store.read(key, signal);
        asker.abort(reason);
        return Promise.reject(reason);
      },
    }));
    await read(true);
    failing = true;
    await expect(catalog.read({ profile, account: 'work', refresh: false, auth: fakeAuth(), signal: asker.signal })).rejects.toBe(reason);
    expect(fetched).toEqual(['first-model']);
  });
});
