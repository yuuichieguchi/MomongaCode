import { pollUntil } from '@momonga/testkit';
import { describe, expect, it, vi } from 'vitest';
import { KEYS, untilFrame, untilOutput } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { AUTHORIZATION_URL, PLAN_TEST_TIMEOUT_MS, choose, eventually, startPlan, submitLine, untilPromptDrawn, untilTypedAfter } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';
import { GatewayAnswerError } from '../src/client/gateway-client.ts';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const PASTE_LABEL = 'On a remote machine? Paste the redirect URL here';
const TOO_LONG = 'That text is too long to be a redirect URL.';
const NOT_REDIRECT = 'That is not a redirect URL from the browser.';
const OTHER_SIGN_IN = 'That URL did not belong to this sign-in. Paste the URL again.';
const PASTED_CALLBACK_CAP_BYTES = 8 * 1024;

const routesOf = (backend: FakePlanBackend): string[] => backend.planCalls.map((call) => call.route);

const bodiesOf = (backend: FakePlanBackend, route: string): unknown[] => backend.planCalls.filter((call) => call.route === route).map((call) => call.body);

const HINT = 'enter submits the pasted URL · ctrl+y copies the sign-in URL · esc cancels';
const CTRL_Y = '\u0019';

const waitingScreen = async (options: { completeHeld?: Promise<void>; completeFails?: Error } = {}) => {
  const started = await startPlan({ accounts: [], callbackArrives: false, ...options });
  await untilFrame(started.app, 'mode: manual');
  await submitLine(started.app, '/login chatgpt');
  await untilFrame(started.app, PASTE_LABEL);
  return started;
};

const paste = (app: Instance, text: string): void => {
  app.stdin.write(text);
  app.stdin.write(KEYS.enter);
};

const expectStillWaiting = (app: Instance, backend: FakePlanBackend): void => {
  expect(routesOf(backend)).not.toContain('sign-in/complete');
  expect(routesOf(backend)).not.toContain('sign-in/cancel');
  expect(app.lastFrame() ?? '').toContain(PASTE_LABEL);
};

describe('the paste box of the sign-in waiting screen (P6.6, D11, O-R5-4 S2)', () => {
  it('shows the authorization URL and the input labelled for a remote machine while it waits', async () => {
    const { app, backend } = await waitingScreen();
    const screen = app.lastFrame() ?? '';
    expect(screen).toContain(PASTE_LABEL);
    expect(screen.replace(/\s+/g, '')).toContain(AUTHORIZATION_URL);
    expect(routesOf(backend)).toContain('sign-in/begin');
    app.unmount();
  });

  it('refuses text over 8 KiB of UTF-8 without sending anything or ending the wait', async () => {
    const { app, backend } = await waitingScreen();
    paste(app, `https://localhost:1/x?code=c&state=st-1&pad=${'a'.repeat(PASTED_CALLBACK_CAP_BYTES)}`);
    await untilFrame(app, TOO_LONG);
    expectStillWaiting(app, backend);
    app.unmount();
  });

  it('refuses text that is not a URL with a state and a code or error, without sending anything or ending the wait', async () => {
    const { app, backend } = await waitingScreen();
    paste(app, 'not a url');
    await untilFrame(app, NOT_REDIRECT);
    expectStillWaiting(app, backend);
    app.unmount();
  });

  it('compares the state before anything is sent, keeps waiting, and completes with the next valid paste sent whole, whatever its host, port and path', async () => {
    const { app, backend } = await waitingScreen();
    paste(app, 'https://localhost:1/x?code=c&state=st-other');
    await untilFrame(app, OTHER_SIGN_IN);
    expectStillWaiting(app, backend);

    const valid = 'https://localhost:1/anything?code=pasted-code&state=st-1';
    paste(app, valid);
    await untilFrame(app, 'Signed in as chatgpt');
    expect(bodiesOf(backend, 'sign-in/complete')).toEqual([{ attemptId: 'attempt-1', callbackUrl: valid }]);
    expect(routesOf(backend)).not.toContain('sign-in/cancel');
    app.unmount();
  });

  it('shows the typed text in the input as > <text> and the hint line of the screen', async () => {
    const { app } = await waitingScreen();
    app.stdin.write('typed-text');
    const frame = await untilFrame(app, '> typed-text');
    expect(frame).toContain(HINT);
    app.unmount();
  });

  it('does nothing on Enter with a blank input', async () => {
    const { app, backend } = await waitingScreen();
    app.stdin.write('   ');
    app.stdin.write(KEYS.enter);
    await untilTypedAfter(app);
    expectStillWaiting(app, backend);
    const frame = app.lastFrame() ?? '';
    for (const sentence of [TOO_LONG, NOT_REDIRECT, OTHER_SIGN_IN]) expect(frame).not.toContain(sentence);
    app.unmount();
  });

  it('clears the input when a value is refused', async () => {
    const { app } = await waitingScreen();
    paste(app, 'refused-value');
    const frame = await untilFrame(app, NOT_REDIRECT);
    expect(frame).not.toContain('refused-value');
    app.unmount();
  });

  it('refuses a paste of 8193 bytes as too long and a paste of 8192 bytes as not a redirect URL', async () => {
    const { app, backend } = await waitingScreen();
    paste(app, 'a'.repeat(PASTED_CALLBACK_CAP_BYTES + 1));
    await untilFrame(app, TOO_LONG);
    expectStillWaiting(app, backend);
    paste(app, 'a'.repeat(PASTED_CALLBACK_CAP_BYTES));
    await untilFrame(app, NOT_REDIRECT);
    expectStillWaiting(app, backend);
    app.unmount();
  });

  it.each([
    ['esc', KEYS.escape],
    ['ctrl+c', KEYS.ctrlC],
  ])('%s with text in the input cancels the sign-in once and says so', async (_name, key) => {
    const { app, backend } = await waitingScreen();
    app.stdin.write('half-typed');
    await untilFrame(app, '> half-typed');
    app.stdin.write(key);
    await untilOutput(app, 'sign-in cancelled');
    await untilPromptDrawn(app);
    await untilTypedAfter(app);
    expect(bodiesOf(backend, 'sign-in/cancel')).toEqual([{ attemptId: 'attempt-1' }]);
    expect(routesOf(backend)).not.toContain('sign-in/complete');
    app.unmount();
  });

  it('after a valid paste shows Finishing the sign-in…, and esc then cancels the sign-in: it is not kept', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, backend } = await waitingScreen({ completeHeld: held });
    paste(app, 'https://localhost:1/anything?code=pasted-code&state=st-1');
    const frame = await untilFrame(app, 'Finishing the sign-in…');
    expect(frame).toContain('please wait');
    expect(frame).not.toContain(PASTE_LABEL);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => !shown.includes('Finishing the sign-in…'));
    release();
    await held;
    await Promise.resolve();
    await pollUntil(async () => (await backend.plan.accounts()).accounts.every((listed) => listed.state !== 'active'), { description: 'the sign-in not kept', boundMs: 10_000 });
    expect(app.frames.some((shown) => shown.includes('Signed in as chatgpt'))).toBe(false);
    app.unmount();
  });

  it('a loopback callback marks the screen delivered, and esc then cancels the sign-in: the screen closes and it is not kept', async () => {
    const held = new Promise<void>(() => undefined);
    const { app, backend } = await startPlan({ accounts: [], callbackArrives: true, completeHeld: held });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login chatgpt');
    await eventually(() => routesOf(backend).includes('sign-in/complete'), 'the delivery of the callback');
    const frame = await untilFrame(app, 'Finishing the sign-in…');
    expect(frame).not.toContain(PASTE_LABEL);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => !shown.includes('Finishing the sign-in…'));
    expect((await backend.plan.accounts()).accounts.filter((listed) => listed.state === 'active')).toEqual([]);
    app.unmount();
  });

  it('ctrl+y asks the terminal to copy the sign-in URL through copyToClipboard and says so', async () => {
    const { app, backend } = await waitingScreen();
    app.stdin.write(CTRL_Y);
    await untilFrame(app, 'Asked the terminal to copy the sign-in URL.');
    expect(backend.clipboard).toEqual([new URL(AUTHORIZATION_URL).href]);
    app.unmount();
  });

  it('after delivery Ctrl-Y, Enter and a paste change nothing: no copy, no second completion, no cancel (C-06, C-07)', async () => {
    const held = new Promise<void>(() => undefined);
    const { app, backend } = await waitingScreen({ completeHeld: held });
    const valid = 'https://localhost:1/anything?code=pasted-code&state=st-1';
    paste(app, valid);
    await untilFrame(app, 'Finishing the sign-in…');
    app.stdin.write(CTRL_Y);
    app.stdin.write(KEYS.enter);
    paste(app, 'https://localhost:1/anything?code=second-code&state=st-1');
    expect(backend.clipboard).toEqual([]);
    expect(bodiesOf(backend, 'sign-in/complete')).toEqual([{ attemptId: 'attempt-1', callbackUrl: valid }]);
    expect(routesOf(backend)).not.toContain('sign-in/cancel');
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Finishing the sign-in…');
    expect(frame).not.toContain('second-code');
    app.unmount();
  });

  it('a pasted redirect is echoed as typed before it is submitted (N-B3, B-11)', async () => {
    const { app } = await waitingScreen();
    app.stdin.write('https://localhost:1/x?code=pasted-code&state=st-1');
    const frame = await untilFrame(app, 'code=pasted-code');
    expect(frame.replace(/\s+/g, '')).toContain('>https://localhost:1/x?code=pasted-code&state=st-1');
    app.unmount();
  });

  it('a pasted redirect that carries error= is sent whole, and the refusal of the answer is shown with the way forward (E-04)', async () => {
    const refused = new GatewayAnswerError('POST /v1/momonga/plan/sign-in/complete answered 400', 400, { code: 'access_denied', message: 'Sign-in was cancelled in the browser.' });
    const { app, backend } = await waitingScreen({ completeFails: refused });
    const denied = 'https://localhost:1/anything?error=access_denied&state=st-1';
    paste(app, denied);
    const shown = (await untilFrame(app, 'Sign-in was cancelled in the browser.')).replace(/\s+/g, ' ');
    expect(shown).toContain('Sign-in was cancelled in the browser. Run /login to try again.');
    expect(bodiesOf(backend, 'sign-in/complete')).toEqual([{ attemptId: 'attempt-1', callbackUrl: denied }]);
    for (const sentence of [TOO_LONG, NOT_REDIRECT, OTHER_SIGN_IN]) expect(shown).not.toContain(sentence);
    app.unmount();
  });

  it.each([
    ['a cancelled sign-in', async (app: Instance) => {
      app.stdin.write(KEYS.escape);
      await untilOutput(app, 'sign-in cancelled');
    }],
    ['a finished sign-in', async (app: Instance) => {
      paste(app, 'https://localhost:1/anything?code=pasted-code&state=st-1');
      await untilFrame(app, 'Signed in as chatgpt');
    }],
  ] as const)('after %s the screen holds neither the sign-in URL nor the pasted redirect, and the input history does not bring them back (B)', async (_name, end) => {
    const { app } = await waitingScreen();
    await end(app);
    await untilPromptDrawn(app);
    app.stdin.write(KEYS.up);
    const frame = (await untilFrame(app, '> /login chatgpt')).replace(/\s+/g, '');
    expect(frame).not.toContain('auth.openai.com/api/accounts/authorize');
    expect(frame).not.toContain('pasted-code');
    expect(frame).not.toContain('state=st-1');
    app.unmount();
  });
});
