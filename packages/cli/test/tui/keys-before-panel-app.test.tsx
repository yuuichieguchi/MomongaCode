import { describe, expect, it } from 'vitest';
import { KEPT_DRAFT_LABEL } from '../../src/tui/screen/input-box.tsx';
import { pollUntil } from '@momonga/testkit';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import { throughTheLayer } from './screen-fakes.ts';
import type { FakeBackend } from '../fake-backend.ts';
import type { FakePlanBackend } from '../fake-plan-gateway.tsx';
import { PLAN_TEST_TIMEOUT_MS, eventually, startPlan, untilRow } from '../fake-plan-gateway.tsx';
import { FRAME_BOUND_MS, KEYS, untilFrame } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { frame, runStarted, start, startStillStarting } from '../tui-harness.tsx';
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
  const started = await start({}, { now: clock.now, timers: clock.timers });
  await untilFrame(started.app, 'mode: manual');
  await runStarted(started.backend, started.app, 'write a file');
  clock.advance(KEY_SETTLE_MS);
  return { ...started, clock };
};

const withheldFrames = (app: Instance) => {
  const original = app.stdout.write;
  const pass = original as unknown as (frame: string, written?: () => void) => void;
  const held: [string, (() => void) | undefined][] = [];
  app.stdout.write = ((frame: string, written?: () => void): void => {
    held.push([frame, written]);
  }) as typeof app.stdout.write;
  return {
    held: (): readonly string[] => held.map(([frame]) => frame),
    release: (): void => {
      app.stdout.write = original;
      for (const [frame, written] of held.splice(0)) pass(frame, written);
    },
  };
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
      await untilFrame(app, PANEL);
      clock.advance(KEY_SETTLE_MS * 10);
      await renderedAfter(app, backend);
      expect(approvals(backend)).toEqual([]);
      expect(app.lastFrame()).toContain(PANEL);
      if (draft !== '') expect(app.lastFrame()).toContain(`${KEPT_DRAFT_LABEL}${draft}`);
      if (draft === '') {
        expect(app.lastFrame()).not.toContain(KEPT_DRAFT_LABEL);
        app.stdin.write('2');
        await backend.called('approve:ap1:o3');
        return app.unmount();
      }
      await withdrawn(app, backend, draft);
      app.unmount();
    });
  }

  it('a key pressed 0 ms after its first frame answers it', async () => {
    const { app, backend } = await working();
    ask(backend);
    await untilFrame(app, PANEL);
    app.stdin.write('1');
    await backend.called('approve:ap1:o1');
    expect(approvals(backend)).toEqual(['approve:ap1:o1']);
    app.unmount();
  });

  it('enter pressed before it is drawn does not answer it; a key after it is drawn does', async () => {
    const { app, backend } = await working();
    const frames = withheldFrames(app);
    ask(backend);
    await pollUntil(async () => frames.held().some((held) => held.includes(PANEL)), { description: 'the approval rendered but not yet drawn', boundMs: FRAME_BOUND_MS });
    expect(app.lastFrame()).not.toContain(PANEL);
    app.stdin.write(KEYS.enter);
    frames.release();
    await untilFrame(app, PANEL);
    await renderedAfter(app, backend);
    expect(approvals(backend)).toEqual([]);
    app.stdin.write('2');
    await backend.called('approve:ap1:o3');
    expect(approvals(backend)).toEqual(['approve:ap1:o3']);
    app.unmount();
  });

  it('esc pressed while a run works, with the approval request arriving before the esc is handled, stops the run and does not answer the approval', async () => {
    const { app, backend, clock, terminal } = await working();
    const bytes = throughTheLayer(terminal, clock.timers);
    bytes(KEYS.escape);
    ask(backend);
    await untilFrame(app, PANEL);
    expect(approvals(backend)).toEqual([]);
    clock.advance(KEY_SETTLE_MS);
    await backend.called('cancel:run-1');
    await renderedAfter(app, backend);
    expect(approvals(backend)).toEqual([]);
    expect(backend.calls.filter((call) => call.startsWith('cancel:'))).toEqual(['cancel:run-1']);
    expect(app.lastFrame()).not.toContain('Press ctrl+c again to exit');
    app.unmount();
  });

  it('esc pressed while a run works, with an elicitation arriving before the esc is handled, stops the run', async () => {
    const { app, backend, clock, terminal } = await working();
    const bytes = throughTheLayer(terminal, clock.timers);
    bytes(KEYS.escape);
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'mcp__calc__ask', kind: 'other', title: 'mcp__calc__ask {}', rawInput: {} }));
    backend.emit(
      frame({
        type: 'tool.elicitation.requested',
        inputId: 'in1',
        callId: 'c1',
        server: 'calc',
        requests: [{ key: 'profile', mode: 'form', message: 'Tell me about you', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Your name' } }, required: ['name'] } }],
      }),
    );
    await untilFrame(app, 'MCP server calc asks for input');
    clock.advance(KEY_SETTLE_MS);
    await backend.called('cancel:run-1');
    expect(backend.calls.filter((call) => call.startsWith('cancel:'))).toEqual(['cancel:run-1']);
    expect(app.lastFrame()).not.toContain('Press ctrl+c again to exit');
    app.unmount();
  });
});

describe('text typed at an approval that is on the screen is kept for the input, and enter after it is drawn answers it', () => {
  it('the case seen: the panel drawn over an empty draft, then /exit and enter: the enter answers with the highlighted row and /exit stays in the draft', async () => {
    const { app, backend, clock } = await working();
    ask(backend);
    await untilFrame(app, PANEL);
    clock.advance(KEY_SETTLE_MS);
    await untilFrame(app, '1-9 or enter to choose');
    for (const key of ['/', 'e', 'x', 'i', 't']) {
      app.stdin.write(key);
      clock.advance(KEY_SETTLE_MS * 2);
    }
    const shown = await untilFrame(app, (frame) => frame.includes(`${KEPT_DRAFT_LABEL}/exit`));
    expect(shown).toContain(PANEL);
    expect(approvals(backend)).toEqual([]);
    app.stdin.write(KEYS.enter);
    await backend.called('approve:ap1:o1');
    expect(approvals(backend)).toEqual(['approve:ap1:o1']);
    backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilFrame(app, (now) => !now.includes(PANEL) && now.includes('> /exit'));
    app.unmount();
  });
});

describe('the folder trust prompt', () => {
  it('an enter queued before it is drawn does nothing; a key after it is drawn answers it', async () => {
    const clock = manualClock();
    const { app, backend } = await startStillStarting({ trust: { path: '/work/project', decision: null } }, { now: clock.now, timers: clock.timers });
    app.stdin.write(KEYS.enter);
    await untilFrame(app, TRUST_TITLE);
    expect(backend.calls.filter((call) => call.startsWith('trust:'))).toEqual([]);
    app.stdin.write('2');
    app.stdin.write(KEYS.enter);
    await backend.called('trust:untrusted');
    expect(backend.calls.filter((call) => call.startsWith('trust:'))).toEqual(['trust:untrusted']);
    app.unmount();
  });

  it('text typed at it is kept for the input, and enter after it is drawn trusts the folder with the highlighted row', async () => {
    const clock = manualClock();
    const { app, backend } = await start({ trust: { path: '/work/project', decision: null } }, { now: clock.now, timers: clock.timers });
    await untilFrame(app, TRUST_TITLE);
    clock.advance(KEY_SETTLE_MS);
    await untilFrame(app, 'enter to choose');
    app.stdin.write('/exit');
    clock.advance(KEY_SETTLE_MS * 2);
    app.stdin.write(KEYS.enter);
    await backend.called('trust:trusted');
    expect(backend.calls.filter((call) => call.startsWith('trust:'))).toEqual(['trust:trusted']);
    await untilFrame(app, '> /exit');
    app.unmount();
  });
});

const signInSteps = (backend: FakePlanBackend): string[] => backend.planCalls.map((call) => call.route).filter((route) => route.startsWith('sign-in'));

describe('a list that opens while keys are on their way', () => {
  it(
    'an enter queued before the welcome list is drawn starts no sign-in and opens no browser',
    async () => {
      const { app, backend } = await startPlan({ models: [], accounts: [], callbackArrives: false });
      app.stdin.write(KEYS.enter);
      app.stdin.write(KEYS.enter);
      await untilRow(app, 'Continue with ChatGPT', 'esc: go back');
      await untilFrame(app, 'Connect a model to start');
      expect(signInSteps(backend)).toEqual([]);
      expect(backend.openedUrls).toEqual([]);
      app.unmount();
    },
    PLAN_TEST_TIMEOUT_MS,
  );

  it(
    'an enter pressed once the welcome list is drawn starts its sign-in at once',
    async () => {
      const { app, backend } = await startPlan({ models: [], accounts: [], callbackArrives: false });
      await untilRow(app, 'Continue with ChatGPT', 'esc: go back');
      app.stdin.write(KEYS.enter);
      await eventually(() => signInSteps(backend).includes('sign-in/begin'), 'the sign-in begun');
      expect(signInSteps(backend).filter((route) => route === 'sign-in/begin')).toHaveLength(1);
      app.unmount();
    },
    PLAN_TEST_TIMEOUT_MS,
  );

  it(
    'a doubled enter on the welcome list starts one sign-in and opens the browser once, with no second list',
    async () => {
      const { app, backend } = await startPlan({ models: [], accounts: [], callbackArrives: false });
      await untilRow(app, 'Continue with ChatGPT', 'esc: go back');
      app.stdin.write(KEYS.enter);
      app.stdin.write(KEYS.enter);
      await untilFrame(app, 'On a remote machine? Paste the redirect URL here');
      await eventually(() => backend.openedUrls.length === 1, 'the browser');
      app.stdin.write(KEYS.enter);
      await untilFrame(app, 'On a remote machine? Paste the redirect URL here');
      expect(signInSteps(backend).filter((route) => route === 'sign-in/begin')).toHaveLength(1);
      expect(backend.openedUrls).toHaveLength(1);
      app.unmount();
    },
    PLAN_TEST_TIMEOUT_MS,
  );

  it(
    'text typed at the welcome list stays out of it; enter then chooses its sign-in row',
    async () => {
      const { app, backend } = await startPlan({ models: [], accounts: [] });
      await untilRow(app, 'Continue with ChatGPT', 'esc: go back');
      app.stdin.write('x');
      expect(signInSteps(backend)).toEqual([]);
      app.stdin.write(KEYS.enter);
      await eventually(() => backend.openedUrls.length === 1, 'the browser');
      app.unmount();
    },
    PLAN_TEST_TIMEOUT_MS,
  );
});
