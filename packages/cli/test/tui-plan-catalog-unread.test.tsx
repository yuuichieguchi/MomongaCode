import { describe, expect, it, vi } from 'vitest';
import { GatewayAnswerError } from '../src/client/gateway-client.ts';
import { untilFrame } from './ink-helpers.ts';
import { PLAN_TEST_TIMEOUT_MS, account, startPlan, submitLine } from './fake-plan-gateway.tsx';

vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const ERROR_COLOUR = /\u001b\[(?:31|38;5;(?:203|124)|38;2;(?:244;112;103|179;38;30))m/;

const OVER_BOUND = 'the ChatGPT model list is larger than 16777216 bytes';

const HINT = 'To use a model of chatgpt by its name: momonga models add --plan chatgpt --account chatgpt --model <own name> --window <tokens> --yes';

const lineWith = (frame: string, text: string): string => frame.split('\n').find((line) => line.includes(text)) ?? '';

describe('/login: a model list that cannot be read after a sign-in leaves a way forward', () => {
  it('shows the error in the error style, then the complete command that adds a plan model by its name, and the account stays signed in', async () => {
    const signedIn = account({ pinnedBy: [] });
    const { app, backend } = await startPlan({
      accounts: [],
      complete: { outcome: 'signed_in', account: signedIn, firstSignIn: false },
      catalogFailures: { chatgpt: new GatewayAnswerError(OVER_BOUND, 502, { code: 'list_invalid', message: OVER_BOUND }) },
    });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login chatgpt');
    const frame = await untilFrame(app, (shown) => shown.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').includes('--window <tokens> --yes'));
    expect(lineWith(frame, OVER_BOUND)).toMatch(ERROR_COLOUR);
    const plain = frame.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toContain('Signed in as');
    expect(plain.replace(/\s+/g, ' ')).toContain(HINT);
    expect(plain).not.toContain('Choose a model of chatgpt');
    expect(backend.planCalls.some((call) => call.route === 'sign-out')).toBe(false);
    app.unmount();
  });
});
