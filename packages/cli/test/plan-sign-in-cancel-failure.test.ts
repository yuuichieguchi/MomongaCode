import { describe, expect, it, vi } from 'vitest';
import { signIn } from '../src/plan/sign-in.ts';
import type { SignInPorts } from '../src/plan/sign-in.ts';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';

const ATTEMPT_ID = 'attempt-1';

const beginAnswer = {
  attemptId: ATTEMPT_ID,
  authorizationUrl: 'https://auth.example.test/authorize?state=s',
  state: 's',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

const portsWith = (overrides: { authorize: SignInPorts['authorize']; cancel: () => Promise<unknown>; warn: (text: string) => void }): SignInPorts => {
  const plan = {
    signInBegin: vi.fn(async () => beginAnswer),
    signInCancel: vi.fn(overrides.cancel),
  } as unknown as PlanGatewayClient;
  return {
    plan,
    startListener: async () => ({
      port: 49152,
      redirectUrl: 'http://127.0.0.1:49152/callback',
      callback: () => new Promise<URL>(() => undefined),
      close: async () => undefined,
    }),
    authorize: overrides.authorize,
    pasted: () => new Promise<string>(() => undefined),
    confirmIdentity: async () => false,
    signal: new AbortController().signal,
    timers: { setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimeout: () => undefined },
    warn: overrides.warn,
  };
};

describe('a failed cancel after a failed sign-in wait', () => {
  it('keeps the original failure as the one returned and logs the cancel failure', async () => {
    const original = new Error('the browser could not be started');
    const warnings: string[] = [];
    const ports = portsWith({
      authorize: async () => {
        throw original;
      },
      cancel: async () => {
        throw new Error('the gateway refused the cancel');
      },
      warn: (text) => warnings.push(text),
    });

    await expect(signIn(ports, { profile: 'chatgpt', account: 'work', reconsent: false })).rejects.toBe(original);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('the gateway refused the cancel');
  });
});
