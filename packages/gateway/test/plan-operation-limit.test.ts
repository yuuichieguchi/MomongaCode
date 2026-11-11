import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_READ_BOUND_MS, StoreCallEndedError, operationLimit } from '@momonga/foundation';
import type { ListableCredentialStore, SecretBackend } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { limitFailureOf } from '../src/plan/request-limit.ts';
import type { GatewayTimers } from '../src/types.ts';
import { registerCleanup } from './gateway-helpers.ts';
import { signIn, startPlanGateway } from './plan-signin-support.ts';
import { CONDITION_WAIT, NEVER_ENDED, PROFILE_ID, signedIn, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const work = { profile: PROFILE_ID, account: 'work' };

const REQUEST_LIMIT_MS = 300_000;

const BACKEND: SecretBackend = {
  label: 'Test Keyring',
  searchedProgram: 'test-keyring',
  childEnvNames: [],
  storeCommand: (name) => `test-keyring store ${name}`,
  unansweredAdvice: 'the Test Keyring may be waiting for an answer: unlock it',
  readiness: undefined,
  notFound: () => false,
};

const hangingReads = (inner: ListableCredentialStore): { store: ListableCredentialStore; hang: { on: boolean }; reads(): number } => {
  const hang = { on: false };
  let reads = 0;
  return {
    hang,
    reads: () => reads,
    store: {
      ...inner,
      read: (key, signal) => {
        if (!hang.on) return inner.read(key, signal);
        reads += 1;
        return new Promise<string | undefined>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    },
  };
};

describe('a waiter that leaves a shared load by its own limit gets the store call\'s sentence and the backend\'s advice (P-109)', () => {
  it('the first of two waiters ends at its limit while the load goes on for the other: its failure names the read of the key and the advice', async () => {
    const h = await startHarness({ storeBackend: BACKEND });
    harnesses.push(h);
    await signedIn(h, 'work');
    const hanging = hangingReads(h.store);
    await h.reopen({ store: hanging.store });
    hanging.hang.on = true;
    const staying = h.sessions.load(work, NEVER_ENDED).catch((error: unknown) => error);
    const limit = operationLimit(NEVER_ENDED, REQUEST_LIMIT_MS, 'the request limit', h.timing);
    const leaving = h.sessions.load(work, limit.signal).catch((error: unknown) => error);
    await expect.poll(() => hanging.reads(), CONDITION_WAIT).toBe(1);
    h.fireLimit(REQUEST_LIMIT_MS);
    const failure = await leaving;
    expect(failure).toBeInstanceOf(StoreCallEndedError);
    expect(limitFailureOf(failure)).toMatchObject({
      code: 'plan_credential_unavailable',
      message: 'the read of the key of the stored credentials did not finish within the request limit of 300000 ms; the Test Keyring may be waiting for an answer: unlock it',
    });
    expect(hanging.reads()).toBe(1);
    hanging.hang.on = false;
    await h.sessions.close();
    await staying;
  });
});

describe('every plan route runs under the one plan operation limit (P-106)', () => {
  it('a route whose store hangs ends at HOST_READ_BOUND_MS with the limit\'s text, while its client still waits', async () => {
    const held: Array<{ fire(): void }> = [];
    let capturing = false;
    const timers: GatewayTimers = {
      setTimeout: (callback, ms) => {
        if (!capturing || ms !== HOST_READ_BOUND_MS) return setTimeout(callback, ms);
        const entry = { fire: callback };
        held.push(entry);
        return entry;
      },
      clearTimeout: (handle) => {
        const index = held.indexOf(handle as { fire(): void });
        if (index === -1) clearTimeout(handle as NodeJS.Timeout);
        else held.splice(index, 1);
      },
      timeoutSignal: (ms) => AbortSignal.timeout(ms),
    };
    let hanging: ReturnType<typeof hangingReads> | undefined;
    const gateway = await startPlanGateway({
      timers,
      planStore: (store) => {
        hanging = hangingReads(store);
        return hanging.store;
      },
    });
    registerCleanup(() => gateway.close());
    await signIn(gateway);
    if (hanging === undefined) throw new Error('the plan store was not wrapped');
    hanging.hang.on = true;
    capturing = true;
    const answer = gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: 'other' });
    await expect.poll(() => hanging?.reads(), CONDITION_WAIT).toBe(1);
    await expect.poll(() => held.length, CONDITION_WAIT).toBeGreaterThan(0);
    capturing = false;
    for (const entry of held.splice(0)) entry.fire();
    const { status, body } = await answer;
    expect(body.error).toMatchObject({ code: 'plan_credential_unavailable', message: `the sign-in record store did not finish within the plan operation limit of ${HOST_READ_BOUND_MS} ms` });
    expect(status).toBeGreaterThanOrEqual(400);
    hanging.hang.on = false;
  });
});
