import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { PlanAccountView } from '@momonga/protocol';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import * as authCommands from '../src/commands/auth.ts';
import { describeRunError } from '../src/policy-messages.ts';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import { AUTHORIZATION_URL, CHATGPT, LISTENER_PORT, account, eventually, quiet } from './fake-plan-gateway.tsx';

const PASTE_PROMPT = 'On a remote machine? Paste the redirect URL here, then press Enter. Otherwise finish the sign-in in the browser.';
const NOT_REDIRECT = 'That is not a redirect URL from the browser.';
const OTHER_SIGN_IN = 'That URL did not belong to this sign-in. Paste the URL again.';
const SENSITIVE_LINE = 'Open this URL (it is sensitive: do not share it):';
const WAIT_MS = 300_000;
const CALLBACK_URL = `http://127.0.0.1:${LISTENER_PORT}/auth/callback?code=code-1&state=st-1`;
const PASTED_URL = 'https://elsewhere.example:8443/any/path?code=pasted-code&state=st-1';

type Writer = { write(text: string): void; text(): string };

const writer = (): Writer => {
  const written: string[] = [];
  return { write: (text) => void written.push(text), text: () => written.join('') };
};

type Call = { route: string; body?: unknown };

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

type HarnessOptions = {
  terminal?: boolean;
  accounts?: readonly PlanAccountView[];
  listenerFails?: Error;
  callbackFails?: Error;
  cancelFails?: Error;
};

type Launch = { url: URL; watch: AbortSignal | undefined; onFailure: ((message: string) => void) | undefined };

const harness = (options: HarnessOptions = {}) => {
  const calls: Call[] = [];
  const called = (route: string, body?: unknown): void => void calls.push(body === undefined ? { route } : { route, body });
  const callback = deferred<URL>();
  const callbackSignals: AbortSignal[] = [];
  const opened: string[] = [];
  const launches: Launch[] = [];
  let listenerStarts = 0;
  const plan = {
    accounts: async () => {
      called('accounts');
      return { profiles: [CHATGPT], accounts: [...(options.accounts ?? [])] };
    },
    signInBegin: async (request: unknown) => {
      called('sign-in/begin', request);
      return { attemptId: 'attempt-1', authorizationUrl: AUTHORIZATION_URL, state: 'st-1', expiresAt: '2026-11-10T00:05:00.000Z' };
    },
    signInComplete: async (request: { attemptId: string; callbackUrl: string }) => {
      called('sign-in/complete', request);
      return { outcome: 'signed_in', account: account({ label: 'work' }), firstSignIn: false };
    },
    signInCancel: async (request: unknown) => {
      called('sign-in/cancel', request);
      if (options.cancelFails !== undefined) throw options.cancelFails;
    },
  } as unknown as PlanGatewayClient;
  const startListener = async (path: string) => {
    listenerStarts += 1;
    if (options.listenerFails !== undefined) throw options.listenerFails;
    return {
      port: LISTENER_PORT,
      redirectUrl: `http://127.0.0.1:${LISTENER_PORT}${path}`,
      callback: ({ signal }: { state: string; signal: AbortSignal }) => {
        callbackSignals.push(signal);
        if (options.callbackFails !== undefined) return Promise.reject(options.callbackFails);
        return new Promise<URL>((resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          callback.promise.then(resolve, reject);
        });
      },
      close: async () => undefined,
    };
  };
  const stdin = new PassThrough();
  const terminalOut = new PassThrough();
  const terminalText: string[] = [];
  terminalOut.on('data', (chunk: Buffer) => void terminalText.push(chunk.toString('utf8')));
  const interrupt = new AbortController();
  const timers: FakeTimers = createFakeTimers(createFakeClock(1_800_000_000_000));
  const stdout = writer();
  const stderr = writer();
  const ports = {
    stdout,
    stderr,
    plan,
    startListener,
    openUrl: (url: URL, watch?: AbortSignal, onFailure?: (message: string) => void) => {
      opened.push(url.href);
      launches.push({ url, watch, onFailure });
      return Promise.resolve();
    },
    sandbox: async () => 'seatbelt' as const,
    signal: interrupt.signal,
    timers,
    ...(options.terminal === true
      ? { isTerminal: true as const, terminal: { stdin, stdout: terminalOut }, choose: async () => 0 }
      : { isTerminal: false as const }),
  };
  const routes = (): string[] => calls.map((call) => call.route);
  const shown = (): string => `${stdout.text()}${terminalText.join('')}`;
  const failLaunch = (message: string): void => {
    const onFailure = launches.at(-1)?.onFailure;
    if (onFailure === undefined) throw new Error('no launch recorded with an onFailure callback');
    onFailure(message);
  };
  return { calls, routes, ports, stdin, interrupt, timers, callback, callbackSignals, opened, launches, failLaunch, stdout, stderr, shown, listenerStarts: () => listenerStarts };
};

type Harness = ReturnType<typeof harness>;

const login = (h: Harness, options: Record<string, unknown> = { provider: 'chatgpt', account: 'work' }): Promise<number> =>
  (authCommands as unknown as { authLogin: (ports: unknown, options: unknown) => Promise<number> }).authLogin(h.ports, options);

const settled = <T>(promise: Promise<T>): { done(): boolean } => {
  let finished = false;
  promise.then(
    () => void (finished = true),
    () => void (finished = true),
  );
  return { done: () => finished };
};

const untilWaiting = (h: Harness, options: { browser?: boolean } = {}): Promise<void> =>
  options.browser === false
    ? eventually(() => h.routes().includes('sign-in/begin') && h.shown().includes(AUTHORIZATION_URL), 'the authorization URL to be shown')
    : eventually(() => h.routes().includes('sign-in/begin') && h.opened.length === 1, 'the browser to be started');

const DESCRIPTION = CHATGPT.messages.description;
const HINT = 'If no browser window opens, press Ctrl-C and run momonga auth login chatgpt --account work --no-browser to get the sign-in URL.';
const LAUNCH_FAILED = (message: string): string => `Could not open the browser (${message}). Open the URL above to continue.\n`;

const completions = (h: Harness): unknown[] => h.calls.filter((call) => call.route === 'sign-in/complete').map((call) => call.body);

describe('momonga auth login reads a pasted redirect URL in a terminal (O-R5-6 A)', () => {
  it('prints the paste prompt once and sends a valid pasted line whole to complete', async () => {
    const h = harness({ terminal: true });
    const exit = login(h);
    await untilWaiting(h);
    await eventually(() => h.shown().includes(PASTE_PROMPT), 'the paste prompt');
    h.stdin.write(`${PASTED_URL}\n`);
    expect(await exit).toBe(0);
    expect(h.shown().split(PASTE_PROMPT)).toHaveLength(2);
    expect(completions(h)).toEqual([{ attemptId: 'attempt-1', callbackUrl: PASTED_URL }]);
    expect(h.callbackSignals.every((signal) => signal.aborted)).toBe(true);
    expect(h.routes()).not.toContain('sign-in/cancel');
  });

  it('ignores a blank line, prints the S2 sentence of a refused line on stderr, keeps waiting, then completes with the next valid line', async () => {
    const h = harness({ terminal: true });
    const exit = login(h);
    const state = settled(exit);
    await untilWaiting(h);
    h.stdin.write('\n');
    await quiet();
    expect(h.stderr.text()).toBe('');
    h.stdin.write('not a url\n');
    await eventually(() => h.stderr.text().includes(NOT_REDIRECT), 'the refusal of a line that is not a redirect URL');
    h.stdin.write('https://elsewhere.example/x?code=c&state=st-other\n');
    await eventually(() => h.stderr.text().includes(OTHER_SIGN_IN), 'the refusal of a URL of another sign-in');
    expect(h.stderr.text()).toBe(`${NOT_REDIRECT}\n${OTHER_SIGN_IN}\n`);
    await quiet();
    expect(state.done()).toBe(false);
    expect(completions(h)).toEqual([]);
    h.stdin.write(`${PASTED_URL}\n`);
    expect(await exit).toBe(0);
    expect(completions(h)).toEqual([{ attemptId: 'attempt-1', callbackUrl: PASTED_URL }]);
  });

  it('keeps waiting for the callback after end of input and completes with it', async () => {
    const h = harness({ terminal: true });
    const exit = login(h);
    const state = settled(exit);
    await untilWaiting(h);
    h.stdin.end();
    await quiet();
    expect(state.done()).toBe(false);
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await exit).toBe(0);
    expect(completions(h)).toEqual([{ attemptId: 'attempt-1', callbackUrl: CALLBACK_URL }]);
  });

  it('delivers once when the callback arrives first and a valid line follows', async () => {
    const h = harness({ terminal: true });
    const exit = login(h);
    await untilWaiting(h);
    h.callback.resolve(new URL(CALLBACK_URL));
    h.stdin.write(`${PASTED_URL}\n`);
    expect(await exit).toBe(0);
    await quiet();
    expect(completions(h)).toEqual([{ attemptId: 'attempt-1', callbackUrl: CALLBACK_URL }]);
  });

  it('delivers once when a valid line arrives first and the callback follows', async () => {
    const h = harness({ terminal: true });
    const exit = login(h);
    await untilWaiting(h);
    h.stdin.write(`${PASTED_URL}\n`);
    await eventually(() => completions(h).length > 0, 'the completion');
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await exit).toBe(0);
    await quiet();
    expect(completions(h)).toEqual([{ attemptId: 'attempt-1', callbackUrl: PASTED_URL }]);
  });

  it('never reads stdin and says nothing about pasting when stdin is not a terminal', async () => {
    const h = harness({ terminal: false });
    h.stdin.write(`${PASTED_URL}\n`);
    const before = h.stdin.readableLength;
    const exit = login(h);
    await untilWaiting(h);
    await quiet();
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await exit).toBe(0);
    expect(h.stdin.readableLength).toBe(before);
    expect(h.shown()).not.toContain('Paste');
    expect(completions(h)).toEqual([{ attemptId: 'attempt-1', callbackUrl: CALLBACK_URL }]);
  });
});

describe('the bound, the interrupt and the failures of momonga auth login (O-R5-6 A)', () => {
  it.each([true, false])('cancels the attempt and exits 1 with the expiry text after AUTHORIZATION_WAIT_MS (terminal %s)', async (terminal) => {
    const h = harness({ terminal });
    const exit = login(h);
    const state = settled(exit);
    await untilWaiting(h);
    h.timers.advance(WAIT_MS - 1);
    await quiet();
    expect(state.done()).toBe(false);
    h.timers.advance(1);
    expect(await exit).toBe(1);
    expect(h.stderr.text()).toContain('Sign-in was not completed within 300 seconds. Run momonga auth login chatgpt --account work to try again.\n');
    expect(h.calls.filter((call) => call.route === 'sign-in/cancel')).toEqual([{ route: 'sign-in/cancel', body: { attemptId: 'attempt-1' } }]);
    expect(completions(h)).toEqual([]);
  });

  it('does not extend the bound for refused lines', async () => {
    const h = harness({ terminal: true });
    const exit = login(h);
    await untilWaiting(h);
    h.timers.advance(WAIT_MS - 10);
    h.stdin.write('not a url\n');
    await eventually(() => h.stderr.text().includes(NOT_REDIRECT), 'the refusal');
    h.timers.advance(10);
    expect(await exit).toBe(1);
    expect(h.stderr.text()).toContain('Sign-in was not completed within 300 seconds.');
  });

  it('on the interrupt cancels the attempt, prints momonga: sign-in cancelled and exits 130', async () => {
    const h = harness({ terminal: true });
    const exit = login(h);
    await untilWaiting(h);
    h.interrupt.abort();
    expect(await exit).toBe(130);
    expect(h.stderr.text()).toContain('momonga: sign-in cancelled\n');
    expect(h.calls.filter((call) => call.route === 'sign-in/cancel')).toEqual([{ route: 'sign-in/cancel', body: { attemptId: 'attempt-1' } }]);
    expect(completions(h)).toEqual([]);
  });

  it('a cancel that fails does not replace the error that caused it', async () => {
    const h = harness({ terminal: false, callbackFails: new Error('the listener broke'), cancelFails: new Error('the gateway refused the cancel') });
    await expect(login(h)).rejects.toThrow('the listener broke');
    expect(h.routes()).toContain('sign-in/cancel');
  });

  it('a cancel that fails on the interrupt still exits 130 with the cancelled text', async () => {
    const h = harness({ terminal: true, cancelFails: new Error('the gateway refused the cancel') });
    const exit = login(h);
    await untilWaiting(h);
    h.interrupt.abort();
    expect(await exit).toBe(130);
    expect(h.stderr.text()).toContain('momonga: sign-in cancelled\n');
  });

  it('prints the listener failure and exits 1 without calling begin', async () => {
    const h = harness({ terminal: true, listenerFails: new Error('bind refused') });
    expect(await login(h)).toBe(1);
    expect(h.stderr.text()).toContain('Could not start the local sign-in listener (bind refused). Nothing was changed.\n');
    expect(h.routes()).not.toContain('sign-in/begin');
  });

  it('--no-browser prints the URL as one marked-sensitive line and opens nothing', async () => {
    const h = harness({ terminal: false });
    const exit = login(h, { provider: 'chatgpt', account: 'work', browser: false });
    await untilWaiting(h, { browser: false });
    expect(h.stdout.text()).toBe(`${DESCRIPTION}\n${SENSITIVE_LINE}\n${AUTHORIZATION_URL}\n`);
    expect(h.stdout.text()).not.toContain(HINT);
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await exit).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.stdout.text()).toContain(`${SENSITIVE_LINE}\n${AUTHORIZATION_URL}\n`);
  });

  it('--no-browser in a terminal prints the URL block, then the paste prompt, and no hint', async () => {
    const h = harness({ terminal: true });
    const exit = login(h, { provider: 'chatgpt', account: 'work', browser: false });
    await untilWaiting(h, { browser: false });
    await eventually(() => h.stdout.text().includes(PASTE_PROMPT), 'the paste prompt');
    expect(h.stdout.text()).toBe(`${DESCRIPTION}\n${SENSITIVE_LINE}\n${AUTHORIZATION_URL}\n${PASTE_PROMPT}\n`);
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await exit).toBe(0);
  });

  it('a failed browser launch keeps the marked-sensitive URL and says so', async () => {
    const h = harness({ terminal: false });
    const exit = login(h);
    await untilWaiting(h);
    h.failLaunch('no opener');
    await eventually(() => h.stderr.text() !== '', 'the launch failure line');
    expect(h.stdout.text().endsWith(`${SENSITIVE_LINE}\n${AUTHORIZATION_URL}\n`)).toBe(true);
    expect(h.stderr.text()).toBe(LAUNCH_FAILED('no opener'));
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await exit).toBe(0);
  });

  it('a launcher that ends unsuccessfully after the wait began prints the block then', async () => {
    const h = harness({ terminal: false });
    const exit = login(h);
    await untilWaiting(h);
    expect(h.stdout.text()).toBe(`${DESCRIPTION}\n${HINT}\n`);
    h.failLaunch('/usr/bin/open exited with code 1');
    await eventually(() => h.stderr.text() !== '', 'the launch failure line');
    expect(h.stdout.text()).toBe(`${DESCRIPTION}\n${HINT}\n${SENSITIVE_LINE}\n${AUTHORIZATION_URL}\n`);
    expect(h.stderr.text()).toBe(LAUNCH_FAILED('/usr/bin/open exited with code 1'));
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await exit).toBe(0);
  });

  it('a launch failure reported after the sign-in has its value prints nothing', async () => {
    const h = harness({ terminal: false });
    const exit = login(h);
    await untilWaiting(h);
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await exit).toBe(0);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]?.watch?.aborted).toBe(true);
    expect(h.stdout.text()).not.toContain(AUTHORIZATION_URL);
    expect(h.stderr.text()).toBe('');
  });
});

describe('momonga auth login shows the authorization URL only for --no-browser or a failed launch (P-C1)', () => {
  it('case 1: the URL is in neither stream and line H is the second stdout line', async () => {
    const h = harness({ terminal: false });
    const exit = login(h);
    await untilWaiting(h);
    await quiet();
    expect(h.stdout.text()).toBe(`${DESCRIPTION}\n${HINT}\n`);
    expect(h.stderr.text()).toBe('');
    expect(h.shown()).not.toContain(AUTHORIZATION_URL);
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await exit).toBe(0);
    expect(h.stdout.text()).toBe(`${DESCRIPTION}\n${HINT}\nSigned in as work (ada@example.com)\n`);
    expect(h.shown()).not.toContain(AUTHORIZATION_URL);
  });

  it('case 1 in a terminal: the description, line H and the paste prompt, and no URL', async () => {
    const h = harness({ terminal: true });
    const exit = login(h);
    await untilWaiting(h);
    await eventually(() => h.stdout.text().includes(PASTE_PROMPT), 'the paste prompt');
    expect(h.stdout.text()).toBe(`${DESCRIPTION}\n${HINT}\n${PASTE_PROMPT}\n`);
    expect(h.shown()).not.toContain(AUTHORIZATION_URL);
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await exit).toBe(0);
  });
});

describe('momonga auth login --account starts nothing for an account a sign-in cannot fix (O-R5-6 G 7)', () => {
  it.each([
    ['signing_out', 'signing out'],
    ['store_unreadable', 'record unreadable'],
    ['store_unwritable', 'record not writable'],
  ] as const)('%s: prints the state word and the cause and exits 1', async (state, word) => {
    const h = harness({ terminal: true, accounts: [account({ label: 'work', state, active: false, cause: 'the cause of it' })] });
    h.callback.resolve(new URL(CALLBACK_URL));
    expect(await login(h)).toBe(1);
    expect(h.stderr.text()).toContain(`work: ${word}\ncause: the cause of it\n`);
    expect(h.listenerStarts()).toBe(0);
    expect(h.routes()).toEqual(['accounts']);
  });
});

describe('describeRunError for plan_use_not_enabled and plan_not_eligible in a headless run (P6.5, O-R5-6 designed and not built 3)', () => {
  const plan = { profile: 'chatgpt', account: 'work' };

  it('plan_use_not_enabled names the reconsent command, then the cause', () => {
    expect(describeRunError({ code: 'plan_use_not_enabled', message: 'Plan use is not enabled.', plan }, 'headless')).toEqual([
      'Plan use is not enabled. · Run momonga auth login chatgpt --account work --reconsent to enable it',
      'cause: plan_use_not_enabled',
    ]);
  });

  it('plan_not_eligible prints the message, the cause, then the way to another account or an API key', () => {
    const lines = describeRunError({ code: 'plan_not_eligible', message: 'Not eligible.', plan }, 'headless');
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2)).toEqual(['Not eligible.', 'cause: plan_not_eligible']);
    expect(lines[2]?.startsWith('Run momonga auth login chatgpt --account ')).toBe(true);
    expect(lines[2]?.endsWith(' to use another account, or use an API key.')).toBe(true);
  });

  it.each(['plan_use_not_enabled', 'plan_not_eligible'])('%s keeps the default line when the error carries no plan', (code) => {
    expect(describeRunError({ code, message: 'text' }, 'headless')).toEqual([`${code}: text`]);
  });

  it('the usage codes keep the default line', () => {
    expect(describeRunError({ code: 'plan_usage_limit', message: 'Manage usage', plan }, 'headless')).toEqual(['plan_usage_limit: Manage usage']);
  });
});

describe('momonga auth status shows the files the gateway could not list (O-R5-6 D)', () => {
  const PROBLEM_LINE = '  could not list abc123.json: the file mode is 644';
  const USAGE_LINE = `${CHATGPT.messages.manageUsageLabel}: ${CHATGPT.usageUrl}`;

  it('prints could not list <file name>: <cause> after the profile block', async () => {
    const plan = {
      accounts: async () => ({ profiles: [CHATGPT], accounts: [account({ label: 'work' })], listProblems: [{ file: 'abc123.json', cause: 'the file mode is 644' }] }),
    } as unknown as PlanGatewayClient;
    const stdout = writer();
    expect(await authCommands.authStatus({ stdout, plan, models: async () => [] }, { json: false })).toBe(0);
    const lines = stdout.text().split('\n');
    expect(lines).toContain(PROBLEM_LINE);
    expect(lines.indexOf(PROBLEM_LINE)).toBeGreaterThan(lines.indexOf(USAGE_LINE));
  });

  it('auth status with two providers prints each could-not-list line once, after the provider blocks', async () => {
    const other = { ...CHATGPT, id: 'other', messages: { ...CHATGPT.messages, pickerLabel: 'Other plan' } };
    const plan = {
      accounts: async () => ({ profiles: [CHATGPT, other], accounts: [account({ label: 'work' })], listProblems: [{ file: 'abc123.json', cause: 'the file mode is 644' }] }),
    } as unknown as PlanGatewayClient;
    const stdout = writer();
    expect(await authCommands.authStatus({ stdout, plan, models: async () => [] }, { json: false })).toBe(0);
    const lines = stdout.text().split('\n');
    expect(lines.filter((line) => line === PROBLEM_LINE)).toHaveLength(1);
    const usageIndexes = lines.flatMap((line, index) => (line === USAGE_LINE ? [index] : []));
    expect(usageIndexes).toHaveLength(2);
    const problemIndex = lines.indexOf(PROBLEM_LINE);
    expect(problemIndex).toBeGreaterThan(Math.max(...usageIndexes));
    expect(problemIndex).toBeLessThan(lines.findIndex((line) => line.startsWith('model:')));
  });
});
