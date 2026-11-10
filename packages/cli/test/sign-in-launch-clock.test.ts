import { describe, expect, it, vi } from 'vitest';
import { AUTHORIZATION_WAIT_MS } from '@momonga/foundation';
import type { OpenUrl } from '@momonga/foundation';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { authLogin } from '../src/commands/auth.ts';
import type { AuthLoginPorts } from '../src/commands/auth.ts';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import { AUTHORIZATION_URL, CHATGPT, LISTENER_PORT, PLAN_TEST_TIMEOUT_MS, account, eventually } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

type Launch = { url: URL; watch: AbortSignal | undefined; onFailure: ((message: string) => void) | undefined };

const writer = () => {
  const written: string[] = [];
  return { write: (text: string) => void written.push(text), text: () => written.join('') };
};

const harness = (openUrl: (launches: Launch[]) => OpenUrl) => {
  const routes: string[] = [];
  const launches: Launch[] = [];
  let arrive: (url: URL) => void = () => undefined;
  const arrived = new Promise<URL>((resolve) => {
    arrive = resolve;
  });
  const plan = {
    accounts: async () => {
      routes.push('accounts');
      return { profiles: [CHATGPT], accounts: [] };
    },
    signInBegin: async () => {
      routes.push('sign-in/begin');
      return { attemptId: 'attempt-1', authorizationUrl: AUTHORIZATION_URL, state: 'st-1', expiresAt: '2026-11-10T00:05:00.000Z' };
    },
    signInComplete: async () => {
      routes.push('sign-in/complete');
      return { outcome: 'signed_in', account: account({ label: 'work' }), firstSignIn: false };
    },
    signInCancel: async () => {
      routes.push('sign-in/cancel');
    },
  } as unknown as PlanGatewayClient;
  const timers = createFakeTimers(createFakeClock(1_800_000_000_000));
  const stdout = writer();
  const stderr = writer();
  const interrupt = new AbortController();
  const ports = {
    stdout,
    stderr,
    plan,
    startListener: async (path: string) => ({
      port: LISTENER_PORT,
      redirectUrl: `http://127.0.0.1:${LISTENER_PORT}${path}`,
      callback: ({ signal }: { state: string; signal: AbortSignal }) =>
        new Promise<URL>((resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          void arrived.then(resolve);
        }),
      close: async () => undefined,
    }),
    openUrl: openUrl(launches),
    sandbox: async () => 'seatbelt' as const,
    signal: interrupt.signal,
    timers,
    isTerminal: false as const,
  } as unknown as AuthLoginPorts;
  return { routes, launches, timers, stdout, stderr, ports, arrive };
};

const tracked = (promise: Promise<number>) => {
  let code: number | undefined;
  let failure: unknown;
  promise.then(
    (value) => void (code = value),
    (error: unknown) => void (failure = error),
  );
  return { code: () => code, failure: () => failure };
};

describe('the sign-in clock and the browser launch (P-C7)', () => {
  it('the 300 s clock fires while the launcher never ends', async () => {
    const h = harness(
      (launches) =>
        ((url: URL, watch?: AbortSignal, onFailure?: (message: string) => void) => {
          launches.push({ url, watch, onFailure });
          return new Promise<void>(() => undefined);
        }) as unknown as OpenUrl,
    );
    const exit = tracked(authLogin(h.ports, { provider: 'chatgpt', account: 'work' }));
    await eventually(() => h.routes.includes('sign-in/begin') && h.launches.length === 1, 'the sign-in to begin and the browser to be started');
    h.timers.advance(AUTHORIZATION_WAIT_MS);
    await eventually(() => exit.code() !== undefined, 'the command to exit after the clock fired');
    expect(exit.code()).toBe(1);
    expect(h.stderr.text()).toBe('Sign-in was not completed within 300 seconds. Run momonga auth login chatgpt --account work to try again.\n');
    expect(h.routes.filter((route) => route === 'sign-in/cancel')).toHaveLength(1);
    expect(h.launches[0]?.watch?.aborted).toBe(true);
  });

  it('the watch signal handed to the launch aborts when the first value arrives', async () => {
    const h = harness(
      (launches) =>
        ((url: URL, watch?: AbortSignal, onFailure?: (message: string) => void) => {
          launches.push({ url, watch, onFailure });
          return Promise.resolve();
        }) as unknown as OpenUrl,
    );
    const exit = tracked(authLogin(h.ports, { provider: 'chatgpt', account: 'work' }));
    await eventually(() => h.routes.includes('sign-in/begin') && h.launches.length === 1, 'the sign-in to begin and the browser to be started');
    h.arrive(new URL(`http://127.0.0.1:${LISTENER_PORT}/auth/callback?code=code-1&state=st-1`));
    await eventually(() => exit.code() !== undefined || exit.failure() !== undefined, 'the command to end');
    expect(exit.failure()).toBeUndefined();
    expect(exit.code()).toBe(0);
    expect(h.launches[0]?.watch).toBeInstanceOf(AbortSignal);
    expect(h.launches[0]?.watch?.aborted).toBe(true);
  });
});
