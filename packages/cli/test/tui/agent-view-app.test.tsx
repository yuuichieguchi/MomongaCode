import { describe, expect, it } from 'vitest';
import { KEYS as TABLE } from '../../src/tui/keys/table.ts';
import { allocate } from '../../src/tui/screen/layout.ts';
import type { RowRequests } from '../../src/tui/screen/layout.ts';
import { agentListLines } from '../../src/tui/screen/subagents.tsx';
import { createAgentViews } from '../../src/tui/screen/agent-views.ts';
import { createKeyTable } from '../../src/tui/keys/table.ts';
import type { KeyName, TerminalEvent } from '../../src/tui/terminal/events.ts';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { runView } from '../fake-backend.ts';
import { frame, runStarted, start } from '../tui-harness.tsx';

const plain = { ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };
const named = (name: KeyName): TerminalEvent => ({ type: 'key', name, ...plain });
const typed = (text: string): TerminalEvent => ({ type: 'key', text, ...plain });
const mouse = (kind: 'press' | 'release', col: number, row: number): TerminalEvent => ({ type: 'mouse', kind, button: 'left', col, row, ...plain });
const linesOf = (text: string | undefined): string[] => (text ?? '').split('\n');

const SIZE = { columns: 100, rows: 40 };
const childFrame = (runId: string, event: Record<string, unknown>) => frame({ runId, ...event });

const running = async (size = SIZE) => {
  let now = 1000;
  const started = await start({}, { now: () => now }, size);
  const { app, backend } = started;
  await untilFrame(app, 'mode: manual');
  await runStarted(backend, app, 'go');
  backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'main says hello' }));
  await untilFrame(app, 'main says hello');
  const follow = backend.following();
  follow.onChildStarted('reviewer', 'child-1');
  follow.onChildEvent(childFrame('child-1', { type: 'user.message', text: 'review the change' }), 'reviewer');
  follow.onChildEvent(childFrame('child-1', { type: 'agent.message.delta', attempt: 0, itemId: 'c1', text: 'child one looks' }), 'reviewer');
  follow.onChildEvent(childFrame('child-1', { type: 'agent.message.delta', attempt: 0, itemId: 'c2', text: 'child two checks' }), 'reviewer');
  now = 4000;
  follow.onChildStarted('tester', 'child-2');
  await untilFrame(app, 'tester · starting · 0s');
  return { ...started, follow, setNow: (value: number) => (now = value) };
};

const listRowOf = (shown: string, text: string): number => linesOf(shown).findIndex((line) => line.includes(text)) + 1;

const openWithKeys = async (started: Awaited<ReturnType<typeof running>>, downs: number) => {
  for (let index = 0; index < downs; index += 1) started.terminal.emit(named('down'));
  started.terminal.emit(named('enter'));
};

describe('the list of the running subagents (design cli-tui 3.3)', () => {
  it('lists main first and then each running subagent, with main marked as shown, and a hint of the keys', async () => {
    const { app } = await running();
    const lines = linesOf(app.lastFrame());
    expect(lines).toHaveLength(40);
    expect(lines.slice(36)).toEqual(['● main', '  reviewer · starting · 3s', '  tester · starting · 0s', 'down on an empty input: choose a view · enter: open']);
    app.unmount();
  });

  it('opens a subagent with the keys and shows its conversation in one frame, not the main one', async () => {
    const started = await running();
    const { app } = started;
    const before = app.frames.length;
    await openWithKeys(started, 2);
    const shown = await untilFrame(app, 'Subagent reviewer');
    const first = app.frames.slice(before).find((output) => output.includes('Subagent reviewer'));
    expect(first).toContain('child two checks');
    expect(shown).toContain('review the change');
    expect(shown).toContain('child one looks');
    expect(shown).not.toContain('main says hello');
    expect(linesOf(shown).slice(36, 39)).toEqual(['  main', '● reviewer · starting · 3s', '  tester · starting · 0s']);
    started.follow.onChildEvent(childFrame('child-1', { type: 'agent.message.delta', attempt: 0, itemId: 'c3', text: 'child three live' }), 'reviewer');
    await untilFrame(app, 'child three live');
    app.unmount();
  });

  it('goes back to the main conversation at its end with Enter on main, and switches between subagents the same way', async () => {
    const started = await running();
    const { app, terminal } = started;
    await openWithKeys(started, 2);
    await untilFrame(app, 'Subagent reviewer');
    await openWithKeys(started, 3);
    await untilFrame(app, 'Subagent tester');
    terminal.emit(named('down'));
    terminal.emit(named('enter'));
    const back = await untilFrame(app, (shown) => shown.includes('main says hello') && !shown.includes('Subagent'));
    expect(linesOf(back).slice(36, 37)).toEqual(['● main']);
    app.unmount();
  });

  it('moves up past main back to the input, and a typed character goes to the input', async () => {
    const started = await running();
    const { app, terminal } = started;
    terminal.emit(named('down'));
    terminal.emit(named('up'));
    terminal.emit(named('enter'));
    terminal.emit(named('down'));
    terminal.emit(typed('x'));
    await untilFrame(app, '> x');
    expect(app.lastFrame()).not.toContain('Subagent');
    app.unmount();
  });

  it('opens a row with a click without movement, at the row it is drawn on', async () => {
    const started = await running();
    const { app, terminal } = started;
    const row = listRowOf(app.lastFrame() ?? '', 'tester ·');
    terminal.emit(mouse('press', 3, row));
    terminal.emit(mouse('release', 3, row));
    await untilFrame(app, 'Subagent tester');
    const main = listRowOf(app.lastFrame() ?? '', '  main');
    terminal.emit(mouse('press', 3, main));
    terminal.emit(mouse('release', 3, main));
    await untilFrame(app, (shown) => shown.includes('main says hello') && !shown.includes('Subagent'));
    app.unmount();
  });

  it('stops the run with Esc while a subagent is shown and stays on that view', async () => {
    const started = await running();
    const { app, terminal, backend } = started;
    await openWithKeys(started, 2);
    await untilFrame(app, 'Subagent reviewer');
    terminal.emit(named('escape'));
    await backend.called('cancel:run-1');
    expect(app.lastFrame()).toContain('Subagent reviewer');
    app.unmount();
  });

  it('sends what is typed while a subagent is shown to the main run', async () => {
    const started = await running();
    const { app, backend } = started;
    await openWithKeys(started, 2);
    await untilFrame(app, 'Subagent reviewer');
    app.stdin.write('also the docs');
    await untilFrame(app, '> also the docs');
    app.stdin.write(KEYS.enter);
    await backend.called('inbox:steer:also the docs');
    expect(app.lastFrame()).toContain('Subagent reviewer');
    app.unmount();
  });

  it('shows an approval of a subagent with its name in the panel, in the main view and in the subagent view', async () => {
    const started = await running();
    const { app, follow, terminal } = started;
    await openWithKeys(started, 3);
    await untilFrame(app, 'Subagent tester');
    follow.onChildEvent(childFrame('child-1', { type: 'tool.call', callId: 'k1', providerCallId: 'p-k1', name: 'Bash', kind: 'execute', title: 'Bash rm -r build', rawInput: {} }), 'reviewer');
    follow.onChildEvent(
      childFrame('child-1', { type: 'tool.permission.requested', approvalId: 'ap1', callId: 'k1', subjectDigest: 'd', reason: 'commands require approval', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'Bash rm -r build', input: {} } }),
      'reviewer',
    );
    const asked = await untilFrame(app, 'Allow once');
    expect(asked).toContain('reviewer');
    expect(asked).toContain('Subagent tester');
    terminal.emit(named('escape'));
    app.unmount();
  });

  it('keeps the finished view of the shown subagent with its end line, and no running row is marked', async () => {
    const started = await running();
    const { app, follow } = started;
    await openWithKeys(started, 2);
    await untilFrame(app, 'Subagent reviewer');
    follow.onChildEnded('reviewer', 'child-1', { kind: 'finished', run: runView({ id: 'child-1', status: 'COMPLETED' }) });
    const ended = await untilFrame(app, 'momonga: run child-1 COMPLETED');
    expect(ended).toContain('child two checks');
    expect(linesOf(ended).slice(37, 39)).toEqual(['  main', '  tester · starting · 0s']);
    follow.onChildEnded('tester', 'child-2', { kind: 'finished', run: runView({ id: 'child-2', status: 'COMPLETED' }) });
    const alone = await untilFrame(app, (shown) => !shown.includes('tester ·'));
    expect(linesOf(alone).at(-1)).toBe('  main');
    started.terminal.emit(named('down'));
    started.terminal.emit(named('enter'));
    const back = await untilFrame(app, (shown) => shown.includes('main says hello'));
    expect(back).not.toContain('  main');
    app.unmount();
  });
});

describe('the rows of the list', () => {
  const keys = createKeyTable();
  const subagents = [
    { runId: 'child-1', agent: 'reviewer', title: 'Read a.ts', startedAt: 0, awaitingApproval: false },
    { runId: 'child-2', agent: 'tester', title: undefined, startedAt: 0, awaitingApproval: true },
  ];

  it('drops the hint before a row and keeps main, then cuts subagents to an overflow row', () => {
    const facts = { subagents, shown: undefined, focus: undefined, keys, screenReader: false, now: 2000 };
    expect(agentListLines({ ...facts, rows: 4 }).map((line) => line.text)).toEqual(['● main', '  reviewer · Read a.ts · 2s', '  tester · waiting for approval · 2s', 'down on an empty input: choose a view · enter: open']);
    expect(agentListLines({ ...facts, rows: 3 }).map((line) => line.text)).toEqual(['● main', '  reviewer · Read a.ts · 2s', '  tester · waiting for approval · 2s']);
    expect(agentListLines({ ...facts, rows: 2 }).map((line) => line.text)).toEqual(['● main', 'and 2 more']);
  });

  it('names the shown row as plain text for a screen reader and states the keys of the list while it is chosen', () => {
    const lines = agentListLines({ subagents, shown: 'child-1', focus: 1, keys, screenReader: true, now: 0, rows: 4 }).map((line) => line.text);
    expect(lines).toEqual(['main', 'reviewer · Read a.ts · 0s (shown)', 'tester · waiting for approval · 0s', 'up or down: move · enter: open · typing returns to the input']);
  });

  it('allocates the list rows and the hint at 100x40 and 40x24', () => {
    const requests: RowRequests = { waiting: 1, inputRows: 1, invitation: 0, menu: 0, subagents: 4, footerSecond: 1, lines: 0, panel: undefined };
    expect(allocate(40, requests)).toMatchObject({ subagents: 4, footer: 2, input: 3, viewport: 30 });
    expect(allocate(24, requests)).toMatchObject({ subagents: 4, footer: 2, input: 3, viewport: 14 });
  });

  it('lists the new actions in the key table', () => {
    expect(TABLE.filter((row) => row.context === 'agents').map((row) => [row.id, row.default])).toEqual([
      ['agents.previous', ['up']],
      ['agents.next', ['down']],
      ['agents.open', ['enter']],
    ]);
  });

  it('names the new actions in /keybindings', async () => {
    const { app } = await start({}, {}, { columns: 150, rows: 40 });
    await untilFrame(app, 'mode: manual');
    app.stdin.write('/keybindings');
    await untilFrame(app, '> /keybindings');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'Key bindings');
    app.stdin.write('agents.');
    const shown = await untilFrame(app, 'agents.open  enter');
    expect(shown).toContain('agents.next  down');
    expect(shown).toContain('agents.previous  up');
    app.unmount();
  });
});

describe('the conversations kept for the views', () => {
  const finished = (id: string) => ({ kind: 'finished', run: runView({ id, status: 'COMPLETED' }) }) as const;

  it('keeps one per running subagent and the one finished view being shown, and drops it when the view is left', () => {
    const views = createAgentViews();
    views.started('reviewer', 'child-1');
    views.started('tester', 'child-2');
    views.ended('child-2', finished('child-2'));
    expect(views.kept()).toBe(1);
    views.open('child-1');
    views.ended('child-1', finished('child-1'));
    expect(views.kept()).toBe(1);
    expect(views.shown()?.runId).toBe('child-1');
    views.open(undefined);
    expect(views.kept()).toBe(0);
  });
});
