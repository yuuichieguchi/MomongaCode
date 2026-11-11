import { describe, expect, it, vi } from 'vitest';
import { KEYS, untilFrame } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { IDENTITY_UNCONFIRMED, PLAN_TEST_TIMEOUT_MS, account, choose, eventually, quiet, rowNumberOf, startPlan, submitLine, untilRow } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const QUESTION = 'The sign-in at ChatGPT is for ada@example.com. Save this account under the label chatgpt?';

const completions = (backend: FakePlanBackend): unknown[] => backend.planCalls.filter((call) => call.route === 'sign-in/complete').map((call) => call.body);

const cancellations = (backend: FakePlanBackend): unknown[] => backend.planCalls.filter((call) => call.route === 'sign-in/cancel').map((call) => call.body);

const toTheQuestion = async (app: Instance): Promise<string> => {
  await untilFrame(app, 'mode: manual');
  await submitLine(app, '/login chatgpt');
  await choose(app, 'Continue with ChatGPT');
  return untilRow(app, 'Save this account');
};

describe('/login: the first sign-in of an account is saved only after the person confirms its identity (gateway-accounts C51)', () => {
  it('shows the identity the sign-in answered and the label, with Cancel under the cursor', async () => {
    const { app, backend } = await startPlan({ accounts: [], complete: IDENTITY_UNCONFIRMED });
    const shown = await toTheQuestion(app);
    expect(shown.replace(/\s+/g, ' ')).toContain(QUESTION);
    expect(rowNumberOf(shown, 'Cancel')).toBe(1);
    expect(rowNumberOf(shown, 'Save this account')).toBe(2);
    expect(completions(backend)).toHaveLength(1);
    app.unmount();
  });

  it('Enter on the question as it appears saves nothing: the attempt is cancelled and the notice says why', async () => {
    const { app, backend } = await startPlan({ accounts: [], complete: IDENTITY_UNCONFIRMED });
    await toTheQuestion(app);
    app.stdin.write(KEYS.enter);
    await eventually(() => cancellations(backend).length === 1, 'the cancellation of the attempt');
    const shown = await untilFrame(app, 'because the account was not confirmed');
    expect(shown.replace(/\s+/g, ' ')).toContain('The sign-in for ada@example.com was not saved under the label chatgpt, because the account was not confirmed. Run /login to sign in again.');
    await quiet();
    expect(completions(backend)).toHaveLength(1);
    expect(cancellations(backend)).toEqual([{ attemptId: 'attempt-1' }]);
    app.unmount();
  });

  it('choosing to save confirms the identity and signs the account in', async () => {
    const { app, backend } = await startPlan({ accounts: [], complete: IDENTITY_UNCONFIRMED, confirmed: { outcome: 'signed_in', account: account(), firstSignIn: false } });
    await toTheQuestion(app);
    await choose(app, 'Save this account');
    await eventually(() => completions(backend).length === 2, 'the confirmation');
    expect(completions(backend)[1]).toEqual({ attemptId: 'attempt-1', identityConfirmed: true });
    await untilFrame(app, 'Signed in as chatgpt (ada@example.com)');
    expect(cancellations(backend)).toEqual([]);
    app.unmount();
  });
});
