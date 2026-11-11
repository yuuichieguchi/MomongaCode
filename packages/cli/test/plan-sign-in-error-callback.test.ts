import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { GatewayAnswerError } from '../src/client/gateway-client.ts';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import { authLogin } from '../src/commands/auth.ts';
import type { AuthLoginPorts } from '../src/commands/auth.ts';
import { loopbackSignInListener, pastedCallbackProblem, signIn } from '../src/plan/sign-in.ts';
import { AUTHORIZATION_URL, CHATGPT, LISTENER_PORT } from './fake-plan-gateway.tsx';

const START_MS = 1_800_000_000_000;

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const recordingPlan = () => {
  const completions: unknown[] = [];
  const ports: number[] = [];
  const plan = {
    accounts: async () => ({ profiles: [CHATGPT], accounts: [] }),
    signInBegin: async (request: { port: number }) => {
      ports.push(request.port);
      return { attemptId: 'attempt-1', authorizationUrl: AUTHORIZATION_URL, state: 'st-1', expiresAt: '2026-11-10T00:05:00.000Z' };
    },
    signInComplete: async (request: unknown) => {
      completions.push(request);
      return { outcome: 'signed_in', account: { profile: 'chatgpt', label: 'work', state: 'active', active: true, pinnedBy: [] }, firstSignIn: false };
    },
    signInCancel: async () => undefined,
  } as unknown as PlanGatewayClient;
  return { plan, completions, ports };
};

describe('a callback carrying error= reaches the gateway whole, which judges it (P-C4)', () => {
  it('a callback carrying error= reaches signInComplete unchanged through the real loopback listener', async () => {
    const fake = recordingPlan();
    const answered: Promise<Response>[] = [];
    let callbackUrl = '';
    const outcome = await signIn(
      {
        plan: fake.plan,
        startListener: loopbackSignInListener(systemTiming, new AbortController().signal),
        authorize: async () => undefined,
        pasted: (_state, signal) => {
          callbackUrl = `http://127.0.0.1:${fake.ports[0]}/auth/callback?error=access_denied&state=st-1`;
          answered.push(fetch(callbackUrl));
          return waitForAbort(signal);
        },
        signal: new AbortController().signal,
        timers: createFakeTimers(createFakeClock(START_MS)),
      },
      { profile: 'chatgpt', account: 'work', reconsent: false },
    );
    expect(outcome.outcome).toBe('signed_in');
    expect((await answered[0])?.status).toBe(200);
    expect(fake.completions).toEqual([{ attemptId: 'attempt-1', callbackUrl }]);
  });

  it('a pasted error= URL reaches signInComplete unchanged', async () => {
    const fake = recordingPlan();
    const pastedUrl = `http://127.0.0.1:${LISTENER_PORT}/auth/callback?error=access_denied&state=st-1`;
    expect(pastedCallbackProblem(pastedUrl, 'st-1')).toBeUndefined();
    await signIn(
      {
        plan: fake.plan,
        startListener: async (path) => ({
          port: LISTENER_PORT,
          redirectUrl: `http://127.0.0.1:${LISTENER_PORT}${path}`,
          callback: ({ signal }) => waitForAbort(signal),
          close: async () => undefined,
        }),
        authorize: async () => undefined,
        pasted: async () => pastedUrl,
        signal: new AbortController().signal,
        timers: createFakeTimers(createFakeClock(START_MS)),
      },
      { profile: 'chatgpt', account: 'work', reconsent: false },
    );
    expect(fake.completions).toEqual([{ attemptId: 'attempt-1', callbackUrl: pastedUrl }]);
  });

  it("the command lets the gateway's authorization_failed answer reach its caller unchanged", async () => {
    const refusal = new GatewayAnswerError('the authorization was refused', 400, { code: 'authorization_failed', message: 'access_denied' });
    const fake = recordingPlan();
    const plan = {
      ...fake.plan,
      signInComplete: async () => {
        throw refusal;
      },
    } as unknown as PlanGatewayClient;
    const written: string[] = [];
    const sink = { write: (text: string) => void written.push(text) };
    const ports = {
      stdout: sink,
      stderr: sink,
      plan,
      startListener: async (path: string) => ({
        port: LISTENER_PORT,
        redirectUrl: `http://127.0.0.1:${LISTENER_PORT}${path}`,
        callback: async ({ state }: { state: string }) => new URL(`http://127.0.0.1:${LISTENER_PORT}${path}?error=access_denied&state=${state}`),
        close: async () => undefined,
      }),
      openUrl: () => Promise.resolve(),
      sandbox: async () => 'seatbelt' as const,
      signal: new AbortController().signal,
      timers: createFakeTimers(createFakeClock(START_MS)),
      isTerminal: false as const,
    } as unknown as AuthLoginPorts;
    const failure = await authLogin(ports, { provider: 'chatgpt', account: 'work', browser: false }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBe(refusal);
    expect((failure as GatewayAnswerError).answer?.code).toBe('authorization_failed');
  });
});
