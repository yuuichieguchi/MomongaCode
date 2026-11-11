import { IDENTITY_UNCONFIRMED_OUTCOME, PLAN_SIGN_IN_FAILURE } from '@momonga/protocol';
import { AUTHORIZATION_WAIT_MS, OAuthAuthorizationError, startLoopbackRedirect } from '@momonga/foundation';
import type { LoopbackRedirectOptions } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import { planProfileOf } from '@momonga/config';
import type { PlanSignInCompleteRequest, PlanSignInCompleteResponse, PlanSignInIdentity, PlanSignInIdentityUnconfirmed } from '@momonga/protocol';
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
  (timers: LoopbackRedirectOptions['timers'], signal: AbortSignal): StartSignInListener =>
  async (path) => {
    const redirect = await startLoopbackRedirect({ port: 0, path, timers });
    return {
      port: Number(new URL(redirect.redirectUrl).port),
      redirectUrl: redirect.redirectUrl,
      callback: async (options) => {
        const waiting = AbortSignal.any([signal, options.signal]);
        let params: URLSearchParams;
        try {
          params = await redirect.callback({ state: options.state, signal: waiting, timeoutMs: AUTHORIZATION_WAIT_MS });
        } catch (error) {
          if (waiting.aborted && error === waiting.reason) throw error;
          if (error instanceof OAuthAuthorizationError && error.failure === 'timed_out') throw new SignInExpiredError();
          throw new SignInListenerFailedError(error);
        }
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
  authorize(shown: SignInShown, waiting: AbortSignal): Promise<void>;
  pasted(state: string, signal: AbortSignal): Promise<string>;
  confirmIdentity(identity: PlanSignInIdentity, waiting: AbortSignal): Promise<boolean>;
  signal: AbortSignal;
  timers: SignInWaitTimers;
  delivered?(): void;
};

export const PASTE_LABEL = 'On a remote machine? Paste the redirect URL here';

export const SIGN_IN_WAIT_SECONDS = AUTHORIZATION_WAIT_MS / 1000;

export class SignInListenerError extends Error {
  constructor(cause: unknown) {
    super(`Could not start the local sign-in listener (${cause instanceof Error ? cause.message : String(cause)}). Nothing was changed.`, { cause });
    this.name = 'SignInListenerError';
  }
}

export class SignInListenerFailedError extends Error {
  constructor(cause: unknown) {
    super(`The local sign-in listener failed (${cause instanceof Error ? cause.message : String(cause)}). The sign-in was cancelled.`, { cause });
    this.name = 'SignInListenerFailedError';
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

const ATTEMPT_NOT_FOUND = PLAN_SIGN_IN_FAILURE.attemptNotFound;

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

const completed = async (plan: PlanGatewayClient, request: PlanSignInCompleteRequest): Promise<PlanSignInCompleteResponse> => {
  try {
    return await plan.signInComplete(request);
  } catch (error) {
    if (!(error instanceof GatewayAnswerError)) throw new SignInGatewayStoppedError(error);
    if (error.answer?.code === ATTEMPT_NOT_FOUND) throw new SignInAttemptNotFoundError(error.answer.message);
    throw error;
  }
};

const abandoned = (plan: PlanGatewayClient, attemptId: string): Promise<void> => plan.signInCancel({ attemptId }).catch(() => undefined);

const confirmed = async (ports: SignInPorts, unconfirmed: PlanSignInIdentityUnconfirmed): Promise<PlanSignInCompleteResponse> => {
  const expiry = new AbortController();
  const timer = ports.timers.setTimeout(() => expiry.abort(new SignInExpiredError()), AUTHORIZATION_WAIT_MS);
  let accepted: boolean;
  try {
    const waiting = AbortSignal.any([ports.signal, expiry.signal]);
    accepted = await ports.confirmIdentity(unconfirmed.identity, waiting);
    waiting.throwIfAborted();
  } catch (error) {
    await abandoned(ports.plan, unconfirmed.attemptId);
    throw error;
  } finally {
    ports.timers.clearTimeout(timer);
  }
  if (!accepted) {
    await ports.plan.signInCancel({ attemptId: unconfirmed.attemptId });
    return unconfirmed;
  }
  return completed(ports.plan, { attemptId: unconfirmed.attemptId, identityConfirmed: true });
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
    const ended = new AbortController();
    const timer = ports.timers.setTimeout(() => expiry.abort(new SignInExpiredError()), AUTHORIZATION_WAIT_MS);
    let value: string;
    try {
      const waiting = AbortSignal.any([ports.signal, expiry.signal, ended.signal]);
      await ports.authorize({ url: new URL(begun.authorizationUrl), state: begun.state }, waiting);
      waiting.throwIfAborted();
      value = await firstValue([async (signal) => (await listener.callback({ state: begun.state, signal })).href, (signal) => ports.pasted(begun.state, signal)], waiting);
      ports.delivered?.();
    } catch (error) {
      await abandoned(ports.plan, begun.attemptId);
      throw error;
    } finally {
      ports.timers.clearTimeout(timer);
      ended.abort();
    }
    const answer = await completed(ports.plan, { attemptId: begun.attemptId, callbackUrl: value });
    return answer.outcome === IDENTITY_UNCONFIRMED_OUTCOME ? await confirmed(ports, answer) : answer;
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
