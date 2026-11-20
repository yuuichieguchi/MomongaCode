import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHORIZATION_WAIT_MS, systemTiming } from '@momonga/foundation';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import { authLogin } from '../src/commands/auth.ts';
import type { AuthLoginPorts } from '../src/commands/auth.ts';
import * as signInModule from '../src/plan/sign-in.ts';
import { SignInExpiredError, loopbackSignInListener, signIn } from '../src/plan/sign-in.ts';
import { untilFrame, untilOutput } from './ink-helpers.ts';
import { AUTHORIZATION_URL, CHATGPT, PLAN_TEST_TIMEOUT_MS, choose, eventually, startPlan, submitLine, untilPromptDrawn, untilTypedAfter } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';
import { failWaitingListener, listenerClock, resetScriptedLoopback } from './scripted-loopback-redirect.ts';

vi.mock('@momonga/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@momonga/foundation')>();
  const { scriptedLoopbackStart } = await import('./scripted-loopback-redirect.ts');
  return { ...actual, startLoopbackRedirect: scriptedLoopbackStart(actual.OAuthAuthorizationError) };
});

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const START_MS = 1_800_000_000_000;
const WAIT_MS = 300_000;
const EXPIRY = 'Sign-in was not completed within 300 seconds.';
const LISTENER_FAILED = 'The local sign-in listener failed (socket reset). The sign-in was cancelled.';
const PASTE_LABEL = 'On a remote machine? Paste the redirect URL here';

afterEach(() => {
  resetScriptedLoopback();
});

type Call = { route: string; body?: unknown };

const gateway = () => {
  const calls: Call[] = [];
  const plan = {
    accounts: async () => {
      calls.push({ route: 'accounts' });
      return { profiles: [CHATGPT], accounts: [] };
    },
    signInBegin: async (request: unknown) => {
      calls.push({ route: 'sign-in/begin', body: request });
      return { attemptId: 'attempt-1', authorizationUrl: AUTHORIZATION_URL, state: 'st-1', expiresAt: '2026-11-10T00:05:00.000Z' };
    },
    signInComplete: async (request: unknown) => {
      calls.push({ route: 'sign-in/complete', body: request });
      throw new Error('the sign-in must not complete');
    },
    signInCancel: async (request: unknown) => {
      calls.push({ route: 'sign-in/cancel', body: request });
    },
  } as unknown as PlanGatewayClient;
  const cancels = (): Call[] => calls.filter((call) => call.route === 'sign-in/cancel');
  return { calls, plan, cancels };
};

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const untilListenerWaits = (): Promise<void> => eventually(() => listenerClock.pendingDelays().length === 1, 'the listener to wait for the callback');

const startSignIn = () => {
  const fake = gateway();
  const signInTimers = createFakeTimers(createFakeClock(START_MS));
  const outcome = signIn(
    {
      plan: fake.plan,
      startListener: loopbackSignInListener(systemTiming, new AbortController().signal),
      authorize: async () => undefined,
      confirmIdentity: async () => false,
      warn: () => undefined,
      pasted: (_state, signal) => waitForAbort(signal),
      signal: new AbortController().signal,
      timers: signInTimers,
    },
    { profile: 'chatgpt', account: 'work', reconsent: false },
  );
  outcome.catch(() => undefined);
  return { ...fake, signInTimers, outcome };
};

const failure = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the sign-in to fail');
};

const listenerFailedClass = (): unknown => (signInModule as Record<string, unknown>)['SignInListenerFailedError'];

describe('one wait, one clock: the listener backstop and the timer of signIn give the same error (O-R5-6 J 4)', () => {
  it('the listener asks for its backstop of AUTHORIZATION_WAIT_MS while signIn holds its own timer of the same length', async () => {
    const started = startSignIn();
    await untilListenerWaits();
    expect(listenerClock.pendingDelays()).toEqual([AUTHORIZATION_WAIT_MS]);
    expect(started.signInTimers.pending().map((timer) => timer.delayMs)).toEqual([WAIT_MS]);
    listenerClock.fireAll();
    await failure(started.outcome);
  });

  it('the listener timed_out firing before the timer of signIn yields SignInExpiredError with the expiry text, and cancels the attempt once', async () => {
    const started = startSignIn();
    await untilListenerWaits();
    listenerClock.fireAll();
    const error = await failure(started.outcome);
    expect(error).toBeInstanceOf(SignInExpiredError);
    expect(error.message).toBe(EXPIRY);
    expect(started.cancels()).toEqual([{ route: 'sign-in/cancel', body: { attemptId: 'attempt-1' } }]);
    expect(started.calls.map((call) => call.route)).not.toContain('sign-in/complete');
  });
});

describe('a listener that fails during the wait is a failure of the sign-in (O-R5-6 J 5, I 6)', () => {
  it('yields SignInListenerFailedError with the listener-failed text and cancels the attempt exactly once', async () => {
    const started = startSignIn();
    await untilListenerWaits();
    failWaitingListener(new Error('socket reset'));
    const error = await failure(started.outcome);
    expect(typeof listenerFailedClass()).toBe('function');
    expect(error).toBeInstanceOf(listenerFailedClass() as new (...args: never[]) => Error);
    expect(error.name).toBe('SignInListenerFailedError');
    expect(error.message).toBe(LISTENER_FAILED);
    expect(started.cancels()).toEqual([{ route: 'sign-in/cancel', body: { attemptId: 'attempt-1' } }]);
  });
});

type Writer = { write(text: string): void; text(): string };

const writer = (): Writer => {
  const written: string[] = [];
  return { write: (text) => void written.push(text), text: () => written.join('') };
};

const startLogin = () => {
  const fake = gateway();
  const stdout = writer();
  const stderr = writer();
  const timers = createFakeTimers(createFakeClock(START_MS));
  const ports: AuthLoginPorts = {
    stdout,
    stderr,
    plan: fake.plan,
    startListener: loopbackSignInListener(systemTiming, new AbortController().signal),
    openUrl: () => Promise.resolve(),
    sandbox: async () => 'seatbelt' as const,
    signal: new AbortController().signal,
    timers,
    isTerminal: false,
  };
  const exit = authLogin(ports, { provider: 'chatgpt', account: 'work' });
  exit.catch(() => undefined);
  return { ...fake, stdout, stderr, timers, exit };
};

describe('momonga auth login prints the outcome of either clock and of a listener failure (O-R5-6 J 4, J 5)', () => {
  it('prints the (A) expiry line and exits 1 when the listener backstop fires first', async () => {
    const login = startLogin();
    await untilListenerWaits();
    listenerClock.fireAll();
    expect(await login.exit).toBe(1);
    expect(login.stderr.text()).toContain(`${EXPIRY} Run momonga auth login chatgpt --account work to try again.\n`);
    expect(login.cancels()).toHaveLength(1);
  });

  it('prints the listener-failed text on stderr and exits 1, with the attempt cancelled exactly once', async () => {
    const login = startLogin();
    await untilListenerWaits();
    failWaitingListener(new Error('socket reset'));
    expect(await login.exit).toBe(1);
    expect(login.stderr.text()).toContain(`${LISTENER_FAILED}\n`);
    expect(login.cancels()).toEqual([{ route: 'sign-in/cancel', body: { attemptId: 'attempt-1' } }]);
  });
});

const routesOf = (backend: FakePlanBackend): string[] => backend.planCalls.map((call) => call.route);

const tuiWaitingScreen = async (options: Parameters<typeof startPlan>[0]) => {
  const started = await startPlan({ accounts: [], ...options });
  await untilFrame(started.app, 'mode: manual');
  await submitLine(started.app, '/login chatgpt');
  await untilFrame(started.app, PASTE_LABEL);
  return started;
};

describe('the TUI prints the outcome of the wait as an info line (O-R5-6 J 3, J 5)', () => {
  it('takes the wait bound from signInTimers of the backend and prints the TUI expiry line, with the attempt cancelled once', async () => {
    const signInTimers = createFakeTimers(createFakeClock(START_MS));
    const { app, backend } = await tuiWaitingScreen({ callbackArrives: false, signInTimers });
    expect(signInTimers.pending().map((timer) => timer.delayMs)).toEqual([WAIT_MS]);
    signInTimers.advance(WAIT_MS);
    await untilOutput(app, 'Sign-in was not completed within 300 seconds. Run /login to try again.');
    await untilPromptDrawn(app);
    await untilTypedAfter(app);
    expect(routesOf(backend).filter((route) => route === 'sign-in/cancel')).toHaveLength(1);
    expect(routesOf(backend)).not.toContain('sign-in/complete');
    app.unmount();
  });

  it('prints the listener-failed text as an info line, with the attempt cancelled exactly once', async () => {
    const signInTimers = createFakeTimers(createFakeClock(START_MS));
    const { app, backend } = await tuiWaitingScreen({ startListener: loopbackSignInListener(systemTiming, new AbortController().signal), signInTimers });
    await untilListenerWaits();
    failWaitingListener(new Error('socket reset'));
    await untilOutput(app, LISTENER_FAILED);
    await untilPromptDrawn(app);
    await untilTypedAfter(app);
    expect(routesOf(backend).filter((route) => route === 'sign-in/cancel')).toHaveLength(1);
    app.unmount();
  });
});

const orderedSignIn = (winner: 'listener' | 'paste' | 'none') => {
  const order: string[] = [];
  const signInTimers = createFakeTimers(createFakeClock(START_MS));
  const redirectUrl = 'http://127.0.0.1:49152/auth/callback';
  const plan = {
    signInBegin: async () => ({ attemptId: 'attempt-1', authorizationUrl: AUTHORIZATION_URL, state: 'st-1', expiresAt: '2026-11-10T00:05:00.000Z' }),
    signInComplete: async () => {
      order.push('complete');
      return { outcome: 'signed_in', account: { profile: 'chatgpt', label: 'work', state: 'active', active: true, pinnedBy: [] }, firstSignIn: false };
    },
    signInCancel: async () => {
      order.push('cancel');
    },
  } as unknown as PlanGatewayClient;
  const ports = {
    plan,
    startListener: async () => ({
      port: 49152,
      redirectUrl,
      callback: ({ signal }: { state: string; signal: AbortSignal }) =>
        winner === 'listener' ? Promise.resolve(new URL(`${redirectUrl}?code=code-1&state=st-1`)) : waitForAbort(signal),
      close: async () => undefined,
    }),
    authorize: async () => undefined,
    confirmIdentity: async () => false,
    warn: () => undefined,
    pasted: (_state: string, signal: AbortSignal) => (winner === 'paste' ? Promise.resolve('https://elsewhere.example/x?code=pasted&state=st-1') : waitForAbort(signal)),
    signal: new AbortController().signal,
    timers: signInTimers,
    delivered: () => void order.push('delivered'),
  };
  const outcome = signIn(ports, { profile: 'chatgpt', account: 'work', reconsent: false });
  outcome.catch(() => undefined);
  return { order, signInTimers, outcome };
};

describe('signIn tells its caller when a value is delivered (P-C2)', () => {
  it.each(['listener', 'paste'] as const)('signIn calls delivered once for either source, before complete (%s wins)', async (winner) => {
    const started = orderedSignIn(winner);
    await started.outcome;
    expect(started.order).toEqual(['delivered', 'complete']);
  });

  it('delivered is not called when the wait fails', async () => {
    const started = orderedSignIn('none');
    await eventually(() => started.signInTimers.pending().length === 1, 'the wait to start its clock');
    started.signInTimers.advance(WAIT_MS);
    const error = await failure(started.outcome);
    expect(error).toBeInstanceOf(SignInExpiredError);
    expect(started.order).toEqual(['cancel']);
  });
});
