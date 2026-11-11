import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { EXIT_FAILURE, systemTiming } from '@momonga/foundation';
import { GatewayAnswerError } from '../src/client/gateway-client.ts';
import { authLogin } from '../src/commands/auth.ts';
import { fakePlanBackend } from './fake-plan-gateway.tsx';

describe("momonga auth login: a pasted redirect that carries error= is the gateway's to judge (settlement E-05)", () => {
  it('the pasted line is sent whole, and the refusal of the answer is printed with the try-again command: exit 1', async () => {
    const refused = new GatewayAnswerError('POST /v1/momonga/plan/sign-in/complete answered 400', 400, { code: 'access_denied', message: 'Sign-in was cancelled in the browser.' });
    const backend = fakePlanBackend({ accounts: [], callbackArrives: false, completeFails: refused });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdin = new PassThrough();
    const echoed = new PassThrough();
    echoed.resume();
    const denied = 'http://127.0.0.1:49152/auth/callback?error=access_denied&state=st-1';
    const code = await authLogin(
      {
        stdout: { write: (text) => void stdout.push(text) },
        stderr: { write: (text) => void stderr.push(text) },
        plan: backend.plan,
        startListener: backend.startSignInListener,
        openUrl: () => {
          stdin.write(`${denied}\n`);
          return Promise.resolve();
        },
        sandbox: async () => 'seatbelt' as const,
        signal: new AbortController().signal,
        timers: systemTiming,
        isTerminal: true,
        choose: async () => undefined,
        terminal: { stdin, stdout: echoed },
      },
      { provider: 'chatgpt' },
    );
    expect(code).toBe(EXIT_FAILURE);
    expect(backend.planCalls.filter((call) => call.route === 'sign-in/complete').map((call) => call.body)).toEqual([{ attemptId: 'attempt-1', callbackUrl: denied }]);
    expect(stderr.join('')).toBe('Sign-in was cancelled in the browser. Run momonga auth login chatgpt --account chatgpt to try again.\n');
  });
});
