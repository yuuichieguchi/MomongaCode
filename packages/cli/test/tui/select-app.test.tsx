import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@momonga/protocol';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import type { FakeBackend } from '../fake-backend.ts';
import { KEYS, untilFrame, untilOutput } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { choose, startPlan, submitLine } from '../fake-plan-gateway.tsx';
import { frame, runStarted, start, type } from '../tui-harness.tsx';
import { SESSION } from '../fake-backend.ts';

const plain = { ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };
const press = (row: number, col = 6): TerminalEvent => ({ type: 'mouse', kind: 'press', button: 'left', col, row, ...plain });
const wheel = (button: 'wheel-up' | 'wheel-down', row: number): TerminalEvent => ({ type: 'mouse', kind: 'wheel', button, col: 6, row, ...plain });

const CTRL_O = '\u000f';

const screenRowOf = (app: Instance, text: string): number => (app.lastFrame() ?? '').split('\n').findIndex((line) => line.includes(text)) + 1;

const TRUST_HINT = 'up/down to move · enter to choose · esc: No, continue without its project settings';
const NO_TRUST = 'No, continue without its project settings';

const ALLOW = { optionId: 'o1', name: 'Allow once', kind: 'allow_once' };
const ALWAYS_REJECT = { optionId: 'o4', name: 'Always reject', kind: 'reject_always' };
const REJECT = { optionId: 'o3', name: 'Reject once', kind: 'reject_once' };

const askFor = (backend: FakeBackend, callId: string, approvalId: string, options: readonly unknown[], reason = 'asks'): void => {
  backend.emit(frame({ type: 'tool.call', callId, providerCallId: callId, name: 'Bash', kind: 'execute', title: `Bash ${callId}`, rawInput: { command: 'ls' } }));
  backend.emit(frame({ type: 'tool.permission.requested', approvalId, callId, subjectDigest: 'd', reason, options, shown: { title: 'approval', input: {} } }));
};

const approving = async (options: readonly unknown[], size: { columns?: number; rows?: number } = {}, reason = 'asks') => {
  const started = await start({}, {}, size);
  await untilFrame(started.app, 'mode: manual');
  await runStarted(started.backend, started.app, 'go');
  askFor(started.backend, 'c1', 'ap1', options, reason);
  await untilFrame(started.app, (now) => now.includes('Permission requested: Bash c1') && now.includes('to choose'));
  return started;
};

describe('the folder trust prompt is the selection component and only enter decides', () => {
  const trusting = async () => {
    const started = await start({ trust: { path: '/work/project', decision: null } });
    await untilFrame(started.app, (now) => now.includes('Do you trust the files in /work/project?') && now.includes('to choose'));
    return started;
  };

  it('starts on Yes, numbers its rows and names the keys that act', async () => {
    const { app } = await trusting();
    const shown = app.lastFrame() ?? '';
    expect(shown).toContain('› 1. Yes, I trust this folder');
    expect(shown).toContain(`  2. ${NO_TRUST}`);
    expect(shown).toContain(TRUST_HINT);
    app.unmount();
  });

  it('a digit only moves the highlight and enter decides the highlighted row', async () => {
    const { app, backend } = await trusting();
    app.stdin.write('2');
    await untilFrame(app, `› 2. ${NO_TRUST}`);
    expect(backend.calls).toEqual(['boot']);
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'mode: manual');
    expect(backend.calls).toEqual(['boot', 'trust:untrusted', 'openSession', 'session-stream-open:session-1', 'memory-judgements:/work/project']);
    app.unmount();
  });

  it('escape is the same as choosing No', async () => {
    const { app, backend } = await trusting();
    app.stdin.write(KEYS.escape);
    await untilFrame(app, 'mode: manual');
    expect(backend.calls).toEqual(['boot', 'trust:untrusted', 'openSession', 'session-stream-open:session-1', 'memory-judgements:/work/project']);
    app.unmount();
  });

  it('a press on a row decides it', async () => {
    const { app, backend, terminal } = await trusting();
    expect(terminal.emit(press(screenRowOf(app, `2. ${NO_TRUST}`)))).toBe(true);
    await untilFrame(app, 'mode: manual');
    expect(backend.calls).toEqual(['boot', 'trust:untrusted', 'openSession', 'session-stream-open:session-1', 'memory-judgements:/work/project']);
    app.unmount();
  });
});

describe('the tool approval is the selection component and decides at once', () => {
  it('names the keys that act, with the row escape decides', async () => {
    const { app } = await approving([ALLOW, ALWAYS_REJECT, REJECT]);
    const shown = app.lastFrame() ?? '';
    expect(shown).toContain('› 1. Allow once');
    expect(shown).toContain('1-9 or enter to choose · up/down to move · esc: Reject once · ctrl+c: cancel the run');
    app.unmount();
  });

  it('escape declines this call with the reject-once option and does not cancel the run', async () => {
    const { app, backend } = await approving([ALLOW, ALWAYS_REJECT, REJECT]);
    app.stdin.write(KEYS.escape);
    await backend.called('approve:ap1:o3');
    expect(backend.calls).not.toContain('cancel:run-1');
    app.unmount();
  });

  it('escape declines with the first reject option when there is no reject-once', async () => {
    const { app, backend } = await approving([ALLOW, ALWAYS_REJECT]);
    expect(app.lastFrame()).toContain('esc: Always reject');
    app.stdin.write(KEYS.escape);
    await backend.called('approve:ap1:o4');
    app.unmount();
  });

  it('escape does nothing and is not in the hint when no option rejects', async () => {
    const { app, backend } = await approving([ALLOW]);
    expect(app.lastFrame()).toContain('1-9 or enter to choose · up/down to move · ctrl+c: cancel the run');
    app.stdin.write(KEYS.escape);
    app.stdin.write('1');
    await backend.called('approve:ap1:o1');
    expect(backend.calls).not.toContain('cancel:run-1');
    app.unmount();
  });

  it('ctrl+c cancels the run', async () => {
    const { app, backend } = await approving([ALLOW, REJECT]);
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    expect(backend.calls.filter((call) => call.startsWith('approve:'))).toEqual([]);
    app.unmount();
  });

  it('a press on a row decides it as enter on that row would', async () => {
    const { app, backend, terminal } = await approving([ALLOW, REJECT], { columns: 80, rows: 16 });
    expect(terminal.emit(press(screenRowOf(app, '2. Reject once')))).toBe(true);
    await backend.called('approve:ap1:o3');
    app.unmount();
  });

  it('a press elsewhere in the panel decides nothing', async () => {
    const { app, backend, terminal } = await approving([ALLOW, REJECT], { columns: 80, rows: 16 });
    expect(terminal.emit(press(screenRowOf(app, 'Permission requested')))).toBe(true);
    expect(terminal.emit(wheel('wheel-down', screenRowOf(app, '2. Reject once')))).toBe(true);
    app.stdin.write('1');
    await backend.called('approve:ap1:o1');
    expect(backend.calls.filter((call) => call.startsWith('approve:'))).toEqual(['approve:ap1:o1']);
    app.unmount();
  });

  it('ignores keys and presses after a decision was sent and shows sending... until the prompt is withdrawn', async () => {
    const { app, backend, terminal } = await approving([ALLOW, REJECT], { columns: 80, rows: 16 });
    const rejectRow = screenRowOf(app, '2. Reject once');
    app.stdin.write('1');
    await untilFrame(app, 'sending...');
    app.stdin.write('2');
    app.stdin.write(KEYS.enter);
    app.stdin.write(KEYS.escape);
    terminal.emit(press(rejectRow));
    backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilFrame(app, (shown) => !shown.includes('Permission requested'));
    expect(backend.calls.filter((call) => call.startsWith('approve:'))).toEqual(['approve:ap1:o1']);
    app.unmount();
  });

  it('returns with the error when the send fails and can be decided again', async () => {
    const { app, backend } = await approving([ALLOW, REJECT]);
    const resolveApproval = backend.resolveApproval;
    backend.resolveApproval = () => Promise.reject(new Error('the daemon refused'));
    app.stdin.write('1');
    const shown = await untilFrame(app, 'the daemon refused');
    expect(shown).toContain('1-9 or enter to choose');
    backend.resolveApproval = resolveApproval;
    app.stdin.write('2');
    await backend.called('approve:ap1:o3');
    app.unmount();
  });

  it('a withdrawn prompt decides nothing', async () => {
    const { app, backend } = await approving([ALLOW, REJECT]);
    backend.emit(frame({ type: 'tool.permission.cancelled', approvalId: 'ap1' }));
    await untilFrame(app, (shown) => !shown.includes('Permission requested'));
    app.stdin.write('1');
    await untilFrame(app, '> 1');
    expect(backend.calls.filter((call) => call.startsWith('approve:'))).toEqual([]);
    app.unmount();
  });

  it('counts the prompts that wait', async () => {
    const { app, backend } = await approving([ALLOW, REJECT]);
    askFor(backend, 'c2', 'ap2', [ALLOW, REJECT]);
    askFor(backend, 'c3', 'ap3', [ALLOW, REJECT]);
    await untilFrame(app, 'Permission requested: Bash c1 (1 of 3)');
    backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilFrame(app, 'Permission requested: Bash c2 (1 of 2)');
    app.unmount();
  });

  it('never hides what it approves: text that does not fit is counted and ctrl+o shows all of it', async () => {
    const reason = Array.from({ length: 30 }, (_, index) => `reason ${index}`).join('\n');
    const { app, backend } = await approving([ALLOW, REJECT], { columns: 80, rows: 16 }, reason);
    const clipped = app.lastFrame() ?? '';
    expect(clipped).toMatch(/… \d+ more lines \(ctrl\+o shows all\)/);
    expect(clipped).not.toContain('reason 29');
    expect(clipped).toContain('2. Reject once');
    app.stdin.write(CTRL_O);
    const detail = await untilFrame(app, 'up/down to scroll · esc to return');
    expect(detail).not.toContain('Reject once');
    app.stdin.write('\u001b[6~');
    app.stdin.write('\u001b[6~');
    app.stdin.write('\u001b[6~');
    await untilFrame(app, 'reason 29');
    app.stdin.write('1');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, '2. Reject once');
    expect(backend.calls.filter((call) => call.startsWith('approve:') || call.startsWith('cancel:'))).toEqual([]);
    app.unmount();
  });
});

describe('the decision of an MCP input is the selection component', () => {
  const FORM: ElicitationRequestView = { key: 'profile', mode: 'form', message: 'Tell me about you', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Your name' } }, required: ['name'] } };

  const asked = async () => {
    const started = await start();
    await untilFrame(started.app, 'mode: manual');
    await runStarted(started.backend, started.app, 'ask');
    started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'mcp__calc__ask', kind: 'other', title: 'mcp__calc__ask {}', rawInput: {} }));
    started.backend.emit(frame({ type: 'tool.elicitation.requested', inputId: 'in1', callId: 'c1', server: 'calc', requests: [FORM] }));
    await untilFrame(started.app, (now) => now.includes('MCP server calc asks for input') && now.includes('to confirm the value'));
    return started;
  };

  it('escape in the field stage returns to the decision, whose escape declines and does not cancel the run', async () => {
    const { app, backend } = await asked();
    expect(app.lastFrame()).toContain('enter to confirm the value · esc: decline or cancel instead');
    app.stdin.write(KEYS.escape);
    const decision = await untilFrame(app, '2. Decline');
    expect(decision).toContain('› 1. Submit');
    expect(decision).toContain('1-9 or enter to choose · up/down to move · esc: Decline · ctrl+c: cancel the run');
    app.stdin.write(KEYS.escape);
    await backend.called('elicit:in1');
    expect(backend.elicitationAnswers[0]?.responses).toEqual({ profile: { action: 'decline' } });
    expect(backend.calls).not.toContain('cancel:run-1');
    app.unmount();
  });

  it('ctrl+c cancels the run', async () => {
    const { app, backend } = await asked();
    app.stdin.write(KEYS.escape);
    await untilFrame(app, '2. Decline');
    app.stdin.write(KEYS.ctrlC);
    await backend.called('cancel:run-1');
    expect(backend.elicitationAnswers).toEqual([]);
    app.unmount();
  });
});

describe('a picker is the selection component', () => {
  it('decides at once by a digit and escape goes back', async () => {
    const { app, backend } = await startPlan({ models: [SESSION.model, 'ollama/qwen3.8:27b'] });
    await untilFrame(app, 'mode: manual');
    await type(app, '/model', '> /model');
    app.stdin.write(KEYS.enter);
    const picker = await untilFrame(app, (shown) => shown.includes('qwen3.8:27b ') && shown.includes('esc: go back'));
    expect(picker).toContain('› 1. scripted-model (current)  metered');
    expect(picker).toContain('a change applies from the next run');
    expect(picker).toContain('1-9 or enter to choose · up/down to move · tab: also use at every start · esc: go back');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, /^(?![\s\S]*qwen3\.8:27b +metered)[\s\S]*mode: manual/);
    await type(app, '/model', '> /model');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'esc: go back');
    app.stdin.write('2');
    await untilOutput(app, 'model: ollama/qwen3.8:27b');
    await untilFrame(app, /^(?![\s\S]*esc: go back)[\s\S]*mode: manual/);
    expect(backend.calls.filter((call) => call.startsWith('cancel:'))).toEqual([]);
    app.unmount();
  });
});

describe('the sandbox-off dialog is decided only by enter and starts on the safe row', () => {
  it('starts on Cancel, a digit only moves, and escape cancels', async () => {
    const { app, backend } = await startPlan({ accounts: [] });
    backend.sandbox = async () => 'none';
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login chatgpt');
    const dialog = await untilFrame(app, (shown) => shown.includes('The sandbox is off') && shown.includes('esc: Cancel'));
    expect(dialog).toContain('› 2. Cancel');
    expect(dialog).toContain('up/down to move · enter to choose · esc: Cancel');
    app.stdin.write('1');
    await untilFrame(app, '› 1. Continue');
    expect(app.lastFrame()).toContain('The sandbox is off');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => !shown.includes('The sandbox is off'));
    app.stdin.write('typed');
    await untilFrame(app, '> typed');
    expect(backend.planCalls.map((call) => call.route)).not.toContain('sign-in/begin');
    app.unmount();
  });
});

describe('the slash menu is the same rows, inline above the input', () => {
  it('lists the matching commands with their descriptions, the highlighted one first', async () => {
    const { app } = await start();
    await untilFrame(app, 'mode: manual');
    await type(app, '/mo', '> /mo');
    const shown = await untilFrame(app, '› /mode');
    expect(shown).toMatch(/› \/mode .*\n {2}\/model \[model\] \[effort\] \[--start\] {2}/);
    expect(shown).not.toMatch(/\/models\b/);
    app.unmount();
  });

  it('down moves and tab completes the highlighted name into the input', async () => {
    const { app } = await start();
    await untilFrame(app, 'mode: manual');
    await type(app, '/mo', '> /mo');
    await untilFrame(app, '› /mode');
    app.stdin.write(KEYS.down);
    await untilFrame(app, '› /model [model]');
    app.stdin.write('\t');
    await untilFrame(app, /│ > \/model {2}/);
    app.unmount();
  });

  it('enter runs the highlighted command', async () => {
    const { app } = await start();
    await untilFrame(app, 'mode: manual');
    await type(app, '/hel', '> /hel');
    await untilFrame(app, '› /help');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, '/help  list the commands, the keys and the mouse actions');
    app.unmount();
  });

  it('says when no command matches and escape closes the menu and keeps the text', async () => {
    const { app, backend } = await start();
    await untilFrame(app, 'mode: manual');
    await type(app, '/xyz', '> /xyz');
    await untilFrame(app, 'No commands match "/xyz"');
    app.stdin.write(KEYS.escape);
    const closed = await untilFrame(app, /^(?![\s\S]*No commands match)[\s\S]*> \/xyz/);
    expect(closed).toContain('> /xyz');
    expect(backend.calls.filter((call) => call.startsWith('cancel:'))).toEqual([]);
    app.unmount();
  });

  it('a press on a row completes it into the input and does not run it', async () => {
    const { app, terminal } = await start({}, {}, { columns: 80, rows: 24 });
    await untilFrame(app, 'mode: manual');
    await type(app, '/mo', '> /mo');
    await untilFrame(app, '› /mode');
    expect(terminal.emit(press(screenRowOf(app, '/model [model]')))).toBe(true);
    await untilFrame(app, /│ > \/model {2}/);
    app.unmount();
  });
});
