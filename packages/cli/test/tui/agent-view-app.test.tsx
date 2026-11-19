import { describe, expect, it } from 'vitest';
import { KEYS as TABLE } from '../../src/tui/keys/table.ts';
import { allocate } from '../../src/tui/screen/layout.ts';
import type { RowRequests } from '../../src/tui/screen/layout.ts';
import { agentListLines, agentListRequest } from '../../src/tui/screen/subagents.tsx';
import { createAgentViews } from '../../src/tui/screen/agent-views.ts';
import { createKeyTable } from '../../src/tui/keys/table.ts';
import type { KeyName, TerminalEvent } from '../../src/tui/terminal/events.ts';
import { KEYS, untilFrame, untilOutput } from '../ink-helpers.ts';
import { runView } from '../fake-backend.ts';
import { frame, runStarted, start } from '../tui-harness.tsx';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCRIPTED_MODEL, SCRIPTED_MODEL_ID as SHOWN_MODEL, createTempDir } from '@momonga/testkit';

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
  follow.onChildStarted('reviewer', 'child-1', 0, SCRIPTED_MODEL, undefined);
  follow.onChildEvent(childFrame('child-1', { type: 'user.message', text: 'review the change' }), 'reviewer');
  follow.onChildEvent(childFrame('child-1', { type: 'agent.message.delta', attempt: 0, itemId: 'c1', text: 'child one looks' }), 'reviewer');
  follow.onChildEvent(childFrame('child-1', { type: 'agent.message.delta', attempt: 0, itemId: 'c2', text: 'child two checks' }), 'reviewer');
  now = 4000;
  follow.onChildStarted('tester', 'child-2', 0, SCRIPTED_MODEL, undefined);
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
    terminal.emit(named('down'));
    terminal.emit(named('up'));
    terminal.emit(named('up'));
    terminal.emit(named('down'));
    terminal.emit(named('down'));
    terminal.emit(named('enter'));
    await untilFrame(app, 'Subagent reviewer');
    terminal.emit(named('down'));
    terminal.emit(typed('x'));
    await untilFrame(app, '> x');
    expect(app.lastFrame()).toContain('Subagent reviewer');
    expect(app.lastFrame()).toContain('down on an empty input: choose a view');
    app.unmount();
  });

  it('keeps the chosen row on its subagent when a row above it leaves the list', async () => {
    const started = await running();
    const { app, terminal, follow } = started;
    terminal.emit(named('down'));
    terminal.emit(named('down'));
    terminal.emit(named('down'));
    follow.onChildEnded('reviewer', 'child-1', { kind: 'finished', run: runView({ id: 'child-1', status: 'COMPLETED' }) });
    await untilFrame(app, (shown) => !shown.includes('reviewer ·'));
    terminal.emit(named('enter'));
    await untilFrame(app, 'Subagent tester');
    app.unmount();
  });

  it('lists and opens a row in screen-reader mode as plain lines that do not tick', async () => {
    let now = 1000;
    const started = await start({}, { now: () => now, tuiSettings: { initial: { theme: 'auto', notify: 'off', screenReader: true, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true }, save: async () => undefined } }, { ...SIZE, screen: 'scrollback' });
    const { app, backend, terminal } = started;
    await untilFrame(app, (shown) => shown.includes('>'));
    await runStarted(backend, app, 'go');
    backend.following().onChildStarted('reviewer', 'child-1', 0, SCRIPTED_MODEL, undefined);
    backend.following().onChildEvent(childFrame('child-1', { type: 'agent.message.delta', attempt: 0, itemId: 'c1', text: 'child one looks' }), 'reviewer');
    await untilFrame(app, 'reviewer · starting');
    now = 9000;
    expect(app.lastFrame()).not.toMatch(/reviewer · starting · \d+s/);
    expect(linesOf(app.lastFrame())).toContain('main (shown)');
    terminal.emit(named('down'));
    await untilFrame(app, 'main (shown) (chosen)');
    terminal.emit(named('down'));
    terminal.emit(named('enter'));
    await untilFrame(app, 'reviewer · starting (shown)');
    await untilOutput(app, 'child one looks');
    app.unmount();
  });

  it('draws the list at 40x24 with the rows kept and the hint dropped when it does not fit', async () => {
    const { app } = await running({ columns: 40, rows: 24 });
    const lines = linesOf(app.lastFrame());
    expect(lines).toHaveLength(24);
    expect(lines.slice(21)).toEqual(['● main', '  reviewer · starting · 3s', '  tester · starting · 0s']);
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
    app.unmount();
  });

  it('shows an approval of a subagent with its name in the panel while the main view is shown', async () => {
    const { app, follow } = await running();
    follow.onChildEvent(childFrame('child-1', { type: 'tool.call', callId: 'k1', providerCallId: 'p-k1', name: 'Bash', kind: 'execute', title: 'Bash rm -r build', rawInput: {} }), 'reviewer');
    follow.onChildEvent(
      childFrame('child-1', { type: 'tool.permission.requested', approvalId: 'ap1', callId: 'k1', subjectDigest: 'd', reason: 'commands require approval', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'Bash rm -r build', input: {} } }),
      'reviewer',
    );
    const asked = await untilFrame(app, 'Allow once');
    expect(asked).toContain('reviewer: Bash rm -r build');
    expect(asked).toContain('main says hello');
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
    const facts = { subagents, shown: undefined, focus: undefined, keys, screenReader: false, columns: 100, now: 2000 };
    expect(agentListLines({ ...facts, rows: 4 }).map((line) => line.text)).toEqual(['● main', '  reviewer · Read a.ts · 2s', '  tester · waiting for approval · 2s', 'down on an empty input: choose a view · enter: open']);
    expect(agentListLines({ ...facts, rows: 3 }).map((line) => line.text)).toEqual(['● main', '  reviewer · Read a.ts · 2s', '  tester · waiting for approval · 2s']);
    expect(agentListLines({ ...facts, rows: 2 }).map((line) => line.text)).toEqual(['● main', 'and 2 more']);
  });

  it('names the shown row as plain text for a screen reader and states the keys of the list while it is chosen', () => {
    const lines = agentListLines({ subagents, shown: 'child-1', focus: 1, keys, screenReader: true, columns: 100, now: 0, rows: 4 }).map((line) => line.text);
    expect(lines).toEqual(['main', 'reviewer · Read a.ts (shown) (chosen)', 'tester · waiting for approval', 'up or down: move · enter: open · typing returns to the input']);
  });

  it('allocates the list rows and the hint at 100x40 and 40x24', () => {
    const base = { focus: undefined, keys, screenReader: false };
    expect(agentListRequest({ ...base, subagents, shown: undefined, columns: 100 })).toBe(4);
    expect(agentListRequest({ ...base, subagents, shown: undefined, columns: 40 })).toBe(3);
    expect(agentListRequest({ ...base, subagents: [], shown: 'child-1', columns: 100 })).toBe(1);
    expect(agentListRequest({ ...base, subagents: [], shown: undefined, columns: 100 })).toBe(0);
    const requests: RowRequests = { header: 0, waiting: 1, inputRows: 1, invitation: 0, menu: 0, subagents: agentListRequest({ ...base, subagents, shown: undefined, columns: 100 }), footerSecond: 1, lines: 0, panel: undefined };
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
  it('drops every kept conversation at /clear, and the events of a follow from before it reach no view of the new conversation', async () => {
    const started = await running();
    const { app, backend, follow } = started;
    backend.finish(runView());
    await untilFrame(app, (shown) => !shown.includes('esc to cancel'));
    app.stdin.write('/clear');
    await untilFrame(app, '> /clear');
    app.stdin.write(KEYS.enter);
    await backend.called('openSession');
    follow.onChildEvent(childFrame('child-1', { type: 'agent.message.delta', attempt: 0, itemId: 'c9', text: 'late child text' }), 'reviewer');
    follow.onChildEnded('reviewer', 'child-1', { kind: 'finished', run: runView({ id: 'child-1', status: 'COMPLETED' }) });
    await untilFrame(app, (shown) => !shown.includes('main says hello'));
    expect(app.lastFrame()).not.toContain('late child text');
    app.unmount();
  });


  const finished = (id: string) => ({ kind: 'finished', run: runView({ id, status: 'COMPLETED' }) }) as const;

  it('keeps one per running subagent and the one finished view being shown, and drops it when the view is left', () => {
    const views = createAgentViews();
    views.started('reviewer', 'child-1', 0, SCRIPTED_MODEL, undefined);
    views.started('tester', 'child-2', 0, SCRIPTED_MODEL, undefined);
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

describe('the parts of a subagent view (design cli-tui 3.3, 2.6)', () => {
  it('links a file a subagent names exactly as in the main conversation', async () => {
    const cwd = realpathSync(createTempDir());
    writeFileSync(path.join(cwd, 'gomoku.html'), '<html></html>');
    const started = await start({ session: { cwd }, fileLinksIn: { home: cwd } }, {}, SIZE);
    const { app, backend, terminal } = started;
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    const follow = backend.following();
    follow.onChildStarted('reviewer', 'child-1', 0, SCRIPTED_MODEL, undefined);
    follow.onChildEvent(childFrame('child-1', { type: 'agent.message.delta', attempt: 0, itemId: 'c1', text: 'Open `gomoku.html` now' }), 'reviewer');
    follow.onChildEvent(childFrame('child-1', { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }), 'reviewer');
    await untilFrame(app, 'reviewer · starting');
    terminal.emit(named('down'));
    terminal.emit(named('down'));
    terminal.emit(named('enter'));
    await untilFrame(app, `\u001b]8;;${pathToFileURL(path.join(cwd, 'gomoku.html')).href}\u0007gomoku.html\u001b]8;;\u0007`);
    app.unmount();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('holds a view whose backlog is still arriving, shows the loading row, and shows the whole conversation in one frame once it is reached', async () => {
    const { app, backend, terminal } = await start({}, {}, SIZE);
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    const follow = backend.following();
    follow.onChildStarted('reviewer', 'child-1', 3, SCRIPTED_MODEL, undefined);
    follow.onChildEvent(childFrame('child-1', { type: 'agent.message.delta', seq: 1, attempt: 0, itemId: 'c1', text: 'backlog one' }), 'reviewer');
    await untilFrame(app, 'reviewer · starting');
    terminal.emit(named('down'));
    terminal.emit(named('down'));
    terminal.emit(named('enter'));
    const loading = await untilFrame(app, 'loading the conversation 1 of 3 events');
    expect(linesOf(loading)[0]).toContain('Subagent reviewer');
    expect(loading).not.toContain('backlog one');
    const before = app.frames.length;
    follow.onChildEvent(childFrame('child-1', { type: 'agent.message.delta', seq: 2, attempt: 0, itemId: 'c2', text: 'backlog two' }), 'reviewer');
    follow.onChildEvent(childFrame('child-1', { type: 'agent.message.delta', seq: 3, attempt: 0, itemId: 'c3', text: 'backlog three' }), 'reviewer');
    await untilFrame(app, 'backlog three');
    const first = app.frames.slice(before).find((output) => output.includes('backlog one'));
    expect(first).toContain('backlog three');
    expect(app.lastFrame()).not.toContain('loading the conversation');
    app.unmount();
  });

  it('pins one header row naming the shown subagent and its state above a long conversation', async () => {
    const started = await running();
    const { app, follow } = started;
    for (let index = 0; index < 60; index += 1) follow.onChildEvent(childFrame('child-1', { type: 'notice', level: 'info', message: `child line ${index}` }), 'reviewer');
    await openWithKeys(started, 2);
    const shown = await untilFrame(app, 'child line 59');
    expect(linesOf(shown)[0]).toBe(`Subagent reviewer · running · model: ${SHOWN_MODEL}`);
    follow.onChildEvent(childFrame('child-1', { type: 'tool.call', callId: 'k1', providerCallId: 'p-k1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: {} }), 'reviewer');
    follow.onChildEvent(childFrame('child-1', { type: 'tool.permission.requested', approvalId: 'ap1', callId: 'k1', subjectDigest: 'd', reason: 'asks', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'Bash ls', input: {} } }), 'reviewer');
    await untilFrame(app, (now) => linesOf(now)[0] === `Subagent reviewer · waiting for approval · model: ${SHOWN_MODEL}`);
    follow.onChildEnded('reviewer', 'child-1', { kind: 'finished', run: runView({ id: 'child-1', status: 'CANCELLED' }) });
    await untilFrame(app, (now) => linesOf(now)[0] === `Subagent reviewer · CANCELLED · model: ${SHOWN_MODEL}`);
    app.unmount();
  });

  it('draws no header row while the main view is shown', async () => {
    const { app } = await running();
    expect(linesOf(app.lastFrame())[0]).not.toContain('Subagent');
    app.unmount();
  });

  it('scrolls the list with the chosen row so every subagent can be opened, with markers for the rows above and below', async () => {
    const { app, backend, terminal } = await start({}, {}, SIZE);
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    const follow = backend.following();
    for (let index = 1; index <= 7; index += 1) follow.onChildStarted(`agent${index}`, `child-${index}`, 0, SCRIPTED_MODEL, undefined);
    const idle = await untilFrame(app, 'and 4 more');
    expect(linesOf(idle).slice(35)).toEqual(['● main', '  agent1 · starting · 0s', '  agent2 · starting · 0s', '  agent3 · starting · 0s', 'and 4 more']);
    for (let index = 0; index < 8; index += 1) terminal.emit(named('down'));
    const scrolled = await untilFrame(app, 'agent7 ·');
    expect(linesOf(scrolled).slice(35)).toEqual(['↑ 4 more above', '  agent4 · starting · 0s', '  agent5 · starting · 0s', '  agent6 · starting · 0s', '  agent7 · starting · 0s']);
    for (let index = 0; index < 4; index += 1) terminal.emit(named('up'));
    const top = await untilFrame(app, '↓ 4 more below');
    expect(linesOf(top).slice(35)).toEqual(['● main', '  agent1 · starting · 0s', '  agent2 · starting · 0s', '  agent3 · starting · 0s', '↓ 4 more below']);
    for (let index = 0; index < 4; index += 1) terminal.emit(named('down'));
    terminal.emit(named('enter'));
    await untilFrame(app, 'Subagent agent7 · running');
    app.unmount();
  });
});
