import { describe, expect, it } from 'vitest';
import { UNDER_HANDS_LINE, UNDER_HANDS_PAUSE_LINE } from '../../src/tui/screen/prompt-settle.ts';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import type { FakeBackend } from '../fake-backend.ts';
import type { FakePlanBackend } from '../fake-plan-gateway.tsx';
import { PLAN_TEST_TIMEOUT_MS, eventually, startPlan, untilRow } from '../fake-plan-gateway.tsx';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { frame, runStarted, start } from '../tui-harness.tsx';
import { manualClock } from './screen-clock.ts';

const ALLOW = { optionId: 'o1', name: 'Allow once', kind: 'allow_once' };
const REJECT = { optionId: 'o3', name: 'Reject once', kind: 'reject_once' };
const PANEL = 'Permission requested: Write out.txt';
const TRUST_TITLE = 'Do you trust the files in /work/project?';

const ask = (backend: FakeBackend): void => {
  backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'edit', title: 'Write out.txt', rawInput: { file_path: 'out.txt', content: 'x' } }));
  backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'edits require approval', options: [ALLOW, REJECT], shown: { title: 'approval', input: {} } }));
};

const approvals = (backend: FakeBackend): string[] => backend.calls.filter((call) => call.startsWith('approve:'));

let renders = 0;

const renderedAfter = (app: Instance, backend: FakeBackend): Promise<string> => {
  renders += 1;
  backend.emit(frame({ type: 'usage.updated', inputTokens: renders, outputTokens: 0, totalTokens: renders }));
  return untilFrame(app, `tokens: ${renders}`);
};

const working = async () => {
  const clock = manualClock();
  const started = await start({}, { now: clock.now, timers: clock.timers, keySettleMs: KEY_SETTLE_MS });
  await untilFrame(started.app, 'mode: manual');
  await runStarted(started.backend, started.app, 'write a file');
  clock.advance(KEY_SETTLE_MS);
  return { ...started, clock };
};

const withdrawn = async (app: Instance, backend: FakeBackend, draft: string): Promise<void> => {
  backend.emit(frame({ type: 'tool.permission.cancelled', approvalId: 'ap1', reason: 'withdrawn' }));
  await untilFrame(app, (shown) => !shown.includes(PANEL) && shown.includes(`> ${draft}`));
};

describe('keys that arrive before an approval is on the screen never answer it', () => {
  for (const [name, keys, draft] of [
    ['/exit and enter', `/exit${KEYS.enter}`, '/exit'],
    ['a digit', '1', '1'],
    ['enter alone', KEYS.enter, ''],
  ] as const) {
    it(`${name} in the same input as the request: nothing is approved, the panel stays open, and the typed text stays in the draft`, async () => {
      const { app, backend, clock } = await working();
      ask(backend);
      expect(app.lastFrame()).not.toContain(PANEL);
      app.stdin.write(keys);
      const opened = await untilFrame(app, PANEL);
      expect(opened).toContain(UNDER_HANDS_LINE);
      clock.advance(KEY_SETTLE_MS * 10);
      await renderedAfter(app, backend);
      expect(approvals(backend)).toEqual([]);
      expect(app.lastFrame()).toContain(PANEL);
      if (draft === '') {
        app.stdin.write('2');
        await backend.called('approve:ap1:o3');
        return app.unmount();
      }
      await withdrawn(app, backend, draft);
      app.unmount();
    });
  }

  it('a key pressed after its first frame and the settle answers it', async () => {
    const { app, backend, clock } = await working();
    ask(backend);
    app.stdin.write('1');
    await untilFrame(app, PANEL);
    clock.advance(KEY_SETTLE_MS);
    await renderedAfter(app, backend);
    expect(approvals(backend)).toEqual([]);
    app.stdin.write('1');
    await backend.called('approve:ap1:o1');
    app.unmount();
  });
});

describe('text typed at an approval that is on the screen is kept for the input and never lets enter answer', () => {
  it('the case seen: the panel settled over an empty draft, then /exit and enter', async () => {
    const { app, backend, clock } = await working();
    ask(backend);
    await untilFrame(app, PANEL);
    clock.advance(KEY_SETTLE_MS);
    await untilFrame(app, '1-9 or enter to choose');
    for (const key of ['/', 'e', 'x', 'i', 't']) {
      app.stdin.write(key);
      clock.advance(KEY_SETTLE_MS * 2);
    }
    app.stdin.write(KEYS.enter);
    clock.advance(KEY_SETTLE_MS * 2);
    app.stdin.write(KEYS.enter);
    const shown = await untilFrame(app, UNDER_HANDS_LINE);
    expect(shown).toContain(PANEL);
    await renderedAfter(app, backend);
    expect(approvals(backend)).toEqual([]);
    await withdrawn(app, backend, '/exit');
    app.unmount();
  });
});

describe('the folder trust prompt', () => {
  it('text typed at it is kept for the input and enter does not trust the folder', async () => {
    const clock = manualClock();
    const { app, backend } = await start({ trust: { path: '/work/project', decision: null } }, { now: clock.now, timers: clock.timers, keySettleMs: KEY_SETTLE_MS });
    await untilFrame(app, TRUST_TITLE);
    clock.advance(KEY_SETTLE_MS);
    await untilFrame(app, 'enter to choose');
    app.stdin.write('/exit');
    clock.advance(KEY_SETTLE_MS * 2);
    app.stdin.write(KEYS.enter);
    await untilFrame(app, UNDER_HANDS_LINE);
    clock.advance(KEY_SETTLE_MS * 2);
    app.stdin.write(KEYS.enter);
    clock.advance(KEY_SETTLE_MS * 2);
    expect(backend.calls.filter((call) => call.startsWith('trust:'))).toEqual([]);
    app.stdin.write('2');
    await backend.called('trust:untrusted');
    await untilFrame(app, '> /exit');
    app.unmount();
  });
});

const signInSteps = (backend: FakePlanBackend): string[] => backend.planCalls.map((call) => call.route).filter((route) => route.startsWith('sign-in'));

describe('a list that opens while keys are on their way', () => {
  it(
    'a doubled enter on the welcome list does not start the sign-in of the list that opens after it; a later enter does',
    async () => {
      const { app, backend } = await startPlan({ models: [], accounts: [] });
      await untilRow(app, 'Continue with ChatGPT', 'esc: go back');
      app.stdin.write(KEYS.enter);
      app.stdin.write(KEYS.enter);
      await untilFrame(app, (shown) => !shown.includes('Connect a model to start') && shown.includes('1. Continue with ChatGPT'));
      await untilFrame(app, 'enter to choose');
      expect(signInSteps(backend)).toEqual([]);
      expect(backend.openedUrls).toEqual([]);
      app.stdin.write(KEYS.enter);
      await eventually(() => backend.openedUrls.length === 1, 'the browser');
      app.unmount();
    },
    PLAN_TEST_TIMEOUT_MS,
  );

  it(
    'text typed at the welcome list keeps it open under the hands; enter after a pause still chooses its sign-in row',
    async () => {
      const { app, backend } = await startPlan({ models: [], accounts: [] });
      await untilRow(app, 'Continue with ChatGPT', 'esc: go back');
      app.stdin.write('x');
      await untilFrame(app, UNDER_HANDS_PAUSE_LINE);
      expect(signInSteps(backend)).toEqual([]);
      app.stdin.write(KEYS.enter);
      await untilFrame(app, (shown) => !shown.includes('Connect a model to start') && shown.includes('1. Continue with ChatGPT') && shown.includes('enter to choose'));
      app.stdin.write(KEYS.enter);
      await eventually(() => backend.openedUrls.length === 1, 'the browser');
      app.unmount();
    },
    PLAN_TEST_TIMEOUT_MS,
  );
});
