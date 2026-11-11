import { afterEach, describe, expect, it } from 'vitest';
import type { ListableCredentialStore } from '@momonga/foundation';
import { NEVER_ENDED, PROFILE_ID, readRecord, recordKey, signedIn, startHarness, writeSigningOut } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const work = { profile: PROFILE_ID, account: 'work' };

type HeldRead = { store: ListableCredentialStore; reached: Promise<void>; release(): void; order: string[] };

const holdingReads = (inner: ListableCredentialStore, key: string): HeldRead => {
  const order: string[] = [];
  let arrive = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    order,
    reached,
    release,
    store: {
      ...inner,
      read: async (asked, signal) => {
        if (asked !== key) return inner.read(asked, signal);
        arrive();
        await released;
        order.push('read ended');
        return inner.read(asked, NEVER_ENDED);
      },
    },
  };
};

const nextTurn = (): Promise<'still waiting'> => new Promise((resolve) => setImmediate(() => resolve('still waiting')));

describe('close() of the plan sessions waits for every load in flight (P-108)', () => {
  it('a load whose store read outlives the close: close() resolves after the read ended, the load adopts nothing and resumes no sign-out', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    await writeSigningOut(h, 'work');
    const held = holdingReads(h.store, recordKey('work'));
    await h.reopen({ store: held.store });
    h.events.length = 0;
    const loading = h.sessions.load(work, NEVER_ENDED).then(
      () => 'loaded',
      (error: unknown) => error,
    );
    await held.reached;
    const closing = h.sessions.close().then(() => {
      held.order.push('closed');
      return 'closed' as const;
    });
    expect(await Promise.race([closing, nextTurn()])).toBe('still waiting');
    held.release();
    expect(await closing).toBe('closed');
    expect(held.order).toEqual(['read ended', 'closed']);
    expect(await loading).toBe(h.sessions.lifetime.reason);
    expect(h.events).toEqual([]);
    expect((await readRecord(h, 'work'))?.['state']).toBe('signing_out');
    expect(h.fetchUrls.filter((url) => url === h.auth.revokeUrl)).toEqual([]);
  });

  it('a load whose only asker left before the close is still waited for', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    const held = holdingReads(h.store, recordKey('work'));
    await h.reopen({ store: held.store });
    const asker = new AbortController();
    const loading = h.sessions.load(work, asker.signal).catch((error: unknown) => error);
    await held.reached;
    asker.abort(new Error('the asker left'));
    await loading;
    const closing = h.sessions.close().then(() => 'closed' as const);
    expect(await Promise.race([closing, nextTurn()])).toBe('still waiting');
    held.release();
    expect(await closing).toBe('closed');
  });
});
