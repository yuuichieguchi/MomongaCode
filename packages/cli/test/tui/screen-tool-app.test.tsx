import { describe, expect, it } from 'vitest';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { frame, runStarted, start } from '../tui-harness.tsx';
import { manualClock } from './screen-clock.ts';

const CTRL_O = '\u000f';
const TAB = '\t';
const PAGE_DOWN = '\u001b[6~';

const numbered = (count: number, word = 'out'): string => Array.from({ length: count }, (_, index) => `${word} ${index}`).join('\n');

const linesOf = (text: string | undefined): string[] => (text ?? '').split('\n').map((line) => line.replace(/ *[│█]?$/, ''));

const bash = (callId: string, title: string) => frame({ type: 'tool.call', callId, providerCallId: `p-${callId}`, name: 'Bash', kind: 'execute', title, rawInput: {} });
const done = (callId: string, output: string) => frame({ type: 'tool.completed', callId, status: 'completed', output });

const startRun = async (size: { columns: number; rows: number; screen?: 'fullscreen' | 'scrollback' }, extra: Parameters<typeof start>[1] = {}) => {
  const started = await start({}, extra, size);
  await untilFrame(started.app, 'mode: manual');
  await runStarted(started.backend, started.app, 'go');
  return started;
};

describe('tool output on the screen', () => {
  it('shows the last 5 lines under the tool line and opens all of it with ctrl+o, scrolls, and returns with esc', async () => {
    const { app, backend } = await startRun({ columns: 60, rows: 16 });
    backend.emit(bash('c1', 'Bash seq'));
    backend.emit(done('c1', numbered(30)));
    const shown = linesOf(await untilFrame(app, 'out 29'));
    expect(shown.filter((line) => line.startsWith('  '))).toEqual(['  … +25 lines (ctrl+o to expand)', '  out 25', '  out 26', '  out 27', '  out 28', '  out 29']);
    app.stdin.write(CTRL_O);
    const viewer = linesOf(await untilFrame(app, 'esc to return'));
    const height = viewer.indexOf('up/down to scroll · esc to return');
    expect(viewer.slice(0, height)).toEqual(Array.from({ length: height }, (_, index) => `out ${index}`));
    app.stdin.write(KEYS.down);
    expect(linesOf(await untilFrame(app, /^out 1 *\n/))[0]).toBe('out 1');
    app.stdin.write(PAGE_DOWN);
    expect(linesOf(await untilFrame(app, new RegExp(`^out ${1 + height} *\\n`)))[0]).toBe(`out ${1 + height}`);
    app.stdin.write(KEYS.escape);
    const back = await untilFrame(app, '✓ Bash seq');
    expect(back).not.toContain('esc to return');
    expect(backend.calls.filter((name) => name.toLowerCase().includes('cancel'))).toEqual([]);
    app.unmount();
  });

  it('opens the newest tool that hides lines and moves to older and newer outputs with tab and shift+tab', async () => {
    const { app, backend } = await startRun({ columns: 60, rows: 30 });
    backend.emit(bash('c1', 'Bash first'));
    backend.emit(done('c1', numbered(9, 'first')));
    backend.emit(bash('c2', 'Bash second'));
    backend.emit(done('c2', numbered(8, 'second')));
    backend.emit(bash('c3', 'Bash short'));
    backend.emit(done('c3', 'short only'));
    await untilFrame(app, 'short only');
    app.stdin.write(CTRL_O);
    expect(linesOf(await untilFrame(app, 'esc to return'))[0]).toBe('second 0');
    app.stdin.write(TAB);
    expect(linesOf(await untilFrame(app, (text) => text.startsWith('first 0')))[0]).toBe('first 0');
    app.stdin.write(KEYS.shiftTab);
    await untilFrame(app, (text) => text.startsWith('second 0'));
    app.stdin.write(KEYS.shiftTab);
    expect(linesOf(await untilFrame(app, (text) => text.startsWith('short only')))[0]).toBe('short only');
    app.unmount();
  });

  it('does nothing on ctrl+o when no tool hides lines', async () => {
    const { app, backend } = await startRun({ columns: 60, rows: 16 });
    backend.emit(bash('c1', 'Bash short'));
    backend.emit(done('c1', 'one line'));
    await untilFrame(app, 'one line');
    app.stdin.write(CTRL_O);
    app.stdin.write('x');
    const typed = await untilFrame(app, '> x');
    expect(typed).not.toContain('esc to return');
    app.unmount();
  });

  it('shows the viewer in the live region of the scrollback screen', async () => {
    const { app, backend } = await startRun({ columns: 60, rows: 16, screen: 'scrollback' });
    backend.emit(bash('c1', 'Bash seq'));
    backend.emit(done('c1', numbered(30)));
    await untilFrame(app, 'out 29');
    app.stdin.write(CTRL_O);
    const viewer = await untilFrame(app, 'esc to return');
    expect(viewer).toContain('out 0\nout 1\n');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (text) => !text.includes('esc to return'));
    app.unmount();
  });

  it('counts the seconds of a running tool on its line by the injected clock', async () => {
    const clock = manualClock(1000);
    const { app, backend } = await startRun({ columns: 60, rows: 16 }, { now: clock.now, timers: clock.timers });
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash sleep', rawInput: {}, createdAt: 1000 }));
    backend.emit(frame({ type: 'tool.started', callId: 'c1', idemKey: 'k', createdAt: 1000 }));
    await untilFrame(app, '⠋ Bash sleep · 0s');
    clock.advance(3000);
    await untilFrame(app, '⠸ Bash sleep · 3s');
    backend.emit(frame({ type: 'tool.completed', callId: 'c1', status: 'completed', output: 'woke', createdAt: 4000 }));
    const ended = await untilFrame(app, '✓ Bash sleep');
    expect(ended).toContain('  woke');
    app.unmount();
  });

  it('shows the diff of an edit that needed no approval, in place', async () => {
    const { app, backend } = await startRun({ columns: 60, rows: 20 });
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Edit', kind: 'edit', title: 'Edit a.ts', rawInput: { file_path: 'a.ts', old_string: 'b', new_string: 'B' } }));
    backend.emit(frame({ type: 'tool.completed', callId: 'c1', status: 'completed', output: 'The file a.ts has been updated.', hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B', ' c'] }], added: 1, removed: 1 }));
    const lines = linesOf(await untilFrame(app, '• Edited a.ts (+1 -1)'));
    const at = lines.indexOf('✓ Edit a.ts');
    expect(lines.slice(at, at + 6)).toEqual(['✓ Edit a.ts', '• Edited a.ts (+1 -1)', '  1  a', '  2 -b', '  2 +B', '  3  c']);
    app.unmount();
  });
});
