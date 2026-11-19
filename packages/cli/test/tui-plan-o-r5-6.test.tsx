import { describe, expect, it, vi } from 'vitest';
import { runView } from './fake-backend.ts';
import { untilFrame, untilOutput } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { runStarted } from './tui-harness.tsx';
import { CHATGPT, LISTENER_PORT, PLAN_TEST_TIMEOUT_MS, account, choose, eventually, rowNumberOf, startPlan, submitLine, untilRow, untilTypedAfter } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';

const PASTE_LABEL = 'On a remote machine? Paste the redirect URL here';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const NOT_ENABLED_MESSAGE = 'Plan use is not enabled for this account.';
const NOT_ELIGIBLE_MESSAGE = 'This account is not eligible for plan use in this app.';
const PLAN = { profile: 'chatgpt', account: 'work' };

const ready = async (app: Instance): Promise<void> => {
  await untilFrame(app, 'mode: manual');
};

const failWith = (backend: FakePlanBackend, code: string, message: string, plan: { profile: string; account?: string } = PLAN): void => {
  backend.finish(runView({ status: 'FAILED', error: { code, message, plan } }));
};

const expectIdentityBeforeMessage = (block: string, message: string): void => {
  const at = block.indexOf(message);
  expect(at).toBeGreaterThan(-1);
  expect(block.lastIndexOf(CHATGPT.messages.identityLabel, at)).toBeGreaterThan(-1);
};

describe('the plan_use_not_enabled block of the TUI (P6.5, O-R5-6 designed and not built 3)', () => {
  it('shows the identity line, the message and the picker Enable ChatGPT plan use, Use an API key, with no retry', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'work', state: 'plan_disabled' })] });
    await ready(app);
    await runStarted(backend, app, 'go');
    failWith(backend, 'plan_use_not_enabled', NOT_ENABLED_MESSAGE);
    const block = await untilRow(app, 'Enable ChatGPT plan use');
    expectIdentityBeforeMessage(block, NOT_ENABLED_MESSAGE);
    expect(rowNumberOf(block, 'Enable ChatGPT plan use')).toBe(1);
    expect(rowNumberOf(block, 'Use an API key')).toBe(2);
    expect(block).not.toMatch(/retry/i);
    app.unmount();
  });

  it('Enable ChatGPT plan use shows the description under the row and opens the sign-in of error.plan.account with reconsent at once, with no second list', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'work', state: 'plan_disabled' })], callbackArrives: false });
    await ready(app);
    await runStarted(backend, app, 'go');
    failWith(backend, 'plan_use_not_enabled', NOT_ENABLED_MESSAGE);
    const block = await untilRow(app, 'Enable ChatGPT plan use');
    expect(block.replace(/\s+/g, ' ')).toContain(CHATGPT.messages.description);
    await choose(app, 'Enable ChatGPT plan use');
    const waiting = await untilFrame(app, PASTE_LABEL);
    expect(waiting.replace(/\s+/g, ' ')).toContain(CHATGPT.messages.description);
    expect(waiting).not.toContain(CHATGPT.messages.apiKeyLabel);
    await eventually(() => backend.planCalls.some((call) => call.route === 'sign-in/begin'), 'the sign-in begin');
    expect(backend.planCalls.find((call) => call.route === 'sign-in/begin')?.body).toEqual({ profile: 'chatgpt', account: 'work', port: LISTENER_PORT, reconsent: true });
    app.unmount();
  });

  it('with a plan that names no account, shows the identity line alone and Enable opens the account choice of the profile', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'work', state: 'plan_disabled' })], callbackArrives: false });
    await ready(app);
    await runStarted(backend, app, 'go');
    failWith(backend, 'plan_use_not_enabled', NOT_ENABLED_MESSAGE, { profile: 'chatgpt' });
    const block = await untilRow(app, 'Enable ChatGPT plan use');
    expect(block).toContain(`${CHATGPT.messages.identityLabel}\n`);
    expect(block).not.toContain(`${CHATGPT.messages.identityLabel} ·`);
    expect(block).not.toContain('undefined');
    await choose(app, 'Enable ChatGPT plan use');
    const picker = await untilRow(app, 'Add another account or workspace');
    expect(picker).toContain(CHATGPT.messages.pickerLabel);
    expect(backend.planCalls.some((call) => call.route === 'sign-in/begin')).toBe(false);
    app.unmount();
  });
});

describe('the plan_not_eligible block of the TUI (P6.5, O-R5-6 designed and not built 3)', () => {
  it('shows the identity line, the server message and the picker Use another account, Use an API key, Dismiss, with no retry', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'work' })] });
    await ready(app);
    await runStarted(backend, app, 'go');
    failWith(backend, 'plan_not_eligible', NOT_ELIGIBLE_MESSAGE);
    const block = await untilFrame(app, 'Use another account');
    expectIdentityBeforeMessage(block, NOT_ELIGIBLE_MESSAGE);
    expect(rowNumberOf(block, 'Use another account')).toBe(1);
    expect(rowNumberOf(block, 'Use an API key')).toBe(2);
    expect(rowNumberOf(block, 'Dismiss')).toBe(3);
    expect(block).not.toMatch(/retry/i);
    app.unmount();
  });
});

describe('the account picker shows the files the gateway could not list (O-R5-6 D)', () => {
  it('prints could not list <file name>: <cause> as an info line', async () => {
    const { app } = await startPlan({ accounts: [account({ label: 'work', email: 'w@example.com' })], listProblems: [{ file: 'abc123.json', cause: 'the file mode is 644' }] });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    await untilOutput(app, 'could not list abc123.json: the file mode is 644');
    app.unmount();
  });
});

describe('a sign-in listener that cannot start (O-R5-6 A)', () => {
  it('prints the listener failure as an info line and calls no begin', async () => {
    const { app, backend } = await startPlan({ accounts: [], listenerFails: new Error('bind refused') });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    await untilOutput(app, 'Could not start the local sign-in listener (bind refused). Nothing was changed.');
    await untilTypedAfter(app);
    expect(backend.planCalls.map((call) => call.route)).not.toContain('sign-in/begin');
    app.unmount();
  });
});
