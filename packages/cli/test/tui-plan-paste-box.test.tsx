import { describe, expect, it, vi } from 'vitest';
import { KEYS, untilFrame, untilOutput } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { AUTHORIZATION_URL, PLAN_TEST_TIMEOUT_MS, choose, eventually, quiet, startPlan, submitLine } from './fake-plan-gateway.tsx';
import type { FakePlanBackend } from './fake-plan-gateway.tsx';

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

const waitingScreen = async (options: { completeHeld?: Promise<void> } = {}) => {
  const started = await startPlan({ accounts: [], callbackArrives: false, ...options });
  await untilFrame(started.app, 'mode: default');
  await submitLine(started.app, '/login chatgpt');
  await choose(started.app, 'Continue with ChatGPT');
  await untilFrame(started.app, PASTE_LABEL);
  return started;
};

const paste = async (app: Instance, text: string): Promise<void> => {
  app.stdin.write(text);
  await quiet();
  app.stdin.write(KEYS.enter);
};

const expectStillWaiting = async (app: Instance, backend: FakePlanBackend): Promise<void> => {
  await quiet();
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
    await paste(app, `https://localhost:1/x?code=c&state=st-1&pad=${'a'.repeat(PASTED_CALLBACK_CAP_BYTES)}`);
    await untilFrame(app, TOO_LONG);
    await expectStillWaiting(app, backend);
    app.unmount();
  });

  it('refuses text that is not a URL with a state and a code or error, without sending anything or ending the wait', async () => {
    const { app, backend } = await waitingScreen();
    await paste(app, 'not a url');
    await untilFrame(app, NOT_REDIRECT);
    await expectStillWaiting(app, backend);
    app.unmount();
  });

  it('compares the state before anything is sent, keeps waiting, and completes with the next valid paste sent whole, whatever its host, port and path', async () => {
    const { app, backend } = await waitingScreen();
    await paste(app, 'https://localhost:1/x?code=c&state=st-other');
    await untilFrame(app, OTHER_SIGN_IN);
    await expectStillWaiting(app, backend);

    const valid = 'https://localhost:1/anything?code=pasted-code&state=st-1';
    await paste(app, valid);
    await eventually(() => routesOf(backend).includes('sign-in/complete'), 'the sign-in completion');
    await quiet();
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
    await quiet();
    app.stdin.write(KEYS.enter);
    await expectStillWaiting(app, backend);
    const frame = app.lastFrame() ?? '';
    for (const sentence of [TOO_LONG, NOT_REDIRECT, OTHER_SIGN_IN]) expect(frame).not.toContain(sentence);
    app.unmount();
  });

  it('clears the input when a value is refused', async () => {
    const { app } = await waitingScreen();
    await paste(app, 'refused-value');
    const frame = await untilFrame(app, NOT_REDIRECT);
    expect(frame).not.toContain('refused-value');
    app.unmount();
  });

  it('refuses a paste of 8193 bytes as too long and a paste of 8192 bytes as not a redirect URL', async () => {
    const { app, backend } = await waitingScreen();
    await paste(app, 'a'.repeat(PASTED_CALLBACK_CAP_BYTES + 1));
    await untilFrame(app, TOO_LONG);
    await expectStillWaiting(app, backend);
    await paste(app, 'a'.repeat(PASTED_CALLBACK_CAP_BYTES));
    await untilFrame(app, NOT_REDIRECT);
    await expectStillWaiting(app, backend);
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
    await quiet();
    expect(bodiesOf(backend, 'sign-in/cancel')).toEqual([{ attemptId: 'attempt-1' }]);
    expect(routesOf(backend)).not.toContain('sign-in/complete');
    app.unmount();
  });

  it('after a valid paste shows Finishing the sign-in… and sends no cancel on esc', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, backend } = await waitingScreen({ completeHeld: held });
    await paste(app, 'https://localhost:1/anything?code=pasted-code&state=st-1');
    const frame = await untilFrame(app, 'Finishing the sign-in…');
    expect(frame).toContain('please wait');
    expect(frame).not.toContain(PASTE_LABEL);
    app.stdin.write(KEYS.escape);
    await quiet();
    app.stdin.write(KEYS.ctrlC);
    await quiet();
    expect(routesOf(backend)).not.toContain('sign-in/cancel');
    release();
    await eventually(() => routesOf(backend).includes('sign-in/complete'), 'the sign-in completion');
    await quiet();
    expect(routesOf(backend)).not.toContain('sign-in/cancel');
    app.unmount();
  });

  it('ctrl+y asks the terminal to copy the sign-in URL through copyToClipboard and says so', async () => {
    const { app, backend } = await waitingScreen();
    app.stdin.write(CTRL_Y);
    await untilFrame(app, 'Asked the terminal to copy the sign-in URL.');
    expect(backend.clipboard).toEqual([new URL(AUTHORIZATION_URL).href]);
    app.unmount();
  });
});

