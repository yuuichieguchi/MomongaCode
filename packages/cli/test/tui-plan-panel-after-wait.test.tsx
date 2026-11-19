import { describe, expect, it, vi } from 'vitest';
import { KEYS, untilFrame } from './ink-helpers.ts';
import { account, AUTHORIZATION_URL, eventually, IDENTITY_UNCONFIRMED, PLAN_TEST_TIMEOUT_MS, startPlan, untilRow } from './fake-plan-gateway.tsx';
import type { FakePlanBackend, FakePlanOptions } from './fake-plan-gateway.tsx';
import { manualClock } from './tui/screen-clock.ts';
import { UNDER_HANDS_PAUSE_LINE } from '../src/tui/screen/prompt-settle.ts';
import { KEY_RELEASED } from '../src/tui/terminal/events.ts';
import { KEY_SETTLE_MS } from '../src/tui/terminal/constants.ts';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const PLAN_PANEL = "You're using your ChatGPT plan";
const MODEL_LIST = 'Choose a model of chatgpt';
const SUBSCRIPTION = 'OpenAI (ChatGPT subscription)';
const QUESTION = 'Save this account under the label chatgpt?';
const UNDER_HANDS = 'This appeared while you were typing';
const QUIET = KEY_SETTLE_MS * 4;
const BROWSER_TIME = KEY_SETTLE_MS * 400;

const flat = (shown: string): string => shown.replace(/\s+/g, ' ');

const FIRST_SIGN_IN: FakePlanOptions = {
  accounts: [],
  complete: IDENTITY_UNCONFIRMED,
  confirmed: { outcome: 'signed_in', account: account({ pinnedBy: [] }), firstSignIn: true },
  catalogs: { chatgpt: { readAt: '2026-11-10T00:00:00.000Z', models: [{ slug: 'gpt-5.1', displayName: 'GPT-5.1', usable: true, contextWindow: 272000, maxOutputTokens: 128000 }] } },
};


const waitingForBrowser = async () => {
  const browser = Promise.withResolvers<void>();
  const clock = manualClock(1_000_000);
  const started = await startPlan({ ...FIRST_SIGN_IN, completeHeld: browser.promise }, {}, {}, { now: clock.now, timers: clock.timers, keySettleMs: KEY_SETTLE_MS });
  const { app, backend } = started;
  await untilFrame(app, 'mode: manual');
  app.stdin.write('/login');
  await untilFrame(app, '/login');
  clock.advance(QUIET);
  app.stdin.write(KEYS.enter);
  await untilRow(app, SUBSCRIPTION);
  clock.advance(QUIET);
  app.stdin.write(KEYS.enter);
  await eventually(() => backend.planCalls.some((call) => call.route === 'sign-in/complete'), 'the wait for the browser');
  return { ...started, clock, browserDone: browser.resolve };
};

const afterBrowser = async (started: Awaited<ReturnType<typeof waitingForBrowser>>): Promise<string> => {
  started.clock.advance(BROWSER_TIME);
  started.browserDone();
  return untilRow(started.app, 'Save this account', QUESTION);
};

const enterOnSave = async ({ app, clock }: Awaited<ReturnType<typeof waitingForBrowser>>): Promise<void> => {
  clock.advance(QUIET);
  app.stdin.write(KEYS.down);
  app.stdin.write(KEYS.enter);
};

const confirmations = (backend: FakePlanBackend): number => backend.planCalls.filter((call) => call.route === 'sign-in/complete').length;

describe('a panel that follows a wait or another list of the same flow opens fresh', () => {
  it('after the browser sign-in and the identity question, Enter chooses Got it and then a model', async () => {
    const started = await waitingForBrowser();
    const { app, backend, clock, terminal } = started;
    terminal.emit({ type: 'focus', direction: 'out' });
    clock.advance(BROWSER_TIME);
    terminal.emit({ type: 'mouse', kind: 'move', button: 'none', col: 10, row: 5, shift: false, alt: false, ctrl: false });
    terminal.emit({ type: 'focus', direction: 'in' });
    terminal.emit(KEY_RELEASED);
    const question = await afterBrowser(started);
    expect(flat(question)).not.toContain(UNDER_HANDS);
    await enterOnSave(started);
    terminal.emit(KEY_RELEASED);
    const panel = await untilRow(app, 'Got it', PLAN_PANEL);
    expect(flat(panel)).not.toContain(UNDER_HANDS);
    expect(confirmations(backend)).toBe(2);
    clock.advance(QUIET);
    app.stdin.write(KEYS.enter);
    terminal.emit(KEY_RELEASED);
    const models = await untilRow(app, 'gpt-5.1', MODEL_LIST);
    expect(flat(models)).not.toContain(UNDER_HANDS);
    clock.advance(QUIET);
    app.stdin.write(KEYS.enter);
    await eventually(() => backend.planCalls.some((call) => call.route === 'accounts/chatgpt/targets'), 'the model chosen with Enter');
    app.unmount();
  });

  it('Esc on the waiting screen returns to the list fresh', async () => {
    const clock = manualClock(1_000_000);
    const { app } = await startPlan({ ...FIRST_SIGN_IN, callbackArrives: false }, {}, {}, { now: clock.now, timers: clock.timers, keySettleMs: KEY_SETTLE_MS });
    await untilFrame(app, 'mode: manual');
    app.stdin.write('/login');
    await untilFrame(app, '/login');
    clock.advance(QUIET);
    app.stdin.write(KEYS.enter);
    await untilRow(app, SUBSCRIPTION);
    clock.advance(QUIET);
    app.stdin.write(KEYS.enter);
    await untilFrame(app, AUTHORIZATION_URL);
    clock.advance(BROWSER_TIME);
    app.stdin.write(KEYS.escape);
    const list = await untilFrame(app, (shown) => shown.includes(SUBSCRIPTION) && !shown.includes(AUTHORIZATION_URL));
    expect(flat(list)).not.toContain(UNDER_HANDS_PAUSE_LINE);
    app.unmount();
  });

  it('a key really typed as the question opens still puts it under the hands', async () => {
    const started = await waitingForBrowser();
    started.clock.advance(BROWSER_TIME);
    started.app.stdin.write('x');
    started.browserDone();
    const question = await untilRow(started.app, 'Save this account', QUESTION);
    expect(flat(question)).toContain(UNDER_HANDS);
    started.app.unmount();
  });

  it('a doubled Enter on the question confirms once and does not choose Got it', async () => {
    const started = await waitingForBrowser();
    const { app, backend, clock } = started;
    await afterBrowser(started);
    await enterOnSave(started);
    app.stdin.write(KEYS.enter);
    const panel = await untilRow(app, 'Got it', PLAN_PANEL);
    expect(flat(panel)).toContain(UNDER_HANDS);
    clock.advance(QUIET);
    app.stdin.write(KEYS.enter);
    await untilFrame(app, PLAN_PANEL);
    expect(confirmations(backend)).toBe(2);
    expect(app.lastFrame()).toContain(PLAN_PANEL);
    app.unmount();
  });
});
