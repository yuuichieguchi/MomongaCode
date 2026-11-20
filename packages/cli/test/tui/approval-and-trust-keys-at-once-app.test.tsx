import { describe, expect, it } from 'vitest';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import type { FakeBackend } from '../fake-backend.ts';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { frame, runStarted, start } from '../tui-harness.tsx';
import { manualClock } from './screen-clock.ts';

const ALLOW = { optionId: 'o1', name: 'Allow once', kind: 'allow_once' };
const REJECT = { optionId: 'o3', name: 'Reject once', kind: 'reject_once' };

const PANEL = 'Permission requested: Bash c1';
const HINT = '1-9 or enter to choose';
const NO_TRUST = 'No, continue without its project settings';

const ask = (backend: FakeBackend, callId = 'c1', approvalId = 'ap1'): void => {
  backend.emit(frame({ type: 'tool.call', callId, providerCallId: callId, name: 'Bash', kind: 'execute', title: `Bash ${callId}`, rawInput: { command: 'ls' } }));
  backend.emit(frame({ type: 'tool.permission.requested', approvalId, callId, subjectDigest: 'd', reason: 'asks', options: [ALLOW, REJECT], shown: { title: 'approval', input: {} } }));
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
  await runStarted(started.backend, started.app, 'go');
  clock.advance(KEY_SETTLE_MS);
  return { ...started, clock };
};

describe('a prompt takes a key at once', () => {
  it('a digit 0 ms after it appears is the answer', async () => {
    const { app, backend } = await working();
    ask(backend);
    await untilFrame(app, PANEL);
    app.stdin.write('1');
    await backend.called('approve:ap1:o1');
    expect(approvals(backend)).toEqual(['approve:ap1:o1']);
    app.unmount();
  });

  it('with no draft and no key before it, enter 0 ms after it appears accepts the highlighted row', async () => {
    const { app, backend } = await working();
    ask(backend);
    await untilFrame(app, PANEL);
    app.stdin.write(KEYS.enter);
    await backend.called('approve:ap1:o1');
    expect(approvals(backend)).toEqual(['approve:ap1:o1']);
    app.unmount();
  });

  it('ends at once at the release of a key pressed after it was drawn, on a terminal that reports releases', async () => {
    const { app, backend, terminal } = await working();
    ask(backend);
    await untilFrame(app, PANEL);
    app.stdin.write(KEYS.down);
    terminal.emit({ type: 'release' });
    await untilFrame(app, HINT);
    app.unmount();
  });
});

describe('a prompt that opened under the hands', () => {
  it('opened over a draft typed long before: the draft stays, and enter 0 ms after it appears accepts', async () => {
    const { app, backend, clock } = await working();
    app.stdin.write('abc');
    await untilFrame(app, '> abc');
    clock.advance(KEY_SETTLE_MS * 10);
    ask(backend);
    await untilFrame(app, PANEL);
    app.stdin.write(KEYS.enter);
    await backend.called('approve:ap1:o1');
    backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilFrame(app, '> abc');
    app.unmount();
  });

  it('opened right after a key: the same rule, enter 0 ms after it appears accepts the highlighted row', async () => {
    const { app, backend } = await working();
    app.stdin.write('x');
    app.stdin.write(KEYS.backspace);
    ask(backend);
    await untilFrame(app, PANEL);
    app.stdin.write(KEYS.enter);
    await backend.called('approve:ap1:o1');
    expect(approvals(backend)).toEqual(['approve:ap1:o1']);
    app.unmount();
  });

  it('a key 0 ms after the second of two approvals appears answers the second', async () => {
    const { app, backend } = await working();
    ask(backend, 'c1', 'ap1');
    ask(backend, 'c2', 'ap2');
    await untilFrame(app, PANEL);
    app.stdin.write('1');
    await backend.called('approve:ap1:o1');
    backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilFrame(app, 'Permission requested: Bash c2');
    app.stdin.write('1');
    await backend.called('approve:ap2:o1');
    expect(approvals(backend)).toEqual(['approve:ap1:o1', 'approve:ap2:o1']);
    app.unmount();
  });
});

describe('a held approval takes the keys only while the run waits for it', () => {
  const HELD = { type: 'tool.held', callId: 'c1', approvalId: 'ap1', reason: 'needs a person', footprint: { reads: [], writes: [] } };

  it('leaves the input and its keys to the draft while the run goes on, and takes them when the run waits', async () => {
    const { app, backend, clock } = await working();
    ask(backend);
    backend.emit(frame(HELD));
    await untilFrame(app, '1 call held for your approval');
    expect(app.lastFrame()).not.toContain(PANEL);
    app.stdin.write('1');
    await untilFrame(app, '> 1');
    app.stdin.write(KEYS.backspace);
    await renderedAfter(app, backend);
    expect(approvals(backend)).toEqual([]);
    clock.advance(KEY_SETTLE_MS);
    backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'WAITING_HUMAN' }));
    await untilFrame(app, PANEL);
    app.stdin.write('1');
    await backend.called('approve:ap1:o1');
    app.unmount();
  });
});

describe('the folder trust prompt at launch', () => {
  const trusting = async () => {
    const clock = manualClock();
    const started = await start({ trust: { path: '/work/project', decision: null } }, { now: clock.now, timers: clock.timers });
    await untilFrame(started.app, 'Do you trust the files in /work/project?');
    return { ...started, clock };
  };

  it('enter 0 ms after it appears accepts Yes, once', async () => {
    const { app, backend } = await trusting();
    expect(app.lastFrame()).toContain('› 1. Yes, I trust this folder');
    app.stdin.write(KEYS.enter);
    await backend.called('trust:trusted');
    expect(backend.calls.filter((call) => call.startsWith('trust:'))).toEqual(['trust:trusted']);
    app.unmount();
  });

  it('reaches No by its digit and enter, at once', async () => {
    const { app, backend } = await trusting();
    app.stdin.write('2');
    await untilFrame(app, `› 2. ${NO_TRUST}`);
    app.stdin.write(KEYS.enter);
    await backend.called('trust:untrusted');
    app.unmount();
  });
});
