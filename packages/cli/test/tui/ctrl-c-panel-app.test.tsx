import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@momonga/protocol';
import { EXIT_ARM_MS } from '../../src/tui/app.tsx';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import type { AppProps } from '../../src/tui/app.tsx';
import { createKeyBindings } from '../../src/tui/keys/store.ts';
import type { FakeBackend } from '../fake-backend.ts';
import { runView } from '../fake-backend.ts';
import { KEYS, untilFrame, untilOutput } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { frame, runStarted, start } from '../tui-harness.tsx';
import { manualClock } from './screen-clock.ts';
import { PLAN_TEST_TIMEOUT_MS, choose, startPlan, submitLine } from '../fake-plan-gateway.tsx';

const HINT = 'Press ctrl+c again to exit';
const CTRL_T = '\u0014';
const OPTIONS = [
  { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'o3', name: 'Reject once', kind: 'reject_once' },
];
const FORM: ElicitationRequestView = { key: 'profile', mode: 'form', message: 'Tell me about you', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Your name' } }, required: ['name'] } };

const callStarted = (backend: FakeBackend): void => {
  backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'sleep 60', rawInput: { command: 'sleep 60' } }));
};

const inputAsked = async (backend: FakeBackend, app: Instance): Promise<void> => {
  backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'mcp__calc__ask', kind: 'other', title: 'mcp__calc__ask {}', rawInput: {} }));
  backend.emit(frame({ type: 'tool.elicitation.requested', inputId: 'in1', callId: 'c1', server: 'calc', requests: [FORM] }));
  await untilFrame(app, (shown) => shown.includes('MCP server calc asks for input') && shown.includes('to confirm the value'));
};

type Panel = { name: string; open: (backend: FakeBackend, app: Instance) => Promise<void> };

const panels: readonly Panel[] = [
  {
    name: 'the approval panel',
    open: async (backend, app) => {
      callStarted(backend);
      backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'asks', options: OPTIONS, shown: { title: 'approval', input: {} } }));
      await untilFrame(app, (shown) => shown.includes('Permission requested: sleep 60') && shown.includes('cancel the run'));
    },
  },
  {
    name: 'the effect-unknown panel',
    open: async (backend, app) => {
      callStarted(backend);
      backend.emit(frame({ type: 'tool.unknown.requested', approvalId: 'ap1', callIds: ['c1'], options: OPTIONS }));
      await untilFrame(app, (shown) => shown.includes('1. Allow once') && shown.includes('cancel the run'));
    },
  },
  {
    name: 'the MCP input panel at its field stage',
    open: inputAsked,
  },
  {
    name: 'the MCP input panel at its decision stage',
    open: async (backend, app) => {
      await inputAsked(backend, app);
      app.stdin.write(KEYS.escape);
      await untilFrame(app, (shown) => shown.includes('2. Decline') && shown.includes('cancel the run'));
    },
  },
];

const opened = async (panel: Panel, extra: Partial<AppProps> = {}) => {
  const started = await start({}, extra);
  await untilFrame(started.app, 'mode: manual');
  await runStarted(started.backend, started.app, 'go');
  await panel.open(started.backend, started.app);
  return started;
};

const unansweredCancel = (backend: FakeBackend): (() => void) => {
  const answer = Promise.withResolvers<void>();
  const cancel = backend.cancel;
  backend.cancel = async (runId) => {
    await cancel(runId);
    await answer.promise;
  };
  return answer.resolve;
};

const cancels = (backend: FakeBackend): number => backend.calls.filter((call) => call === 'cancel:run-1').length;

const EXITED = { reopen: 'session-1' };

describe.each(panels)('ctrl+c while $name is open', (panel) => {
  it('cancels the run, shows the exit hint, and exits at the second press within the window', async () => {
    const { app, backend, exited, outcomes } = await opened(panel);
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    await untilFrame(app, HINT);
    expect(outcomes).toEqual([]);
    backend.finish(runView({ status: 'CANCELLED' }));
    await untilFrame(app, (shown) => shown.includes('CANCELLED') && shown.includes(HINT));
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual(EXITED);
  });

  it('exits at the second press while the cancel request is still unanswered', async () => {
    const { app, backend, exited } = await opened(panel);
    const answer = unansweredCancel(backend);
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    await untilFrame(app, HINT);
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual(EXITED);
    expect(cancels(backend)).toBe(1);
    answer();
  });

  it(`does not exit at a second press after ${EXIT_ARM_MS} ms and shows the hint again`, async () => {
    const clock = manualClock();
    const { app, backend, outcomes } = await opened(panel, { now: clock.now, timers: clock.timers });
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    await untilFrame(app, HINT);
    backend.finish(runView({ status: 'CANCELLED' }));
    await untilFrame(app, (shown) => shown.includes('CANCELLED'));
    clock.advance(EXIT_ARM_MS);
    await untilFrame(app, (shown) => !shown.includes(HINT));
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, HINT);
    expect(outcomes).toEqual([]);
    app.unmount();
  });
});

describe('the panel interrupt bound to another key than the input interrupt', () => {
  const rebound = async () => {
    const content = JSON.stringify({ bindings: [{ context: 'select', bindings: { 'ctrl+t': 'select.interrupt' } }] });
    const keyBindings = createKeyBindings({
      file: '/home/u/.momonga/keybindings.json',
      shownFile: '~/.momonga/keybindings.json',
      files: { stat: async () => ({ mtimeMs: 1, size: Buffer.byteLength(content) }), read: async () => content, write: async () => undefined },
    });
    await keyBindings.load();
    const started = await opened(panels[0] as Panel, { keyBindings });
    const answer = unansweredCancel(started.backend);
    started.app.stdin.write(CTRL_T);
    await started.backend.called('cancel:run-1');
    await untilFrame(started.app, HINT);
    return { ...started, answer };
  };

  it('exits at the input interrupt pressed within the window', async () => {
    const { app, backend, exited, answer } = await rebound();
    answer();
    backend.finish(runView({ status: 'CANCELLED' }));
    await untilOutput(app, 'CANCELLED');
    await untilFrame(app, (shown) => shown.includes(HINT));
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual(EXITED);
    expect(cancels(backend)).toBe(1);
  });

  it('exits at the panel interrupt pressed again within the window while the panel is still open', async () => {
    const { app, backend, exited, answer } = await rebound();
    expect(app.lastFrame()).toContain('Permission requested: sleep 60');
    app.stdin.write(CTRL_T);
    expect(await exited).toEqual(EXITED);
    expect(cancels(backend)).toBe(1);
    answer();
  });

  it('exits at the input interrupt pressed while the panel is still open', async () => {
    const { app, backend, exited, answer } = await rebound();
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual(EXITED);
    expect(cancels(backend)).toBe(1);
    answer();
  });
});

describe('ctrl+c with the exit armed and no panel open', () => {
  it('ctrl+c on the wait after a row was chosen ends the wait and goes back to the list, as esc does, and does not exit', { timeout: PLAN_TEST_TIMEOUT_MS }, async () => {
    const { app, backend, outcomes } = await startPlan({ accounts: [], dismissed: { 'invite:chatgpt': 'x' } });
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
    const beforeCtrlC = app.frames.length;
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, (shown) => app.frames.length > beforeCtrlC && shown.split('\n').some((row) => row.includes('›') && row.includes('ChatGPT')));
    const since = app.frames.length;
    held.resolve();
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => !shown.split('\n').some((row) => row.includes('›') && row.includes('ChatGPT')));
    expect(app.frames.slice(since).filter((shown) => shown.includes('The sandbox is off'))).toEqual([]);
    expect(app.frames.filter((shown) => shown.includes(HINT))).toEqual([]);
    app.stdin.write('typed');
    await untilFrame(app, '> typed');
    expect(outcomes).toEqual([]);
    app.unmount();
  });

  it('falls through the tool view to the input and exits at the second press', async () => {
    const { app, backend, exited } = await start();
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash seq', rawInput: {} }));
    backend.emit(frame({ type: 'tool.completed', callId: 'c1', status: 'completed', output: Array.from({ length: 30 }, (_, index) => `out ${index}`).join('\n') }));
    await untilFrame(app, 'out 29');
    app.stdin.write(KEYS.ctrlO);
    await untilFrame(app, (shown) => shown.startsWith('out 0'));
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    await untilFrame(app, HINT);
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual(EXITED);
    expect(cancels(backend)).toBe(1);
  });
});

type FreshPanel = { name: string; title: string; ask: (backend: FakeBackend) => void };

const approvalAsked = (backend: FakeBackend): void => {
  callStarted(backend);
  backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'asks', options: OPTIONS, shown: { title: 'approval', input: {} } }));
};

const freshPanels: readonly FreshPanel[] = [
  { name: 'the approval panel', title: 'Permission requested: sleep 60', ask: approvalAsked },
  {
    name: 'the effect-unknown panel',
    title: '1. Allow once',
    ask: (backend) => {
      callStarted(backend);
      backend.emit(frame({ type: 'tool.unknown.requested', approvalId: 'ap1', callIds: ['c1'], options: OPTIONS }));
    },
  },
  {
    name: 'the MCP input panel',
    title: 'MCP server calc asks for input',
    ask: (backend) => {
      backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'mcp__calc__ask', kind: 'other', title: 'mcp__calc__ask {}', rawInput: {} }));
      backend.emit(frame({ type: 'tool.elicitation.requested', inputId: 'in1', callId: 'c1', server: 'calc', requests: [FORM] }));
    },
  },
];

const workingWithSettle = async () => {
  const clock = manualClock();
  const started = await start({}, { now: clock.now, timers: clock.timers });
  await untilFrame(started.app, 'mode: manual');
  await runStarted(started.backend, started.app, 'go');
  clock.advance(KEY_SETTLE_MS);
  return { ...started, clock };
};

const freshlyOpened = async (panel: FreshPanel) => {
  const started = await workingWithSettle();
  panel.ask(started.backend);
  await untilFrame(started.app, panel.title);
  return started;
};

describe.each(freshPanels)('ctrl+c pressed twice quickly while $name has only just opened', (panel) => {
  it('exits at both presses written in one read', async () => {
    const { app, backend, exited } = await freshlyOpened(panel);
    app.stdin.write(`${KEYS.ctrlC}${KEYS.ctrlC}`);
    expect(await exited).toEqual(EXITED);
    expect(cancels(backend)).toBe(1);
  });

  it('exits at a second press 100 ms after the first while the cancel is unanswered', async () => {
    const { app, backend, exited, clock } = await freshlyOpened(panel);
    const answer = unansweredCancel(backend);
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    clock.advance(100);
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual(EXITED);
    expect(cancels(backend)).toBe(1);
    answer();
  });

  it('exits at a second press after the run ended between the two', async () => {
    const { app, backend, exited, clock } = await freshlyOpened(panel);
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    backend.finish(runView({ status: 'CANCELLED' }));
    await untilFrame(app, (shown) => shown.includes('CANCELLED') && shown.includes(HINT));
    clock.advance(100);
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual(EXITED);
    expect(cancels(backend)).toBe(1);
  });

  it('cancels and arms at a press that arrives before the panel is drawn', async () => {
    const { app, backend, exited } = await workingWithSettle();
    panel.ask(backend);
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    await untilFrame(app, HINT);
    app.stdin.write(KEYS.ctrlC);
    expect(await exited).toEqual(EXITED);
    expect(cancels(backend)).toBe(1);
  });
});
