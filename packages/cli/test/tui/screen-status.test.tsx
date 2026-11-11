import { describe, expect, it } from 'vitest';
import type { ToolCallingState } from '@momonga/protocol';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import { runView } from '../fake-backend.ts';
import { account, startPlan } from '../fake-plan-gateway.tsx';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { frame, runStarted, start, type } from '../tui-harness.tsx';
import { manualClock } from './screen-clock.ts';
import { SESSION } from '../fake-backend.ts';

const linesOf = (text: string | undefined): string[] => (text ?? '').split('\n');

const CTRL_O = '\u000f';

const keyX: TerminalEvent = { type: 'key', text: 'x', ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };

const working = async (size = { columns: 70, rows: 14 }) => {
  const clock = manualClock(10_000);
  const started = await start({}, { now: clock.now, timers: clock.timers }, size);
  await untilFrame(started.app, 'mode: manual');
  await runStarted(started.backend, started.app, 'go');
  await untilFrame(started.app, 'esc to cancel');
  return { ...started, clock };
};

describe('the waiting row in the screen (6.1)', () => {
  it('shows each phase with its seconds, advances with the one timer and leaves when the run ends', async () => {
    const { app, backend, clock } = await working();
    expect(linesOf(app.lastFrame())[8]).toBe('⠋ waiting for the model 0s · esc to cancel');
    clock.advance(2100);
    await untilFrame(app, '⠙ waiting for the model 2s · esc to cancel');
    backend.emit(frame({ type: 'model.requested', attempt: 0, digest: 'd', createdAt: 12_000 }));
    clock.advance(1000);
    await untilFrame(app, 'waiting for the model 1s · esc to cancel');
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'hello', createdAt: 13_000 }));
    clock.advance(100);
    await untilFrame(app, 'responding 0s · esc to cancel');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: {}, createdAt: 13_100 }));
    clock.advance(5000);
    await untilFrame(app, 'running Bash ls 5s · esc to cancel');
    backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }));
    backend.finish(runView());
    const idle = await untilFrame(app, (shown) => !shown.includes('to cancel'));
    expect(idle).toContain('hello');
    expect(clock.pending()).toBe(0);
    app.unmount();
  });

  it('is hidden while an approval is open and names the reconnect as a phase', async () => {
    const { app, backend, clock } = await working({ columns: 80, rows: 20 });
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: { command: 'ls' } }));
    backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], reason: 'ask' }));
    const asked = await untilFrame(app, 'Permission requested: Bash ls');
    expect(asked).not.toMatch(/\ds · esc to cancel/);
    backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilFrame(app, /running Bash ls \d+s · esc to cancel/);
    backend.following().onReconnecting?.(1);
    clock.advance(100);
    await untilFrame(app, 'reconnecting to the daemon 0s · esc to cancel');
    backend.emit(frame({ type: 'tool.started', callId: 'c1', idemKey: 'k' }));
    await untilFrame(app, /running Bash ls \d+s · esc to cancel/);
    app.unmount();
  });
});

describe('the measuring row ends with its cause (6.2)', () => {
  const probing: ToolCallingState = { state: 'probing', message: 'target primary is being measured', retryAfterSeconds: 5 };
  const unavailable: ToolCallingState = { state: 'unavailable', status: 503, type: 'server_error', code: 'target_probe_failed', message: 'measuring this model failed: no answer' };

  it('is a row while the model is measured, not an entry, and becomes one warning with the cause and the remedy', async () => {
    const clock = manualClock(1000);
    const toolCalling: Record<string, ToolCallingState> = { [SESSION.model]: probing };
    const { app, backend } = await start({ toolCalling }, { now: clock.now, timers: clock.timers }, { columns: 100, rows: 14 });
    const measuring = linesOf(await untilFrame(app, 'measuring this model'));
    expect(measuring[9]).toBe('⠋ measuring this model (once per model and OS build) 0s');
    expect(measuring.join('\n')).not.toContain('target primary is being measured');
    clock.advance(5000);
    await untilFrame(app, 'measuring this model (once per model and OS build) 5s');
    toolCalling[SESSION.model] = unavailable;
    clock.advance(5000);
    const ended = await untilFrame(app, 'measuring this model failed: no answer');
    expect(ended).toContain('Choose a model with /model');
    expect(ended).not.toContain('once per model and OS build');
    expect(clock.pending()).toBe(0);
    expect(backend.started).toEqual([]);
    app.unmount();
  });

  it('disappears without a word when the model is ready', async () => {
    const clock = manualClock(1000);
    const toolCalling: Record<string, ToolCallingState> = { [SESSION.model]: probing };
    const { app } = await start({ toolCalling }, { now: clock.now, timers: clock.timers }, { columns: 100, rows: 14 });
    await untilFrame(app, 'measuring this model');
    toolCalling[SESSION.model] = 'native';
    clock.advance(5000);
    const ready = await untilFrame(app, (shown) => !shown.includes('measuring') && shown.includes('context: 0%'));
    expect(linesOf(ready).slice(0, 9).join('').trim()).toBe('');
    app.unmount();
  });
});

describe('the thinking display in the screen (6.3)', () => {
  it('streams the thought under its header, folds it to one line and reopens it with ctrl+o', async () => {
    const { app, backend } = await working({ columns: 70, rows: 20 });
    backend.emit(frame({ type: 'agent.thought.delta', attempt: 0, itemId: 't1', text: 'first idea\nsecond idea', createdAt: 20_000 }));
    const open = await untilFrame(app, 'second idea');
    expect(open).toContain('Thinking');
    expect(open).toMatch(/thinking \d+s · esc to cancel/);
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'the answer', createdAt: 32_000 }));
    const folded = await untilFrame(app, 'Thought for 12s');
    expect(folded).not.toContain('first idea');
    expect(folded).toContain('the answer');
    app.stdin.write(CTRL_O);
    const reopened = linesOf(await untilFrame(app, 'first idea'));
    const header = reopened.findIndex((line) => line.startsWith('Thought for 12s'));
    expect(reopened.slice(header, header + 3).map((line) => line.replace(/ *[│█]$/, ''))).toEqual(['Thought for 12s', 'first idea', 'second idea']);
    app.stdin.write(CTRL_O);
    await untilFrame(app, (shown) => !shown.includes('first idea') && shown.includes('Thought for 12s'));
    app.unmount();
  });
});

describe('a state that ends is not an entry (6.5)', () => {
  it('says the new permission mode in the footer until the next key and writes no entry', async () => {
    const { app, terminal } = await start({}, {}, { columns: 100, rows: 14 });
    await untilFrame(app, 'mode: manual');
    await type(app, '/mode plan', '> /mode plan');
    app.stdin.write(KEYS.enter);
    const said = linesOf(await untilFrame(app, 'permission mode: plan'));
    expect(said[13]).toMatch(/^mode: plan \(shift\+tab\) · tokens: 0 · context: 0% +permission mode: plan$/);
    expect(said.slice(0, 10).join('').trim()).toBe('');
    terminal.emit(keyX);
    const after = linesOf(await untilFrame(app, 'new line'));
    expect(after[13]).toMatch(/^mode: plan \(shift\+tab\) · tokens: 0 · context: 0% +ctrl\+j: new line$/);
    app.unmount();
  });
});

describe('the start screen without a model (6.4)', () => {
  it('says that no model is connected on its model line and keeps the footer wording', async () => {
    const { app } = await startPlan({ models: [], accounts: [account({ state: 'needs_sign_in', active: false, pinnedBy: [] })] }, { startup: { version: '1.2.3', home: '/home/none', color: false } }, { columns: 100, rows: 16 });
    const screen = await untilFrame(app, 'model: not connected  (use /login)');
    expect(screen).toContain('MomongaCode v1.2.3');
    expect(screen).toContain('no model connected · /login');
    expect(screen).not.toContain('mode:');
    app.unmount();
  });
});
