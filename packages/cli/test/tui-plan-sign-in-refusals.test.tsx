import { describe, expect, it, vi } from 'vitest';
import { GatewayAnswerError } from '../src/client/gateway-client.ts';
import { untilFrame } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { PLAN_TEST_TIMEOUT_MS, account, choose, eventually, startPlan, submitLine, untilTypedAfter } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const TRANSPORT_TEXT = 'POST /v1/momonga/plan/sign-in/complete answered 400: {"error":{}}';

const flat = (frame: string): string => frame.replace(/\s+/g, ' ');

const signInFromLogin = async (app: Instance): Promise<void> => {
  await untilFrame(app, 'mode: manual');
  await submitLine(app, '/login chatgpt');
  await choose(app, 'Continue with ChatGPT');
};

const begun = (backend: FakePlanBackend): unknown[] => backend.planCalls.filter((call) => call.route === 'sign-in/begin').map((call) => call.body);

describe('/login: a refused sign-in is one notice with the message of the answer and the way forward (gateway-accounts C29)', () => {
  it('access_denied shows the message once with /login, and no transport text', async () => {
    const { app } = await startPlan({ accounts: [], completeFails: new GatewayAnswerError(TRANSPORT_TEXT, 400, { code: 'access_denied', message: 'Sign-in was cancelled in the browser.' }) });
    await signInFromLogin(app);
    const shown = flat(await untilFrame(app, 'Sign-in was cancelled in the browser.'));
    const settled = flat(await untilTypedAfter(app));
    expect(settled).toContain('Sign-in was cancelled in the browser. Run /login to try again.');
    expect(settled.split('Sign-in was cancelled in the browser.')).toHaveLength(2);
    expect(settled).not.toContain('POST');
    app.unmount();
  });

  it('a stopped gateway keeps its sentence and names /login', async () => {
    const { app } = await startPlan({ accounts: [], completeFails: new Error('socket hang up') });
    await signInFromLogin(app);
    const shown = flat(await untilFrame(app, 'The gateway stopped before the sign-in finished.'));
    expect(shown).toContain('The gateway stopped before the sign-in finished. Run /login to try again.');
    app.unmount();
  });

  it('plan use that is not enabled offers to enable it for the label of the answer', async () => {
    const { app, backend } = await startPlan({ accounts: [], complete: { outcome: 'plan_disabled', account: account({ label: 'work', state: 'plan_disabled' }), firstSignIn: false } });
    await signInFromLogin(app);
    await choose(app, 'Enable ChatGPT plan use');
    await eventually(() => begun(backend).length === 2, 'the second sign-in start');
    expect(begun(backend)[1]).toMatchObject({ profile: 'chatgpt', account: 'work', reconsent: true });
    app.unmount();
  });
});
