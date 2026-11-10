import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { momongaPaths } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import type { CliPorts } from '../../src/ports.ts';
import { createTuiBackend } from '../../src/tui/backend.ts';
import { SWITCH_CHUNK_ROWS } from '../../src/tui/screen/constants.ts';
import { createScreenInput } from '../../src/tui/screen/input.ts';
import { JUMP_TO_BOTTOM } from '../../src/tui/screen/transcript-view.tsx';
import type { KeyName, TerminalEvent } from '../../src/tui/terminal/events.ts';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { runView } from '../fake-backend.ts';
import { frame, runStarted, start } from '../tui-harness.tsx';
import { manualClock } from './screen-clock.ts';

const plain = { ctrl: false, alt: false, shift: false };
const named = (name: KeyName, mods: Partial<typeof plain> = {}): TerminalEvent => ({ type: 'key', name, ...plain, ...mods });
const typed = (text: string, mods: Partial<typeof plain> = {}): TerminalEvent => ({ type: 'key', text, ...plain, ...mods });
const mouse = (kind: 'press' | 'release' | 'move', col: number, row: number): TerminalEvent => ({ type: 'mouse', kind, button: 'left', col, row, ...plain });
const wheel = (button: 'wheel-up' | 'wheel-down'): TerminalEvent => ({ type: 'mouse', kind: 'wheel', button, col: 1, row: 1, ...plain });

const linesOf = (text: string | undefined): string[] => (text ?? '').split('\n');

const IDLE = /^(?![\s\S]*esc to cancel)(?![\s\S]*enter: steer)[\s\S]*mode: manual/;

const numbered = (count: number, word = 'line'): string => Array.from({ length: count }, (_, index) => `${word} ${index}`).join('\n');

const startWith = async (size: { columns: number; rows: number; screen?: 'fullscreen' | 'scrollback' }, text: string, extra: Parameters<typeof start>[1] = {}) => {
  const started = await start({}, extra, size);
  await untilFrame(started.app, 'mode: manual');
  await runStarted(started.backend, started.app, 'go');
  started.backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text }));
  started.backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }));
  started.backend.finish(runView());
  await untilFrame(started.app, IDLE);
  return started;
};

describe('the layout of the full screen', () => {
  it('fills the terminal exactly: the transcript from the top, the input box above the one footer row', async () => {
    const { app } = await start({}, {}, { columns: 80, rows: 12 });
    const lines = linesOf(await untilFrame(app, 'mode: manual'));
    expect(lines).toHaveLength(12);
    expect(lines[8]).toMatch(/^╭─+╮$/);
    expect(lines[9]).toMatch(/^│ > +│$/);
    expect(lines[10]).toMatch(/^╰─+╯$/);
    expect(lines[11]).toBe(`mode: manual (shift+tab) · tokens: 0 · context: 0%${' '.repeat(80 - 50 - 16)}ctrl+j: new line`);
    app.unmount();
  });

  it('keeps the input where it is when the transcript grows past the viewport, and shows the end of the transcript', async () => {
    const { app } = await startWith({ columns: 60, rows: 12 }, numbered(40));
    const lines = linesOf(app.lastFrame());
    expect(lines).toHaveLength(12);
    expect(lines.slice(0, 8).map((line) => line.replace(/ *[│█]$/, ''))).toEqual(Array.from({ length: 8 }, (_, index) => `line ${32 + index}`));
    expect(lines[9]).toMatch(/^│ > +│$/);
    expect(lines[11]).toContain('mode: manual');
    app.unmount();
  });

  it('gives the transcript two rows at the smallest size', async () => {
    const { app } = await startWith({ columns: 20, rows: 6 }, numbered(9));
    const lines = linesOf(await untilFrame(app, (shown) => shown.startsWith('line 7')));
    expect(lines).toHaveLength(6);
    expect(lines.slice(0, 2).map((line) => line.replace(/ *[│█]$/, ''))).toEqual(['line 7', 'line 8']);
    expect(lines[3]).toMatch(/^│ > +│$/);
    expect(lines[5]?.startsWith('mode: manual')).toBe(true);
    app.unmount();
  });

  it('draws nothing of its own while the terminal layer reports the window too small, and keeps its state', async () => {
    const { app, terminal } = await startWith({ columns: 60, rows: 12 }, numbered(3));
    terminal.shrink(true);
    await untilFrame(app, (shown) => shown.trim() === '');
    terminal.shrink(false);
    expect(linesOf(await untilFrame(app, 'line 2'))).toHaveLength(12);
    app.unmount();
  });

  it('puts the waiting row above the input while a run works and takes it from the viewport', async () => {
    const clock = manualClock(5000);
    const { app, backend } = await start({}, { now: clock.now, timers: clock.timers }, { columns: 60, rows: 12 });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    const lines = linesOf(await untilFrame(app, 'esc to cancel'));
    expect(lines).toHaveLength(12);
    expect(lines[6]).toBe('⠋ waiting for the model 0s · esc to cancel');
    expect(lines[7]).toMatch(/^╭─+╮$/);
    expect(lines[10]).toContain('mode: manual');
    expect(lines[11]).toBe('enter: steer after the next tool call · tab: queue for afte…');
    app.unmount();
  });

  it('shows a prompt panel in the place of the input box and gives it the rows it needs', async () => {
    const { app, backend } = await start({}, {}, { columns: 80, rows: 16 });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: { command: 'ls' } }));
    backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'asks', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }] }));
    const lines = linesOf(await untilFrame(app, 'Permission requested: Bash ls'));
    expect(lines).toHaveLength(16);
    expect(lines.filter((line) => line.includes('│ >'))).toEqual([]);
    expect(lines.slice(9, 15).map((line) => line.replace(/^│ /, '').replace(/ *│$/, ''))).toEqual([expect.stringMatching(/^╭─+╮$/), 'Permission requested: Bash ls', 'asks', '› 1. Allow once', '1-9 or enter to choose · up/down to move · ctrl+c: cancel the run', expect.stringMatching(/^╰─+╯$/)]);
    expect(lines[15]).toContain('mode: manual');
    app.unmount();
  });

  it('lists the running subagents below the footer, one row each', async () => {
    let now = 1000;
    const { app, backend } = await start({}, { now: () => now }, { columns: 60, rows: 30 });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.following().onChildStarted('reviewer', 'child-1');
    now = 13_000;
    backend.following().onChildStarted('tester', 'child-2');
    const lines = linesOf(await untilFrame(app, 'tester · starting · 0s'));
    expect(lines).toHaveLength(30);
    expect(lines.slice(26)).toEqual([expect.stringContaining('mode: manual'), expect.stringContaining('enter: steer after the next tool call'), 'reviewer · starting · 12s', 'tester · starting · 0s']);
    backend.following().onChildEnded('reviewer', 'child-1');
    const after = linesOf(await untilFrame(app, (shown) => !shown.includes('reviewer')));
    expect(after.slice(27)).toEqual([expect.stringContaining('mode: manual'), expect.stringContaining('enter: steer after the next tool call'), 'tester · starting · 0s']);
    app.unmount();
  });

  it('shows a notice of the terminal layer as an entry of the transcript', async () => {
    const { app, terminal } = await start({}, {}, { columns: 80, rows: 12 });
    await untilFrame(app, 'mode: manual');
    terminal.request({ type: 'notice', text: 'The paste was larger than 1 MiB and was not inserted.' });
    expect(linesOf(await untilFrame(app, 'The paste was larger'))[0]).toBe('The paste was larger than 1 MiB and was not inserted.');
    app.unmount();
  });
});

describe('the viewport on the screen', () => {
  const top = (app: Awaited<ReturnType<typeof start>>['app']): string => (linesOf(app.lastFrame())[0] ?? '').replace(/ *[│█]$/, '');

  it('scrolls by half a viewport, by three rows a wheel notch, to the top and back to the end, and marks the way back', async () => {
    const { app, terminal } = await startWith({ columns: 60, rows: 12 }, numbered(40));
    expect(top(app)).toBe('line 32');
    expect(terminal.emit(named('pageup'))).toBe(true);
    await untilFrame(app, 'line 28');
    expect(top(app)).toBe('line 28');
    expect(linesOf(app.lastFrame())[7]).toContain(JUMP_TO_BOTTOM);
    terminal.emit(wheel('wheel-up'));
    await untilFrame(app, 'line 25');
    expect(top(app)).toBe('line 25');
    terminal.emit(wheel('wheel-down'));
    await untilFrame(app, (shown) => !shown.includes('line 25'));
    expect(top(app)).toBe('line 28');
    terminal.emit(named('home', { ctrl: true }));
    await untilFrame(app, '> go');
    expect(top(app)).toBe('> go');
    terminal.emit(named('pagedown'));
    await untilFrame(app, (shown) => !shown.includes('> go'));
    expect(top(app)).toBe('line 3');
    expect(terminal.emit(named('end'))).toBe(true);
    await untilFrame(app, 'line 39');
    expect(app.lastFrame()).not.toContain(JUMP_TO_BOTTOM);
    terminal.emit(named('end'));
    expect(app.lastFrame()).toContain('line 39');
    app.unmount();
  });

  it('stays where it was scrolled to while the transcript grows, and follows the end again after the jump marker is clicked', async () => {
    const { app, terminal, backend } = await startWith({ columns: 60, rows: 12 }, numbered(40));
    terminal.emit(named('pageup'));
    await untilFrame(app, 'line 28');
    await runStarted(backend, app, 'more');
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm2', text: 'fresh answer' }));
    await backend.called('openSession');
    await untilFrame(app, 'esc to cancel');
    expect((linesOf(app.lastFrame())[0] ?? '').startsWith('line 28')).toBe(true);
    expect(app.lastFrame()).not.toContain('fresh answer');
    const marker = linesOf(app.lastFrame()).findIndex((line) => line.includes(JUMP_TO_BOTTOM));
    terminal.emit(mouse('press', 3, marker + 1));
    await untilFrame(app, 'fresh answer');
    app.unmount();
  });

  it('leaves the viewport keys to the editor while the input holds text, except the Ctrl chords', async () => {
    const { app, terminal } = await startWith({ columns: 60, rows: 12 }, numbered(40));
    app.stdin.write('draft');
    await untilFrame(app, '> draft');
    terminal.emit(named('pageup'));
    terminal.emit(named('home'));
    app.stdin.write('X');
    const edited = await untilFrame(app, '> Xdraft');
    expect(edited).not.toContain('> go');
    terminal.emit(named('end'));
    app.stdin.write('Y');
    await untilFrame(app, '> XdraftY');
    terminal.emit(named('home', { ctrl: true }));
    await untilFrame(app, '> go');
    app.unmount();
  });

  it('rewraps at the new width after a resize, keeps the entry at the top and no row wider than the terminal', async () => {
    const paragraph = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ');
    const { app, terminal } = await startWith({ columns: 60, rows: 12 }, `${paragraph}\n${numbered(30)}`);
    terminal.emit(named('home', { ctrl: true }));
    await untilFrame(app, '> go');
    terminal.emit(wheel('wheel-down'));
    await untilFrame(app, (shown) => !shown.includes('> go'));
    terminal.resize(30, 12);
    const narrow = linesOf(await untilFrame(app, (shown) => linesOf(shown).every((line) => line.length <= 30) && shown.includes('word')));
    expect(narrow).toHaveLength(12);
    expect(narrow[0]).toContain('word');
    terminal.resize(96, 12);
    const wide = linesOf(await untilFrame(app, (shown) => linesOf(shown).some((line) => line.length > 60) && shown.includes('word29')));
    expect(wide[0]).toContain('word29');
    expect(wide[1]?.startsWith('line 0')).toBe(true);
    app.unmount();
  });
});

describe('selection and copy on the screen', () => {
  it('copies the dragged text on release, says so in the footer until the next key, and clears the selection on Esc', async () => {
    const { app, terminal, backend } = await startWith({ columns: 80, rows: 12 }, 'alpha beta gamma\ndelta');
    terminal.emit(mouse('press', 7, 2));
    terminal.emit(mouse('move', 5, 3));
    terminal.emit(mouse('release', 5, 3));
    await backend.called('copy:beta gamma\ndelta');
    const copied = await untilFrame(app, 'Copied 16 characters');
    expect(linesOf(copied)[11]).toMatch(/^mode: manual \(shift\+tab\) · tokens: 0 · context: 0% +Copied 16 characters$/);
    expect(terminal.emit(named('escape'))).toBe(true);
    await untilFrame(app, 'ctrl+j: new line');
    terminal.emit(named('escape'));
    expect(backend.calls.filter((call) => call.startsWith('cancel:'))).toEqual([]);
    app.unmount();
  });

  it('selects the word under a double click and the line under a triple click', async () => {
    let now = 0;
    const { terminal, backend, app } = await startWith({ columns: 60, rows: 12 }, 'alpha beta gamma', { now: () => now });
    for (const kind of ['press', 'release', 'press', 'release'] as const) terminal.emit(mouse(kind, 8, 2));
    await backend.called('copy:beta');
    now += 100;
    terminal.emit(mouse('press', 8, 2));
    terminal.emit(mouse('release', 8, 2));
    await backend.called('copy:alpha beta gamma');
    app.unmount();
  });

  it('keeps the highlight and copies on Ctrl+Shift+C when copying on selection is turned off', async () => {
    const { app, terminal, backend } = await startWith({ columns: 80, rows: 12 }, 'alpha beta gamma', { copyOnSelect: false });
    terminal.emit(mouse('press', 1, 2));
    terminal.emit(mouse('move', 5, 2));
    terminal.emit(mouse('release', 5, 2));
    expect(backend.calls.filter((call) => call.startsWith('copy:'))).toEqual([]);
    expect(terminal.emit(typed('c', { ctrl: true, shift: true }))).toBe(true);
    await backend.called('copy:alpha');
    await untilFrame(app, 'Copied 5 characters');
    app.unmount();
  });

  it('opens a link on a click without movement and writes it as an OSC 8 link around its text', async () => {
    const { app, terminal, backend } = await startWith({ columns: 60, rows: 12 }, 'see https://example.test/page now');
    expect(app.lastFrame()).toContain('\u001b]8;;https://example.test/page\u0007https://example.test/page\u001b]8;;\u0007');
    terminal.emit(mouse('press', 8, 2));
    terminal.emit(mouse('release', 8, 2));
    await vi.waitFor(() => expect(backend.openedUrls).toEqual(['https://example.test/page']));
    expect(backend.calls.filter((call) => call.startsWith('copy:'))).toEqual([]);
    app.unmount();
  });
});

describe('the two screen modes', () => {
  const countOf = (text: string, word: string): number => text.split(word).length - 1;

  it('/tui names the mode, and a name it does not know changes nothing', async () => {
    const { app, terminal } = await start({}, {}, { columns: 80, rows: 12 });
    await untilFrame(app, 'mode: manual');
    app.stdin.write('/tui');
    await untilFrame(app, '> /tui');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'screen: fullscreen');
    app.stdin.write('/tui inline');
    await untilFrame(app, '> /tui inline');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'unknown screen mode inline; available: fullscreen, scrollback');
    expect(terminal.screens).toEqual([]);
    app.unmount();
  });

  it('writes the whole conversation to the terminal in chunks of at most 200 rows when it switches to scrollback, and comes back', async () => {
    const { app, terminal } = await startWith({ columns: 60, rows: 12 }, numbered(450, 'row'));
    const before = app.frames.length;
    app.stdin.write('/tui scrollback');
    await untilFrame(app, '> /tui scrollback');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, (shown) => shown.includes('row 449') && shown.includes('row 0\n') && shown.includes('screen: scrollback'));
    expect(terminal.screens).toEqual(['scrollback']);
    const written = app.frames.slice(before).map((shown) => countOf(shown, 'row '));
    const steps = written.map((count, index) => count - (written[index - 1] ?? 0)).filter((step) => step > 0);
    expect(Math.max(...steps)).toBeLessThanOrEqual(SWITCH_CHUNK_ROWS);
    expect(steps.length).toBeGreaterThanOrEqual(Math.ceil(450 / SWITCH_CHUNK_ROWS));
    const last = app.lastFrame() ?? '';
    expect(countOf(last, 'row ')).toBe(450);
    expect(last.indexOf('row 10\n')).toBeLessThan(last.indexOf('row 400\n'));
    expect(linesOf(last).at(-1)).toContain('mode: manual');
    app.stdin.write('/tui fullscreen');
    await untilFrame(app, '> /tui fullscreen');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'screen: fullscreen');
    expect(terminal.screens).toEqual(['scrollback', 'fullscreen']);
    app.unmount();
  });

  it('in scrollback mode writes each settled entry once and keeps the open one in the live region', async () => {
    const { app, backend } = await start({}, {}, { columns: 60, rows: 12, screen: 'scrollback' });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'streaming' }));
    await untilFrame(app, 'streaming');
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: ' answer' }));
    await untilFrame(app, 'streaming answer');
    backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }));
    backend.finish(runView());
    const idle = await untilFrame(app, IDLE);
    expect(countOf(idle, '> go')).toBe(1);
    await untilFrame(app, (shown) => countOf(shown, 'streaming answer') === 1 && countOf(shown, 'streaming') === 1);
    expect(linesOf(app.lastFrame()).at(-1)).toContain('mode: manual');
    app.unmount();
  });

  it('follows a switch the terminal layer makes itself', async () => {
    const { app, terminal } = await startWith({ columns: 60, rows: 12 }, numbered(30));
    expect(linesOf(app.lastFrame())).toHaveLength(12);
    terminal.setScreen('scrollback');
    await untilFrame(app, (shown) => shown.includes('line 0\n') && shown.includes('line 29'));
    app.unmount();
  });
});

describe('the event path of the screen', () => {
  it('hands an event to the newest claim first and drops what nobody claims', () => {
    const input = createScreenInput();
    const seen: string[] = [];
    input.claim((event) => (seen.push('first'), event.type === 'mouse'));
    const stop = input.claim((event) => (seen.push('second'), event.type === 'key' && 'name' in event && event.name === 'pageup'));
    input.push([named('pageup'), typed('a'), mouse('press', 1, 1), typed('b')]);
    expect(seen).toEqual(['second', 'second', 'first', 'second', 'first', 'second', 'first']);
    stop();
    input.push([named('pageup')]);
    expect(seen.at(-1)).toBe('first');
    expect(seen).toHaveLength(8);
  });
});

describe('the clipboard of the TUI backend', () => {
  it('pipes the text to the clipboard program the host has and writes nothing to the terminal', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'momonga-clipboard-'));
    try {
      const program = path.join(directory, 'pbcopy');
      writeFileSync(program, '');
      chmodSync(program, 0o755);
      const written: string[] = [];
      const piped: { file: string; args: readonly string[]; payload: string }[] = [];
      const capture = { write: (chunk: string | Uint8Array) => (written.push(String(chunk)), true) };
      const ports = { version: '1', env: { PATH: directory }, home: '/home/alice', cwd: '/home/alice', clock: { now: () => 0, sleep: async () => undefined }, stdout: capture, stderr: capture, terminal: { stdin: process.stdin, stdout: capture } } as unknown as CliPorts;
      const backend = createTuiBackend(ports, momongaPaths('/home/alice'), {}, { load: async () => [], append: async () => undefined }, [], {
        pipe: async (file, args, payload) => void piped.push({ file, args, payload }),
        capture: async () => undefined,
        stop: () => undefined,
      });
      expect(await backend.copyToClipboard('héllo')).toEqual({ kind: 'copied', characters: 5 });
      expect(piped).toEqual([{ file: program, args: [], payload: 'héllo' }]);
      expect(written).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
