import http from 'node:http';
import path from 'node:path';
import { createFakeClock, createFakeTimers, registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_WAIT_MS, EXIT_FAILURE, EXIT_OK, fixedSocket, systemTiming } from '@momonga/foundation';
import { createGatewayClient } from '../src/client/gateway-client.ts';
import { authLogin } from '../src/commands/auth.ts';
import type { AuthLoginPorts } from '../src/commands/auth.ts';
import { IDENTITY_UNCONFIRMED, account, fakePlanBackend } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';

const writer = () => {
  const written: string[] = [];
  return { written, write: (text: string): void => void written.push(text) };
};

type Asked = { question: string; choices: readonly string[] };

const SAVE_COMMAND = 'momonga auth login chatgpt --account chatgpt';

const headlessPorts = (backend: FakePlanBackend, out: ReturnType<typeof writer>, err: ReturnType<typeof writer>): AuthLoginPorts => ({
  stdout: out,
  stderr: err,
  plan: backend.plan,
  startListener: backend.startSignInListener,
  openUrl: () => Promise.resolve(),
  sandbox: async () => 'seatbelt' as const,
  signal: new AbortController().signal,
  timers: systemTiming,
  isTerminal: false,
});

const terminalPorts = (backend: FakePlanBackend, out: ReturnType<typeof writer>, err: ReturnType<typeof writer>, answer: (asked: Asked, until: AbortSignal | undefined) => Promise<number | undefined>, timers: AuthLoginPorts['timers'] = systemTiming): AuthLoginPorts => ({
  ...headlessPorts(backend, out, err),
  timers,
  isTerminal: true,
  choose: (question, choices, until) => answer({ question, choices }, until),
  terminal: { stdin: process.stdin, stdout: process.stdout },
});

const completions = (backend: FakePlanBackend): unknown[] => backend.planCalls.filter((call) => call.route === 'sign-in/complete').map((call) => call.body);

const cancellations = (backend: FakePlanBackend): unknown[] => backend.planCalls.filter((call) => call.route === 'sign-in/cancel').map((call) => call.body);

describe('momonga auth login: the first sign-in of an account is saved only after its identity is confirmed (gateway-accounts C51)', () => {
  it('without a terminal and without --yes saves nothing, cancels the attempt, names the identity and the command that confirms it: exit 1', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [], complete: IDENTITY_UNCONFIRMED });
    expect(await authLogin(headlessPorts(backend, out, err), { provider: 'chatgpt' })).toBe(EXIT_FAILURE);
    expect(completions(backend)).toHaveLength(1);
    expect(cancellations(backend)).toEqual([{ attemptId: 'attempt-1' }]);
    expect(err.written.join('')).toBe(
      `The sign-in for ada@example.com was not saved under the label chatgpt, because the account was not confirmed. Run ${SAVE_COMMAND} to sign in again, or add --yes to save the account without the question.\n`,
    );
    expect(out.written.join('')).not.toContain('Signed in');
  });

  it('with --yes confirms the identity the sign-in answered and saves the account: exit 0', async () => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [], complete: IDENTITY_UNCONFIRMED, confirmed: { outcome: 'signed_in', account: account(), firstSignIn: true } });
    expect(await authLogin(headlessPorts(backend, out, err), { provider: 'chatgpt', yes: true })).toBe(EXIT_OK);
    expect(completions(backend)[1]).toEqual({ attemptId: 'attempt-1', identityConfirmed: true });
    expect(cancellations(backend)).toEqual([]);
    expect(out.written.join('')).toContain('Signed in as chatgpt (ada@example.com)');
    expect(err.written.join('')).toBe('');
  });

  it('in a terminal asks with the identity and the label, and saves when the person chooses to', async () => {
    const out = writer();
    const err = writer();
    const asked: Asked[] = [];
    const backend = fakePlanBackend({ accounts: [], complete: IDENTITY_UNCONFIRMED });
    const ports = terminalPorts(backend, out, err, async (question) => {
      asked.push(question);
      return question.choices.indexOf('Save this account');
    });
    expect(await authLogin(ports, { provider: 'chatgpt', browser: false })).toBe(EXIT_OK);
    expect(asked).toEqual([{ question: 'The sign-in at ChatGPT is for ada@example.com. Save this account under the label chatgpt?', choices: ['Cancel', 'Save this account'] }]);
    expect(completions(backend)[1]).toEqual({ attemptId: 'attempt-1', identityConfirmed: true });
  });

  it('names an identity without an email by its account id', async () => {
    const out = writer();
    const err = writer();
    const asked: Asked[] = [];
    const backend = fakePlanBackend({ accounts: [], complete: { ...IDENTITY_UNCONFIRMED, identity: { subject: 'sub-1' } } });
    const ports = terminalPorts(backend, out, err, async (question) => {
      asked.push(question);
      return undefined;
    });
    await authLogin(ports, { provider: 'chatgpt', browser: false });
    expect(asked[0]?.question).toBe('The sign-in at ChatGPT is for the account id sub-1. Save this account under the label chatgpt?');
  });

  it.for([
    ['chooses Cancel', 0],
    ['gives no answer', undefined],
  ] as const)('in a terminal saves nothing when the person %s: the attempt is cancelled, exit 1', async ([_label, index]) => {
    const out = writer();
    const err = writer();
    const backend = fakePlanBackend({ accounts: [], complete: IDENTITY_UNCONFIRMED });
    const ports = terminalPorts(backend, out, err, async () => index);
    expect(await authLogin(ports, { provider: 'chatgpt', browser: false })).toBe(EXIT_FAILURE);
    expect(completions(backend)).toHaveLength(1);
    expect(cancellations(backend)).toEqual([{ attemptId: 'attempt-1' }]);
    expect(err.written.join('')).toContain('was not saved under the label chatgpt, because the account was not confirmed.');
  });

  it('a question nobody answers ends with the wait of the sign-in: the attempt is cancelled and the try-again command is named', async () => {
    const out = writer();
    const err = writer();
    const timers = createFakeTimers(createFakeClock(0));
    const backend = fakePlanBackend({ accounts: [], complete: IDENTITY_UNCONFIRMED });
    let questionOpen: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      questionOpen = resolve;
    });
    const ports = terminalPorts(
      backend,
      out,
      err,
      (_asked, until) =>
        new Promise<number | undefined>((_resolve, reject) => {
          if (until === undefined) throw new Error('the question has no bound');
          until.addEventListener('abort', () => reject(until.reason), { once: true });
          questionOpen();
        }),
      timers,
    );
    const ended = authLogin(ports, { provider: 'chatgpt', browser: false });
    await opened;
    timers.advance(AUTHORIZATION_WAIT_MS);
    expect(await ended).toBe(EXIT_FAILURE);
    expect(cancellations(backend)).toEqual([{ attemptId: 'attempt-1' }]);
    expect(err.written.join('')).toContain(`Run ${SAVE_COMMAND} to try again.`);
  });
});

const serveComplete = async (context: TestContext, answer: unknown) => {
  const socketPath = path.join(withTempDir(context), 'g.sock');
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = createGatewayClient({ resolveSocket: fixedSocket(socketPath) });
  registerCleanup(context, async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return client;
};

describe('the gateway client reads the sign-in outcome that waits for the confirmation', () => {
  const request = { attemptId: 'attempt-1', callbackUrl: 'http://127.0.0.1:1/auth/callback?code=c&state=s' };

  it('accepts identity_unconfirmed with the attempt, the identity and the expiry', async (context) => {
    const client = await serveComplete(context, IDENTITY_UNCONFIRMED);
    expect(await client.plan.signInComplete(request)).toEqual(IDENTITY_UNCONFIRMED);
  });

  it('accepts an identity that has no email', async (context) => {
    const answer = { ...IDENTITY_UNCONFIRMED, identity: { subject: 'sub-1' } };
    const client = await serveComplete(context, answer);
    expect(await client.plan.signInComplete(request)).toEqual(answer);
  });

  it.for([
    ['no subject', { ...IDENTITY_UNCONFIRMED, identity: { email: 'ada@example.com' } }],
    ['no attempt', { outcome: 'identity_unconfirmed', identity: { subject: 'sub-1' }, expiresAt: '2026-11-10T00:10:00.000Z' }],
    ['no expiry', { outcome: 'identity_unconfirmed', attemptId: 'attempt-1', identity: { subject: 'sub-1' } }],
  ] as const)('refuses identity_unconfirmed with %s', async ([_label, answer], context) => {
    const client = await serveComplete(context, answer);
    await expect(client.plan.signInComplete(request)).rejects.toThrow('not a sign-in outcome');
  });
});
