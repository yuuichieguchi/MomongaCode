import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import type { ListableCredentialStore } from '@momonga/foundation';
import { PLAN_SIGN_IN_DEFAULTS } from '../src/defaults.ts';
import { createGenerationFlight } from '../src/plan/generation-flight.ts';
import { createPlanSignIn } from '../src/plan/signin.ts';
import { NEVER_ENDED, PROFILE_ID, planError, realSleep, recordKey, signInAtFake, startHarness } from './plan-support.ts';
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

const ghost = { profile: PROFILE_ID, account: 'ghost' };

const countingReads = (inner: ListableCredentialStore): { store: ListableCredentialStore; reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    store: {
      ...inner,
      read: (key, signal) => {
        reads.push(key);
        return inner.read(key, signal);
      },
    },
  };
};

describe('the forced refresh of an account is held for the current generation only (GR-state ST-1, ST-2)', () => {
  it('a forced refresh started at each of three generations leaves the entry of the third only', () => {
    const forced = createGenerationFlight<string>();
    forced.start(1, 'first');
    forced.start(2, 'second');
    forced.start(3, 'third');
    expect(forced.held()).toEqual([3]);
    expect(forced.at(1)).toBeUndefined();
    expect(forced.at(2)).toBeUndefined();
    expect(forced.at(3)).toBe('third');
  });

  it('a record adopted at a newer generation ends the entry of the generation before', () => {
    const forced = createGenerationFlight<string>();
    forced.start(1, 'first');
    forced.keepFor(1);
    expect(forced.held()).toEqual([1]);
    forced.keepFor(2);
    expect(forced.held()).toEqual([]);
  });

  it('an abandoned flight leaves no entry, and another flight is not removed by it', () => {
    const forced = createGenerationFlight<string>();
    forced.start(1, 'first');
    forced.abandon('other');
    expect(forced.held()).toEqual([1]);
    forced.abandon('first');
    expect(forced.held()).toEqual([]);
  });
});

describe('an account made for a label with no record is not kept after the operation that asked (GR-state ST-3)', () => {
  it('registration of an unsigned label reads the store at each call, and sees a record another process wrote in between', async () => {
    const h = await harness();
    const counting = countingReads(h.store);
    await h.reopen({ store: counting.store });
    expect(await h.sessions.registration(ghost, NEVER_ENDED)).toBeUndefined();
    expect(await h.sessions.registration(ghost, NEVER_ENDED)).toBeUndefined();
    expect(counting.reads.filter((key) => key === recordKey('ghost'))).toHaveLength(2);
    const signIn = await signInAtFake(h);
    await h.store.write(
      recordKey('ghost'),
      JSON.stringify({ version: 1, profile: PROFILE_ID, account: 'ghost', state: 'registered', client_id: signIn.clientId, ext_agent_host_id: signIn.hostId, welcomeShown: false }),
      NEVER_ENDED,
    );
    expect((await h.sessions.registration(ghost, NEVER_ENDED))?.clientId).toBe(signIn.clientId);
  });

  it('a request on an unsigned pinned account reads the store at each request and the account is not listed', async () => {
    const h = await harness();
    const counting = countingReads(h.store);
    await h.reopen({ store: counting.store });
    const source = h.sessions.authSource(ghost);
    expect((await planError(source.read(NEVER_ENDED))).code).toBe('sign_in_required');
    expect((await planError(source.read(NEVER_ENDED))).code).toBe('sign_in_required');
    expect(counting.reads.filter((key) => key === recordKey('ghost'))).toHaveLength(2);
    expect(source.status().state).toBe('absent');
    expect(await h.sessions.known(NEVER_ENDED)).toEqual([]);
  });
});

describe('an expired sign-in attempt is removed at every begin, waiting and complete (GR-state R-7, E-5, E-6)', () => {
  const PORT = 49152;

  const setup = async () => {
    const h = await harness();
    const signIn = createPlanSignIn({
      profiles: { [PROFILE_ID]: h.profile },
      sessions: h.sessions,
      clock: h.clock,
      outbound: (signal, use) => {
        signal.throwIfAborted();
        return use((url, init) => fetch(url, init));
      },
      lifetime: h.sessions.lifetime,
      sleep: realSleep,
      fileSystem: nodeFileSystem,
      hostFile: h.paths.host,
    });
    const begin = (account: string) => signIn.begin({ profile: PROFILE_ID, account, port: PORT }, NEVER_ENDED);
    return { h, signIn, begin };
  };

  it('waiting() removes an expired attempt: cancelling it afterwards finds nothing', async () => {
    const { h, signIn, begin } = await setup();
    const begun = await begin('work');
    h.clock.advance(PLAN_SIGN_IN_DEFAULTS.attemptTtlMs);
    expect(signIn.waiting()).toBe(false);
    expect(signIn.cancel(begun.attemptId)).toBe(false);
  });

  it('begin() for another account removes an expired attempt', async () => {
    const { h, signIn, begin } = await setup();
    const begun = await begin('work');
    h.clock.advance(PLAN_SIGN_IN_DEFAULTS.attemptTtlMs);
    const second = await begin('home');
    expect(signIn.cancel(begun.attemptId)).toBe(false);
    expect(signIn.cancel(second.attemptId)).toBe(true);
  });

  it('complete() of an expired attempt answers attempt_expired and removes the other expired attempts', async () => {
    const { h, signIn, begin } = await setup();
    const first = await begin('work');
    const second = await begin('home');
    h.clock.advance(PLAN_SIGN_IN_DEFAULTS.attemptTtlMs);
    await expect(signIn.complete(first.attemptId, 'http://127.0.0.1:49152/auth/callback', NEVER_ENDED)).rejects.toMatchObject({ body: { code: 'attempt_expired' } });
    expect(signIn.cancel(second.attemptId)).toBe(false);
  });

  it('an attempt that has not expired stays', async () => {
    const { h, signIn, begin } = await setup();
    const begun = await begin('work');
    h.clock.advance(PLAN_SIGN_IN_DEFAULTS.attemptTtlMs - 1);
    expect(signIn.waiting()).toBe(true);
    expect(signIn.cancel(begun.attemptId)).toBe(true);
  });
});
