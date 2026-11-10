import { AUTHORIZATION_WAIT_MS, startLoopbackRedirect, systemTiming } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import { planProfileOf } from '@momonga/config';
import type { PlanSignInCompleteResponse } from '@momonga/protocol';
import { GatewayAnswerError } from '../client/gateway-client.ts';
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

export type SignInWaitTimers = Pick<Timing, 'setTimeout' | 'clearTimeout'>;

export type SignInShown = { url: URL; state: string };

export type SignInPorts = {
  plan: PlanGatewayClient;
  startListener: StartSignInListener;
  authorize(shown: SignInShown): Promise<void>;
  pasted(state: string, signal: AbortSignal): Promise<string>;
  signal: AbortSignal;
  timers: SignInWaitTimers;
};

export const PASTE_LABEL = 'On a remote machine? Paste the redirect URL here';

export const SIGN_IN_WAIT_SECONDS = AUTHORIZATION_WAIT_MS / 1000;

export class SignInListenerError extends Error {
  constructor(cause: unknown) {
    super(`Could not start the local sign-in listener (${cause instanceof Error ? cause.message : String(cause)}). Nothing was changed.`, { cause });
    this.name = 'SignInListenerError';
  }
}

export class SignInExpiredError extends Error {
  constructor() {
    super(`Sign-in was not completed within ${SIGN_IN_WAIT_SECONDS} seconds.`);
    this.name = 'SignInExpiredError';
  }
}

export class SignInGatewayStoppedError extends Error {
  constructor(cause: unknown) {
    super('The gateway stopped before the sign-in finished. Start the sign-in again.', { cause });
    this.name = 'SignInGatewayStoppedError';
  }
}

export class SignInAttemptNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInAttemptNotFoundError';
  }
}

const ATTEMPT_NOT_FOUND = 'attempt_not_found';

export const callbackPathOf = (profile: string): string => planProfileOf(profile).oauth.callbackPath;

const firstValue = async (sources: readonly ((signal: AbortSignal) => Promise<string>)[], signal: AbortSignal): Promise<string> => {
  const losers = new AbortController();
  const both = AbortSignal.any([signal, losers.signal]);
  const running = sources.map((source) => source(both));
  try {
    return await Promise.race(running);
  } finally {
    losers.abort();
    await Promise.allSettled(running);
  }
};

const completed = async (plan: PlanGatewayClient, attemptId: string, callbackUrl: string): Promise<PlanSignInCompleteResponse> => {
  try {
    return await plan.signInComplete({ attemptId, callbackUrl });
  } catch (error) {
    if (!(error instanceof GatewayAnswerError)) throw new SignInGatewayStoppedError(error);
    if (error.answer?.code === ATTEMPT_NOT_FOUND) throw new SignInAttemptNotFoundError(error.answer.message);
    throw error;
  }
};

export const signIn = async (ports: SignInPorts, request: SignInRequest): Promise<PlanSignInCompleteResponse> => {
  let listener: SignInListener;
  try {
    listener = await ports.startListener(callbackPathOf(request.profile));
  } catch (error) {
    throw new SignInListenerError(error);
  }
  try {
    const begun = await ports.plan.signInBegin({ profile: request.profile, account: request.account, port: listener.port, ...(request.reconsent ? { reconsent: true } : {}) });
    const expiry = new AbortController();
    const timer = ports.timers.setTimeout(() => expiry.abort(new SignInExpiredError()), AUTHORIZATION_WAIT_MS);
    let value: string;
    try {
      const waiting = AbortSignal.any([ports.signal, expiry.signal]);
      await ports.authorize({ url: new URL(begun.authorizationUrl), state: begun.state });
      waiting.throwIfAborted();
      value = await firstValue([async (signal) => (await listener.callback({ state: begun.state, signal })).href, (signal) => ports.pasted(begun.state, signal)], waiting);
    } catch (error) {
      await ports.plan.signInCancel({ attemptId: begun.attemptId }).catch(() => undefined);
      throw error;
    } finally {
      ports.timers.clearTimeout(timer);
    }
    return await completed(ports.plan, begun.attemptId, value);
  } finally {
    await listener.close();
  }
};

export const waitForPaste = (deliveries: Promise<string>, signal: AbortSignal): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    deliveries.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      reject,
    );
  });

export const PASTED_CALLBACK_MAX_BYTES = 8 * 1024;

export const PASTED_CALLBACK_PROBLEMS = {
  tooLong: 'That text is too long to be a redirect URL.',
  notRedirect: 'That is not a redirect URL from the browser.',
  otherSignIn: 'That URL did not belong to this sign-in. Paste the URL again.',
} as const;

const parsedUrl = (text: string): URL | undefined => (URL.canParse(text) ? new URL(text) : undefined);

export const pastedCallbackProblem = (text: string, state: string): string | undefined => {
  if (Buffer.byteLength(text, 'utf8') > PASTED_CALLBACK_MAX_BYTES) return PASTED_CALLBACK_PROBLEMS.tooLong;
  const query = parsedUrl(text.trim())?.searchParams;
  const returned = query?.get('state');
  if (query === undefined || returned === null || returned === undefined || (!query.has('code') && !query.has('error'))) return PASTED_CALLBACK_PROBLEMS.notRedirect;
  return returned === state ? undefined : PASTED_CALLBACK_PROBLEMS.otherSignIn;
};
