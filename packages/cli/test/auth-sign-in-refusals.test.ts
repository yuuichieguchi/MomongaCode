import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_INTERRUPTED, fixedSocket, systemTiming } from '@momonga/foundation';
import { GatewayAnswerError, createGatewayClient } from '../src/client/gateway-client.ts';
import { authLogin } from '../src/commands/auth.ts';
import type { AuthLoginPorts } from '../src/commands/auth.ts';
import * as texts from '../src/plan/texts.ts';
import { CHATGPT, account, fakePlanBackend } from './fake-plan-gateway.tsx';
import type { FakePlanBackend, FakePlanOptions } from './fake-plan-gateway.tsx';

const writer = () => {
  const written: string[] = [];
  return { written, write: (text: string): void => void written.push(text) };
};

const TRY_AGAIN = 'Run momonga auth login chatgpt --account chatgpt to try again.';

const TRANSPORT_TEXT = 'POST /v1/momonga/plan/sign-in/complete answered 400: {"error":{}}';

const refusal = (code: string, message: string): GatewayAnswerError => new GatewayAnswerError(TRANSPORT_TEXT, 400, { code, message });

const login = async (options: FakePlanOptions, ports: Partial<AuthLoginPorts> = {}) => {
  const out = writer();
  const err = writer();
  const backend: FakePlanBackend = fakePlanBackend({ accounts: [], ...options });
  const code = await authLogin(
    {
      stdout: out,
      stderr: err,
      plan: backend.plan,
      startListener: backend.startSignInListener,
      openUrl: () => Promise.resolve(),
      sandbox: async () => 'seatbelt' as const,
      signal: new AbortController().signal,
      timers: systemTiming,
      isTerminal: false,
      ...ports,
    } as AuthLoginPorts,
    { provider: 'chatgpt' },
  );
  return { code, stdout: out.written.join(''), stderr: err.written.join(''), backend };
};

describe('momonga auth login: a refused sign-in shows the message of the answer, then the way forward (gateway-accounts C29)', () => {
  it.for([
    ['access_denied', 'Sign-in was cancelled in the browser.'],
    ['authorization_failed', 'ChatGPT refused the sign-in (server_error).'],
    ['exchange_unavailable', 'ChatGPT could not be reached to finish the sign-in.'],
    ['identity_mismatch', 'The account that signed in is not the account saved under this label. Nothing was changed.'],
  ] as const)('%s: stderr is the message and the try-again line, exit 1, no transport text', async ([code, message]) => {
    const ended = await login({ completeFails: refusal(code, message) });
    expect(ended.code).toBe(EXIT_FAILURE);
    expect(ended.stderr).toBe(`${message} ${TRY_AGAIN}\n`);
    expect(ended.stderr).not.toContain('POST');
    expect(ended.stdout).not.toContain('POST');
  });

  it('a stopped gateway keeps its sentence and names the try-again command', async () => {
    const ended = await login({ completeFails: new Error('socket hang up') });
    expect(ended.code).toBe(EXIT_FAILURE);
    expect(ended.stderr).toBe(`The gateway stopped before the sign-in finished. ${TRY_AGAIN}\n`);
  });

  it('a code the provider did not accept says so with the try-again command: exit 1', async () => {
    const ended = await login({ complete: { outcome: 'retry', reason: 'invalid_grant' } });
    expect(ended.code).toBe(EXIT_FAILURE);
    expect(ended.stderr).toBe(`ChatGPT did not accept the sign-in code (invalid_grant). ${TRY_AGAIN}\n`);
  });

  it('plan use that is not enabled names the reconsent command with the label of the answer', async () => {
    const ended = await login({ complete: { outcome: 'plan_disabled', account: account({ label: 'work', state: 'plan_disabled' }), firstSignIn: false } });
    expect(ended.code).toBe(EXIT_FAILURE);
    expect(ended.stderr).toBe(`${CHATGPT.messages.planNotEnabledMessage} · Run momonga auth login chatgpt --account work --reconsent to enable it\n`);
  });

  it('a browser that could not be opened prints the URL and the one sentence of the texts', async () => {
    const ended = await login(
      {},
      {
        openUrl: (_url, _signal, failed) => {
          failed('spawn xdg-open ENOENT');
          return Promise.resolve();
        },
      },
    );
    expect(texts.browserNotOpenedLine('spawn xdg-open ENOENT')).toBe('Could not open the browser (spawn xdg-open ENOENT). Open the URL above to continue.');
    expect(ended.stderr).toBe(`${texts.browserNotOpenedLine('spawn xdg-open ENOENT')}\n`);
  });

  it('an interrupted sign-in prints the one cancel sentence: exit 130', async () => {
    const interrupt = new AbortController();
    const ended = await login(
      { callbackArrives: false },
      {
        signal: interrupt.signal,
        openUrl: () => {
          interrupt.abort(new Error('interrupted'));
          return Promise.resolve();
        },
      },
    );
    expect(texts.cancelledLine('sign-in')).toBe('momonga: sign-in cancelled');
    expect(ended.code).toBe(EXIT_INTERRUPTED);
    expect(ended.stderr).toBe(`${texts.cancelledLine('sign-in')}\n`);
  });
});

describe('the gateway client never shows an answer that has a message as transport text', () => {
  it('the error of a refused plan request reads as the message the gateway wrote', async (context) => {
    const socketPath = path.join(withTempDir(context), 'g.sock');
    const server = http.createServer((request, response) => {
      request.resume();
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'access_denied', message: 'Sign-in was cancelled in the browser.' } }));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = createGatewayClient({ resolveSocket: fixedSocket(socketPath) });
    registerCleanup(context, async () => {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const failure: unknown = await client.plan.signInComplete({ attemptId: 'a', callbackUrl: 'http://127.0.0.1:1/auth/callback?code=c&state=s' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayAnswerError);
    expect((failure as GatewayAnswerError).message).toBe('Sign-in was cancelled in the browser.');
    expect((failure as GatewayAnswerError).answer).toEqual({ code: 'access_denied', message: 'Sign-in was cancelled in the browser.' });
  });
});
