import { describe, expect, it, vi } from 'vitest';
import { GatewayAnswerError } from '../src/client/gateway-client.ts';
import { untilFrame } from './ink-helpers.ts';
import { PLAN_TEST_TIMEOUT_MS, startPlan, submitLine } from './fake-plan-gateway.tsx';

vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const ERROR_COLOUR = /\u001b\[(?:31|38;5;(?:203|124)|38;2;(?:244;112;103|179;38;30))m/;

const DIM = '\u001b[2m';

const SENTENCE = 'ChatGPT returned a sign-in response this version cannot use (the token response has no access token). Nothing was saved.';

const lineWith = (frame: string, text: string): string => frame.split('\n').find((line) => line.includes(text)) ?? '';

describe('/login: a sign-in that ended in failure is drawn in the error style of the transcript, never as a dim notice (sign-in 13.5)', () => {
  it('a sign-in response the gateway could not use is shown in the error colour', async () => {
    const { app } = await startPlan({ accounts: [], completeFails: new GatewayAnswerError('POST answered 502', 502, { code: 'token_response_invalid', message: SENTENCE }) });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login chatgpt');
    const frame = await untilFrame(app, 'Nothing was saved.');
    const line = lineWith(frame, 'ChatGPT returned');
    expect(line).toMatch(ERROR_COLOUR);
    expect(line.startsWith(DIM)).toBe(false);
    app.unmount();
  });

  it('a gateway that stopped before the sign-in finished is shown in the error colour', async () => {
    const { app } = await startPlan({ accounts: [], completeFails: new Error('socket hang up') });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login chatgpt');
    const frame = await untilFrame(app, 'The gateway stopped before the sign-in finished.');
    expect(lineWith(frame, 'The gateway stopped')).toMatch(ERROR_COLOUR);
    app.unmount();
  });

  it('a code the issuer did not accept is shown in the error colour', async () => {
    const { app } = await startPlan({ accounts: [], complete: { outcome: 'retry', reason: 'invalid_grant' } });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login chatgpt');
    const frame = await untilFrame(app, (shown) => /did not accept the sign-in code/.test(shown));
    expect(frame.split('\n').find((line) => /did not accept the sign-in code/.test(line))).toMatch(ERROR_COLOUR);
    app.unmount();
  });
});
