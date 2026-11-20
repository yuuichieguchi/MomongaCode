import { describe, expect, it, vi } from 'vitest';
import { exitHint } from '../../src/tui/app.tsx';
import { NOT_NOW_LABEL, invitationLine } from '../../src/tui/screen/menu.tsx';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { KEYS, untilFrame, untilOutput } from '../ink-helpers.ts';
import { CHATGPT, PLAN_TEST_TIMEOUT_MS, account, choose, eventually, startPlan, untilPromptDrawn, untilTypedAfter, submitLine, untilRow } from '../fake-plan-gateway.tsx';
import type { FakePlanBackend } from '../fake-plan-gateway.tsx';
import { runView } from '../fake-backend.ts';
import { runStarted } from '../tui-harness.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const LINE = invitationLine({ profile: CHATGPT }, DEFAULT_KEY_TABLE);

const PAGE_UP = '\u001b[5~';
const PAGE_DOWN = '\u001b[6~';

const START_SCREEN_KEYS: readonly (readonly [string, string])[] = [
  ...[...'123456789jkyY'].map((key) => [key, key] as const),
  ['space', ' '],
  ['enter', KEYS.enter],
  ['tab', KEYS.tab],
  ['shift+tab', KEYS.shiftTab],
  ['up', KEYS.up],
  ['down', KEYS.down],
  ['left', KEYS.left],
  ['right', KEYS.right],
  ['home', KEYS.home],
  ['end', KEYS.end],
  ['pageup', PAGE_UP],
  ['pagedown', PAGE_DOWN],
  ['backspace', KEYS.backspace],
  ['ctrl+j', KEYS.ctrlJ],
  ['ctrl+o', KEYS.ctrlO],
  ['ctrl+y', KEYS.ctrlY],
  ['1 then enter', `1${KEYS.enter}`],
  ['2 then enter', `2${KEYS.enter}`],
  ['a paste', `${KEYS.pasteStart}1\r${KEYS.pasteEnd}`],
];

const signInSteps = (backend: FakePlanBackend): string[] => backend.planCalls.map((call) => call.route).filter((route) => route.startsWith('sign-in'));

const invited = async () => {
  const started = await startPlan({ accounts: [] });
  await untilFrame(started.app, LINE);
  return started;
};

describe('the invitation is one line that takes no key', () => {
  it('names /login and shows no row to choose', async () => {
    const { app } = await invited();
    expect(LINE).toContain('/login');
    expect(app.lastFrame()).not.toContain('1. Continue with ChatGPT');
    expect(app.lastFrame()).not.toContain(NOT_NOW_LABEL);
    app.unmount();
  });

  it.each(START_SCREEN_KEYS)('%s typed at the start screen never reaches the program that opens a URL and starts no sign-in', async (_name, key) => {
    const { app, backend } = await invited();
    app.stdin.write(key);
    app.stdin.write(KEYS.enter);
    await untilTypedAfter(app);
    expect(backend.openedUrls).toEqual([]);
    expect(backend.listenerPaths).toEqual([]);
    expect(signInSteps(backend)).toEqual([]);
    expect(backend.dismissals).toEqual([]);
    app.unmount();
  });

  it('a letter, a digit and enter go to the input, and enter sends them as the message', async () => {
    const { app, backend } = await invited();
    app.stdin.write('j');
    app.stdin.write('1');
    await untilFrame(app, '> j1');
    app.stdin.write(KEYS.enter);
    await eventually(() => backend.started.length === 1, 'the run');
    expect(backend.started.map((run) => run.text)).toEqual(['j1']);
    expect(backend.openedUrls).toEqual([]);
    expect(signInSteps(backend)).toEqual([]);
    app.unmount();
  });

  it('ctrl+c follows the idle rule: the first press arms the exit and the line stays', async () => {
    const { app, outcomes } = await invited();
    app.stdin.write(KEYS.ctrlC);
    const shown = await untilFrame(app, exitHint('ctrl+c'));
    expect(shown).toContain(LINE);
    expect(outcomes).toEqual([]);
    app.stdin.write(KEYS.ctrlC);
    await eventually(() => outcomes.length === 1, 'the exit');
    app.unmount();
  });

  it('esc hides it for this session and stores nothing', async () => {
    const { app, backend } = await invited();
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => !shown.includes(LINE));
    await untilPromptDrawn(app);
    await untilTypedAfter(app);
    expect(backend.dismissals).toEqual([]);
    app.unmount();
  });

  it('Not now in /login stores the answer and hides the line', async () => {
    const { app, backend } = await invited();
    await submitLine(app, '/login');
    await choose(app, NOT_NOW_LABEL);
    await eventually(() => backend.dismissals.length > 0, 'the stored answer');
    expect(backend.dismissals).toEqual(['invite:chatgpt']);
    await untilFrame(app, (shown) => !shown.includes(NOT_NOW_LABEL));
    await untilPromptDrawn(app);
    expect(await untilTypedAfter(app)).not.toContain(LINE);
    app.unmount();
  });

  it('/login has no Not now row once the answer is stored', async () => {
    const { app, backend } = await startPlan({ accounts: [], dismissed: { 'invite:chatgpt': '2026-11-01T00:00:00.000Z' } });
    await backend.called('openSession');
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login');
    const shown = await untilRow(app, 'Add an API key');
    expect(shown).not.toContain(NOT_NOW_LABEL);
    expect(app.frames.join('\n')).not.toContain(LINE);
    app.unmount();
  });
});

describe('the loading overlay has a key that leaves it and is closed by the flow that opened it', () => {
  const READING = 'reading…';

  it('esc closes it, and the list the read would have opened is never shown', async () => {
    const { app, backend } = await startPlan({ accounts: [], dismissed: { 'invite:chatgpt': 'x' } });
    await backend.called('openSession');
    await untilFrame(app, 'mode: manual');
    const answer = Promise.withResolvers<Awaited<ReturnType<typeof backend.plan.accounts>>>();
    const read = backend.plan.accounts;
    backend.plan.accounts = () => answer.promise;
    await submitLine(app, '/login');
    await untilFrame(app, READING);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => !shown.includes(READING));
    answer.resolve(await read());
    app.stdin.write('typed');
    expect(await untilFrame(app, '> typed')).not.toContain('Connect a model');
    app.unmount();
  });

  it('ctrl+c closes it too', async () => {
    const { app, backend } = await startPlan({ accounts: [], dismissed: { 'invite:chatgpt': 'x' } });
    await backend.called('openSession');
    await untilFrame(app, 'mode: manual');
    backend.plan.accounts = () => new Promise(() => undefined);
    await submitLine(app, '/login');
    await untilFrame(app, READING);
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, (shown) => !shown.includes(READING));
    app.unmount();
  });

  it.each(['/login', '/logout', '/model'])('is closed when the read of %s fails, and the failure is shown', async (command) => {
    const { app, backend } = await startPlan({ accounts: [], dismissed: { 'invite:chatgpt': 'x' } });
    await backend.called('openSession');
    await untilFrame(app, 'mode: manual');
    backend.plan.accounts = () => Promise.reject(new Error('the gateway did not answer'));
    await submitLine(app, command);
    await untilOutput(app, 'the gateway did not answer');
    await untilFrame(app, (shown) => !shown.includes(READING));
    app.stdin.write('typed');
    await untilFrame(app, '> typed');
    app.unmount();
  });
});

describe('a key typed between two lists of one flow never acts on the list that opens', () => {
  it('drops the key while the flow works: none acts on the next list and no typed text reaches the input', async () => {
    const { app, backend } = await startPlan({ accounts: [], dismissed: { 'invite:chatgpt': 'x' } });
    await backend.called('openSession');
    await untilFrame(app, 'mode: manual');
    const held = Promise.withResolvers<void>();
    const asked = Promise.withResolvers<void>();
    backend.sandbox = async () => {
      asked.resolve();
      await held.promise;
      return 'none';
    };
    await submitLine(app, '/login');
    await choose(app, 'ChatGPT');
    await asked.promise;
    app.stdin.write(KEYS.down);
    app.stdin.write('x');
    held.resolve();
    await untilFrame(app, (shown) => shown.includes('The sandbox is off') && shown.includes('esc: Cancel'));
    expect(app.lastFrame()).toContain('› 2. Cancel');
    expect(app.lastFrame()).not.toContain('> x');
    app.stdin.write(KEYS.escape);
    const closed = await untilFrame(app, (shown) => !shown.includes('The sandbox is off') && shown.split('\n').some((row) => row.includes('›') && row.includes('ChatGPT')));
    expect(closed).not.toContain('> x');
    expect(signInSteps(backend)).toEqual([]);
    app.unmount();
  });

  it('puts the keys typed while the last step of the flow is saved in the input at once, once, and replays nothing when it ends', async () => {
    const { app, backend } = await startPlan({ accounts: [account()], dismissed: { 'invite:chatgpt': 'x' } });
    await backend.called('openSession');
    await untilFrame(app, 'mode: manual');
    const held = Promise.withResolvers<void>();
    const signOut = backend.plan.signOut;
    backend.plan.signOut = async (request) => {
      await held.promise;
      return signOut(request);
    };
    await submitLine(app, '/logout');
    await untilRow(app, 'chatgpt');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'again to sign out');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, (shown) => !shown.includes('again to sign out'));
    app.stdin.write('a');
    app.stdin.write('b');
    const typed = await untilFrame(app, (shown) => shown.includes('> ab') || shown.includes('> a'));
    expect(typed).toContain('> ab');
    held.resolve();
    const ended = await untilFrame(app, 'Signed out chatgpt');
    expect(ended).toContain('> ab');
    expect(ended).not.toContain('> abab');
    app.unmount();
  });
});

describe('a browser starts only from enter or a click on the row that says so', () => {
  it('digits typed at the welcome screen move the highlight and start no sign-in; enter on the sign-in row does', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [] });
    await untilRow(app, 'Continue with ChatGPT');
    for (const key of ['1', '1', '1']) app.stdin.write(key);
    app.stdin.write(KEYS.down);
    await untilFrame(app, '› 2.');
    expect(signInSteps(backend)).toEqual([]);
    expect(backend.openedUrls).toEqual([]);
    app.stdin.write(KEYS.up);
    await untilFrame(app, '› 1. Continue with ChatGPT');
    app.stdin.write(KEYS.enter);
    await eventually(() => backend.openedUrls.length === 1, 'the browser');
    app.unmount();
  });

  it('the digit of the Manage usage row opens no URL, and enter opens it', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ paused: {} })] });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.finish(runView({ status: 'STOPPED', stopReason: 'usage_limit' as never, error: { code: 'plan_usage_limit', message: 'Manage usage', plan: { profile: 'chatgpt', account: 'chatgpt' } } as never }));
    await untilRow(app, 'Manage usage');
    app.stdin.write('1');
    app.stdin.write(KEYS.enter);
    await eventually(() => backend.openedUrls.length === 1, 'the usage page');
    await untilTypedAfter(app);
    expect(backend.openedUrls).toHaveLength(1);
    app.unmount();
  });
});
