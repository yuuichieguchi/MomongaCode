import type { FetchLike } from '@modelcontextprotocol/client';
import { OperationLimitError, StoreCallEndedError } from '@momonga/foundation';
import type { McpTimers } from '@momonga/mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeMcpServer } from '../src/authorize.ts';
import { LIMIT_TEST, controlledCredentialStore, keyReadLimitSentence, outcomeOf, settledAfter, stillPendingAfter, useLimitTimers } from './credential-store-fakes.ts';
import type { ControlledCredentialStore, Outcome } from './credential-store-fakes.ts';
import { browserThatFollowsRedirect, startHttpFixture, startOauthFixture } from './remote-harness.ts';

const STORE_LIMIT_MS = 1000;

const globalTimers: McpTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

type Browser = { opened: Promise<void>; open(url: URL): Promise<void> };

const browserThat = (act: (url: URL) => Promise<void>): Browser => {
  let markOpened: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    markOpened = resolve;
  });
  return {
    opened,
    open: async (url) => {
      markOpened();
      await act(url);
    },
  };
};

const signIn = async (credentials: ControlledCredentialStore, browser: Browser, extra: { waitMs?: number } = {}): Promise<{ attempt: Outcome<void>; cancel(): void }> => {
  const oauth = await startOauthFixture();
  const fixture = await startHttpFixture({ era: 'legacy', oauth });
  const controller = new AbortController();
  let token = 0;
  const attempt = outcomeOf(
    authorizeMcpServer({
      server: 'remote',
      url: fixture.url,
      scope: 'user',
      oauth: undefined,
      fetch: globalThis.fetch as FetchLike,
      ports: {
        store: credentials.store,
        timers: globalTimers,
        randomToken: () => {
          token += 1;
          return `random-${token}`;
        },
        openAuthorizationUrl: (url) => browser.open(url),
      },
      signal: controller.signal,
      storeLimitMs: STORE_LIMIT_MS,
      ...extra,
    }),
  );
  return { attempt, cancel: () => controller.abort(new Error('the test ended')) };
};

describe('the store phases of an MCP sign-in', () => {
  const cancels: Array<() => void> = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const cancel of cancels.splice(0)) cancel();
  });

  it('a sign-in store phase ends at storeLimitMs', LIMIT_TEST, async () => {
    const credentials = controlledCredentialStore();
    credentials.mode = 'hang';
    useLimitTimers();

    const { attempt, cancel } = await signIn(credentials, browserThat(browserThatFollowsRedirect()));
    cancels.push(cancel);
    await credentials.arrived(1, 'hang');
    await stillPendingAfter(attempt, STORE_LIMIT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(attempt);

    expect(attempt.state()).toBe('rejected');
    expect((attempt.error() as Error).message).toBe(keyReadLimitSentence('the MCP connect limit', STORE_LIMIT_MS));
    expect(credentials.calls).toHaveLength(1);
  });

  it('the second sign-in phase has its own limit', LIMIT_TEST, async () => {
    const FIRST_PHASE_MS = 600;
    const BROWSER_STEP_MS = 5000;
    const credentials = controlledCredentialStore();
    const firstPhase = Promise.withResolvers<void>();
    const browserStep = Promise.withResolvers<void>();
    let browserStepDone = false;
    credentials.mode = () => (browserStepDone ? 'hang' : 'answer');
    credentials.beforeAnswer = async () => {
      if (credentials.calls.length === 1) await firstPhase.promise;
    };
    const follow = browserThatFollowsRedirect();
    const browser = browserThat(async (url) => {
      await browserStep.promise;
      browserStepDone = true;
      await follow(url);
    });
    useLimitTimers();

    const { attempt, cancel } = await signIn(credentials, browser);
    cancels.push(cancel);
    await credentials.arrived(1, 'answer');
    await vi.advanceTimersByTimeAsync(FIRST_PHASE_MS);
    firstPhase.resolve();
    await browser.opened;
    await vi.advanceTimersByTimeAsync(BROWSER_STEP_MS);
    browserStep.resolve();
    await credentials.arrived(1, 'hang');
    await stillPendingAfter(attempt, STORE_LIMIT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(attempt);

    expect(attempt.state()).toBe('rejected');
    const ended = credentials.calls.find((call) => call.mode === 'hang')?.rejection as StoreCallEndedError;
    expect(ended).toBeInstanceOf(StoreCallEndedError);
    expect(ended.limit).toBeInstanceOf(OperationLimitError);
    expect(ended.limit).toMatchObject({ limitMs: STORE_LIMIT_MS, label: 'the MCP connect limit' });
    expect((attempt.error() as Error).message).toBe(keyReadLimitSentence('the MCP connect limit', STORE_LIMIT_MS));
  });

  it('the redirect wait keeps waitMs', LIMIT_TEST, async () => {
    const WAIT_MS = 2000;
    const credentials = controlledCredentialStore();
    const browser = browserThat(() => Promise.resolve());
    useLimitTimers();

    const { attempt, cancel } = await signIn(credentials, browser, { waitMs: WAIT_MS });
    cancels.push(cancel);
    await browser.opened;
    await stillPendingAfter(attempt, WAIT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(attempt);

    expect(attempt.state()).toBe('rejected');
    expect((attempt.error() as Error).message).toBe('authorization was not completed in the browser in time');
  });
});
