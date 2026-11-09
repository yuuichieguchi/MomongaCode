import { AUTHORIZATION_WAIT_MS, startLoopbackRedirect, systemTiming } from '@momonga/foundation';
import { planProfileOf } from '@momonga/config';
import type { PlanSignInCompleteResponse } from '@momonga/protocol';
import type { PlanGatewayClient } from '../client/gateway-client.ts';

export type SignInListener = {
  readonly port: number;
  readonly redirectUrl: string;
  callback(options: { state: string; signal: AbortSignal }): Promise<URL>;
  close(): Promise<void>;
};

export type StartSignInListener = (path: string) => Promise<SignInListener>;

export type SandboxKind = 'seatbelt' | 'bubblewrap' | 'none';

export const loopbackSignInListener =
  (signal: AbortSignal): StartSignInListener =>
  async (path) => {
    const redirect = await startLoopbackRedirect({ port: 0, path, timers: systemTiming });
    return {
      port: Number(new URL(redirect.redirectUrl).port),
      redirectUrl: redirect.redirectUrl,
      callback: async (options) => {
        const params = await redirect.callback({ state: options.state, signal: AbortSignal.any([signal, options.signal]), timeoutMs: AUTHORIZATION_WAIT_MS });
        return new URL(`${redirect.redirectUrl}?${params.toString()}`);
      },
      close: () => redirect.close(),
    };
  };

export type SignInRequest = { profile: string; account: string; reconsent: boolean };

export type SignInPorts = {
  plan: PlanGatewayClient;
  startListener: StartSignInListener;
  authorize(url: URL): Promise<void>;
  signal: AbortSignal;
};

export const callbackPathOf = (profile: string): string => planProfileOf(profile).oauth.callbackPath;

export const signIn = async (ports: SignInPorts, request: SignInRequest): Promise<PlanSignInCompleteResponse> => {
  const listener = await ports.startListener(callbackPathOf(request.profile));
  try {
    const begun = await ports.plan.signInBegin({ profile: request.profile, account: request.account, port: listener.port, ...(request.reconsent ? { reconsent: true } : {}) });
    const returned = async (): Promise<URL> => {
      await ports.authorize(new URL(begun.authorizationUrl));
      return listener.callback({ state: begun.state, signal: ports.signal });
    };
    const callback = await returned().catch(async (error: unknown) => {
      await ports.plan.signInCancel({ attemptId: begun.attemptId });
      throw error;
    });
    return await ports.plan.signInComplete({ attemptId: begun.attemptId, callbackUrl: callback.href });
  } finally {
    await listener.close();
  }
};
