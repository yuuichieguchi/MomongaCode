import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import type { ResolvedTuiSettings } from '@momonga/config';
import { App } from '../../src/tui/app.tsx';
import type { AppProps } from '../../src/tui/app.tsx';
import type { AskedA11y } from '../../src/tui/screen/a11y.ts';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import type { ScreenTimers } from '../../src/tui/screen/timers.ts';
import { SPINNER_FRAMES, SPINNER_MS } from '../../src/tui/screen/waiting-row.tsx';
import { fakeBackend } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, renderObservable, untilFrame, untilOutput } from '../ink-helpers.ts';
import { frame } from '../tui-harness.tsx';
import { fakeScreenTerminal } from './screen-fakes.ts';

const GLYPHS = new RegExp(`[${SPINNER_FRAMES.join('')}]`);
const BOX = /[│─╭╮╰╯]/;

type Saved = { name: string; value: unknown };

const startWith = async (given: { settings?: Partial<ResolvedTuiSettings>; asked?: AskedA11y; backend?: FakeBackendOptions; screen?: Parameters<typeof fakeScreenTerminal>[0]; extra?: Partial<AppProps> } = {}) => {
  const backend = fakeBackend(given.backend ?? {});
  const terminal = fakeScreenTerminal(given.screen ?? { screen: 'scrollback', columns: 80, rows: 30 });
  const saved: Saved[] = [];
  const tuiSettings: TuiSettingsPort = {
    initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, ...given.settings },
    save: async (name, value) => {
      saved.push({ name, value });
    },
  };
  const delays: number[] = [];
  const timers: ScreenTimers = {
    setTimeout: (run, ms) => {
      delays.push(ms);
      return systemTiming.setTimeout(run, ms);
    },
    clearTimeout: (handle) => systemTiming.clearTimeout(handle),
  };
  const app = renderObservable(<App backend={backend} terminal={terminal} initialMode={undefined} now={Date.now} timers={timers} tuiSettings={tuiSettings} {...(given.asked === undefined ? {} : { a11y: given.asked })} {...given.extra} onExit={() => undefined} />);
  return { backend, terminal, app, saved, delays };
};

type Started = Awaited<ReturnType<typeof startWith>>;

const command = async ({ app }: Started, line: string): Promise<void> => {
  app.stdin.write(line);
  await untilFrame(app, `> ${line}`);
  app.stdin.write(KEYS.enter);
};

const running = async (started: Started): Promise<void> => {
  await command(started, 'go');
  await started.backend.called('openSession');
  await untilOutput(started.app, '> go');
};

const allLines = ({ app }: Started): string[] => app.frames.flatMap((shown) => shown.split('\n').map((line) => line.trimEnd()));

const count = (started: Started, line: string): number => (started.app.lastFrame() ?? '').split('\n').filter((shown) => shown.trimEnd() === line).length;

const READER = { settings: { screenReader: true } };

describe('the screen-reader display', () => {
  it('keeps the terminal\'s own history whatever the screen was, and refuses the full screen', async () => {
    const started = await startWith({ ...READER, screen: { screen: 'fullscreen', columns: 80, rows: 30 } });
    await untilOutput(started.app, 'screen: scrollback');
    expect(started.terminal.screens).toEqual(['scrollback']);
    await command(started, '/tui fullscreen');
    await untilOutput(started.app, "Screen-reader mode keeps the terminal's own history.");
    expect(started.terminal.screens).toEqual(['scrollback']);
    started.app.unmount();
  });

  it('prints a wait as one plain line when the phase changes, with no spinner, no seconds and no waiting row', async () => {
    const started = await startWith(READER);
    await untilOutput(started.app, 'mode: manual · tokens: 0 · context:');
    await running(started);
    started.backend.emit(frame({ type: 'model.requested', attempt: 0, digest: 'd' }));
    await untilFrame(started.app, 'waiting for the model');
    started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash: npm test', rawInput: {} }));
    await untilFrame(started.app, 'running Bash: npm test');
    expect(count(started, 'waiting for the model')).toBe(1);
    expect(count(started, 'running Bash: npm test')).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 2 * SPINNER_MS));
    const lines = allLines(started);
    expect(lines.filter((line) => GLYPHS.test(line))).toEqual([]);
    expect(lines.filter((line) => /to cancel/.test(line))).toEqual([]);
    expect(lines.filter((line) => /waiting for the model \d+s/.test(line))).toEqual([]);
    expect(started.delays).not.toContain(SPINNER_MS);
    started.app.unmount();
  });

  it('prints a tool once when it ends, with the last 5 lines of its output, and nothing while it runs', async () => {
    const started = await startWith(READER);
    await untilOutput(started.app, 'mode: manual · tokens: 0');
    await running(started);
    started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash: seq', rawInput: {} }));
    started.backend.emit(frame({ type: 'tool.started', callId: 'c1', idemKey: 'k' }));
    await untilFrame(started.app, 'running Bash: seq');
    expect(allLines(started).filter((line) => /Bash: seq · \d+s/.test(line))).toEqual([]);
    started.backend.emit(frame({ type: 'tool.completed', callId: 'c1', status: 'completed', output: Array.from({ length: 7 }, (_, index) => `out ${index}`).join('\n') }));
    const shown = (await untilFrame(started.app, 'out 6')).split('\n').map((line) => line.trimEnd());
    const at = shown.indexOf('✓ Bash: seq');
    expect(shown.slice(at, at + 7)).toEqual(['✓ Bash: seq', '  … +2 lines (ctrl+o to expand)', '  out 2', '  out 3', '  out 4', '  out 5', '  out 6']);
    expect(shown.filter((line) => line === '✓ Bash: seq')).toHaveLength(1);
    started.app.unmount();
  });

  it('prints a thought as one line when it has ended, and nothing while it streams', async () => {
    const started = await startWith(READER);
    await untilOutput(started.app, 'mode: manual · tokens: 0');
    await running(started);
    started.backend.emit(frame({ type: 'agent.thought.delta', attempt: 0, itemId: 't1', text: 'first idea', createdAt: 20_000 }));
    await untilFrame(started.app, 'thinking');
    expect(allLines(started)).not.toContain('Thinking');
    expect(allLines(started).filter((line) => line.includes('first idea'))).toEqual([]);
    started.backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'the answer', createdAt: 32_000 }));
    const shown = await untilFrame(started.app, 'Thought for 12s');
    expect(shown).toContain('the answer');
    expect(shown).not.toContain('first idea');
    started.app.unmount();
  });

  it('prints the diff of an applied change with its signs', async () => {
    const started = await startWith(READER);
    await untilOutput(started.app, 'mode: manual · tokens: 0');
    await running(started);
    started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Edit', kind: 'edit', title: 'Edit src/a.ts', rawInput: { file_path: 'src/a.ts', old_string: 'line10', new_string: 'changed10' } }));
    started.backend.emit(frame({ type: 'tool.completed', callId: 'c1', status: 'completed', output: 'Updated', hunks: [{ oldStart: 9, newStart: 9, lines: [' line9', '-line10', '+changed10'] }], added: 1, removed: 1 }));
    const shown = (await untilFrame(started.app, '+changed10')).split('\n').map((line) => line.trimEnd());
    const at = shown.indexOf('✓ Edit src/a.ts');
    expect(shown.slice(at, at + 5)).toEqual(['✓ Edit src/a.ts', '• Edited src/a.ts (+1 -1)', '   9  line9', '  10 -line10', '  10 +changed10']);
    started.app.unmount();
  });

  it('shows a prompt as numbered lines with the selected one named, no marker and no box', async () => {
    const started = await startWith({ ...READER, backend: { trust: { path: '/work/project', decision: null } }, screen: { screen: 'scrollback', columns: 100, rows: 30 } });
    const frameLines = (await untilFrame(started.app, 'Do you trust the files in /work/project?')).split('\n').map((line) => line.trimEnd());
    const shown = frameLines.slice(frameLines.indexOf('Do you trust the files in /work/project?'));
    expect(shown).toEqual([
      'Do you trust the files in /work/project?',
      'Project settings and MCP servers in this folder are only loaded when you trust it.',
      'selected: Yes, I trust this folder',
      '1. Yes, I trust this folder',
      '2. No, continue without its project settings',
      'up/down to move · enter to choose · esc: No, continue without its project settings',
    ]);
    started.app.stdin.write(KEYS.down);
    const moved = await untilFrame(started.app, 'selected: No, continue without its project settings');
    expect(moved).not.toContain('›');
    expect(BOX.test(moved)).toBe(false);
    started.app.stdin.write(KEYS.enter);
    await started.backend.called('trust:untrusted');
    started.app.unmount();
  });

  it('shows a tool approval the same way', async () => {
    const started = await startWith(READER);
    await untilOutput(started.app, 'mode: manual · tokens: 0');
    await running(started);
    started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'Bash c1', rawInput: { command: 'ls' } }));
    started.backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'asks', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }, { optionId: 'o3', name: 'Reject once', kind: 'reject_once' }] }));
    const shown = (await untilFrame(started.app, 'Permission requested: Bash c1')).split('\n').map((line) => line.trimEnd());
    const at = shown.indexOf('Permission requested: Bash c1');
    expect(shown.slice(at, at + 6)).toEqual(['Permission requested: Bash c1', 'asks', 'selected: Allow once', '1. Allow once', '2. Reject once', '1-9 or enter to choose · up/down to move · esc: Reject once · ctrl+c: cancel the run']);
    started.app.unmount();
  });

  it('has no live footer and no box round the input: the status is printed when the mode changes and by /help', async () => {
    const started = await startWith(READER);
    await untilOutput(started.app, 'mode: manual · tokens: 0 · context:');
    const idle = started.app.lastFrame() ?? '';
    expect(idle).not.toContain('(shift+tab)');
    expect(idle).not.toContain('new line');
    expect(BOX.test(idle)).toBe(false);
    started.app.stdin.write('abc');
    const typed = (await untilFrame(started.app, '> abc')).split('\n').map((line) => line.trimEnd());
    expect(typed).toContain('> abc');
    for (let erased = 0; erased < 3; erased += 1) started.app.stdin.write(KEYS.backspace);
    started.app.stdin.write(KEYS.shiftTab);
    await untilOutput(started.app, /mode: (?!manual)\w+ · tokens: 0 · context:/);
    await command(started, '/help');
    const help = await untilOutput(started.app, 'Status');
    expect(help).toMatch(/Status\n {2}mode: \w+\n {2}tokens: 0\n {2}context: /);
    started.app.unmount();
  });

  it('prints a hint of the footer as a line', async () => {
    const started = await startWith(READER);
    await untilOutput(started.app, 'mode: manual · tokens: 0');
    started.app.stdin.write(KEYS.ctrlC);
    await untilOutput(started.app, 'Press ctrl+c again to exit');
    started.app.unmount();
  });
});

describe('reduced motion on the screen', () => {
  const waitingRow = async (given: Parameters<typeof startWith>[0]) => {
    const started = await startWith(given);
    await untilFrame(started.app, 'mode: manual');
    await running(started);
    started.backend.emit(frame({ type: 'model.requested', attempt: 0, digest: 'd' }));
    return started;
  };

  it('draws the static mark in the waiting row and never starts the 100 ms timer', async () => {
    const started = await waitingRow({ settings: { reducedMotion: true } });
    const shown = await untilFrame(started.app, '• waiting for the model');
    expect(shown).toMatch(/• waiting for the model \d+s · esc to cancel/);
    await new Promise((resolve) => setTimeout(resolve, 2 * SPINNER_MS));
    expect(allLines(started).filter((line) => GLYPHS.test(line))).toEqual([]);
    expect(started.delays).not.toContain(SPINNER_MS);
    started.app.unmount();
  });

  it('is asked for by NO_MOTION=1 in the environment', async () => {
    const started = await waitingRow({ asked: { screenReaderFlag: false, env: { NO_MOTION: '1' } } });
    await untilFrame(started.app, '• waiting for the model');
    expect(started.delays).not.toContain(SPINNER_MS);
    started.app.unmount();
  });

  it('is off by default: the spinner runs on its 100 ms timer', async () => {
    const started = await waitingRow({});
    const shown = await untilFrame(started.app, 'waiting for the model');
    expect(GLYPHS.test(shown)).toBe(true);
    expect(started.delays).toContain(SPINNER_MS);
    started.app.unmount();
  });
});

describe('the two switches from inside the TUI', () => {
  it('/config reduced-motion stores the value and applies it at once', async () => {
    const started = await startWith({});
    await untilFrame(started.app, 'mode: manual');
    await command(started, '/config reduced-motion');
    await untilOutput(started.app, 'reduced-motion: off');
    await command(started, '/config reduced-motion on');
    await untilOutput(started.app, 'reduced-motion: on');
    expect(started.saved).toEqual([{ name: 'reducedMotion', value: true }]);
    await running(started);
    started.backend.emit(frame({ type: 'model.requested', attempt: 0, digest: 'd' }));
    await untilFrame(started.app, '• waiting for the model');
    started.app.unmount();
  });

  it('/config screen-reader stores the value, leaves the full screen and draws the plain display at once', async () => {
    const started = await startWith({ screen: { screen: 'fullscreen', columns: 80, rows: 30 } });
    await untilFrame(started.app, 'mode: manual (shift+tab)');
    await command(started, '/config screen-reader on');
    await untilOutput(started.app, 'screen-reader: on');
    expect(started.saved).toEqual([{ name: 'screenReader', value: true }]);
    await untilOutput(started.app, 'screen: scrollback');
    expect(started.terminal.screens).toEqual(['scrollback']);
    const plain = await untilFrame(started.app, (shown) => !shown.includes('(shift+tab)') && !BOX.test(shown));
    expect(plain).not.toContain('›');
    await command(started, '/config screen-reader off');
    await untilOutput(started.app, 'screen-reader: off');
    expect(started.saved).toEqual([{ name: 'screenReader', value: true }, { name: 'screenReader', value: false }]);
    await untilFrame(started.app, 'mode: manual (shift+tab)');
    started.app.unmount();
  });

  it('says when a switch is on for this session by the flag or the environment while its setting is off', async () => {
    const started = await startWith({ asked: { screenReaderFlag: true, env: {} } });
    await untilOutput(started.app, 'mode: manual · tokens: 0');
    await command(started, '/config screen-reader');
    await untilOutput(started.app, 'screen-reader: off (on in this session)');
    await command(started, '/config reduced-motion');
    await untilOutput(started.app, 'reduced-motion: off (on in this session)');
    started.app.unmount();
  });

  it('refuses a value that is neither on nor off and names every row in the usage', async () => {
    const started = await startWith({});
    await untilFrame(started.app, 'mode: manual');
    await command(started, '/config screen-reader maybe');
    await untilOutput(started.app, 'unknown screen-reader value maybe; available: on, off');
    await command(started, '/config');
    await untilOutput(started.app, 'usage: /config notify [off|bell]\n/config screen-reader [on|off]\n/config reduced-motion [on|off]');
    expect(started.saved).toEqual([]);
    started.app.unmount();
  });
});
