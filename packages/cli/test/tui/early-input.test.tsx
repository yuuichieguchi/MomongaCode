import { describe, expect, it, vi } from 'vitest';
import type { ResolvedTuiSettings } from '@momonga/config';
import { systemTiming } from '@momonga/foundation';
import { App } from '../../src/tui/app.tsx';
import { emptyEditor } from '../../src/tui/editor.ts';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { applyEarlyInput, createEarlyInput } from '../../src/tui/screen/early-input.ts';
import type { EarlyInput } from '../../src/tui/screen/early-input.ts';
import { CLAIM_PRIORITY } from '../../src/tui/screen/input.ts';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import { fakeBackend } from '../fake-backend.ts';
import { PLAN_TEST_TIMEOUT_MS } from '../fake-plan-gateway.tsx';
import { renderObservable, settleAtOnce, untilFrame } from '../ink-helpers.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const plain = { ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };
const textKey = (text: string): TerminalEvent => ({ type: 'key', text, ...plain });
const namedKey = (name: 'enter' | 'escape' | 'tab' | 'backspace' | 'up'): TerminalEvent => ({ type: 'key', name, ...plain });
const mouseClick: TerminalEvent = { type: 'mouse', kind: 'press', button: 'left', row: 2, col: 4, ...plain };

const settings = (): TuiSettingsPort => ({
  initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: true, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true } satisfies ResolvedTuiSettings,
  save: async () => undefined,
});

describe('early input collector before App takes input', () => {
  it('places early as the last claim priority', () => {
    expect(CLAIM_PRIORITY.at(-1)).toBe('early');
  });

  it('collects typed text (including shell trigger) and pastes in order while dropping non-text keys and mouse events', () => {
    const terminal = fakeScreenTerminal({ columns: 100, rows: 30 });
    const early = createEarlyInput(terminal.input, () => DEFAULT_KEY_TABLE);
    terminal.push([
      textKey('h'),
      namedKey('enter'),
      namedKey('escape'),
      namedKey('tab'),
      mouseClick,
      { type: 'paste', text: 'line 1\nline 2\nline 3\nline 4', overflow: false },
      namedKey('up'),
      { type: 'key', text: 'c', ...plain, ctrl: true },
      textKey('i'),
    ]);
    const taken = early.take();
    expect(taken).toHaveLength(3);
    const editor = applyEarlyInput(emptyEditor(), taken);
    expect(editor.text).toBe('h[Pasted text #1 +4 lines]i');
    expect(editor.pastes).toHaveLength(1);
    expect(early.stop()).toEqual([]);

    const shellTerminal = fakeScreenTerminal({ columns: 100, rows: 30 });
    const shellEarly = createEarlyInput(shellTerminal.input, () => DEFAULT_KEY_TABLE);
    shellTerminal.push([textKey('!'), textKey('l'), textKey('s')]);
    const shellEditor = applyEarlyInput(emptyEditor(), shellEarly.stop());
    expect(shellEditor.shell).toBe(true);
    expect(shellEditor.text).toBe('ls');
  });

  it('renders pre-render input in the first frame and folds events between first render and typing claim without loss or duplication', async () => {
    const terminal = fakeScreenTerminal({ columns: 100, rows: 30 });
    const early = createEarlyInput(terminal.input, () => DEFAULT_KEY_TABLE);
    terminal.push([textKey('a'), textKey('b'), namedKey('enter'), mouseClick]);
    const wrappedEarly: EarlyInput = {
      take: () => {
        const initial = early.take();
        terminal.push([textKey('c'), { type: 'paste', text: 'd', overflow: false }, namedKey('backspace')]);
        return initial;
      },
      stop: () => early.stop(),
    };

    const app = renderObservable(
      <App
        backend={fakeBackend({})}
        terminal={terminal}
        earlyInput={wrappedEarly}
        initialMode={undefined}
        now={Date.now}
        timers={settleAtOnce(systemTiming)}
        startup={{ version: '1.2.3', home: '/Users/ada' }}
        tuiSettings={settings()}
        onExit={() => undefined}
      />,
    );
    expect(app.frames[0] ?? '').toContain('> ab');
    const ready = await untilFrame(app, (frame) => frame.includes('> abcd') && frame.includes('mode: manual'));
    expect(ready).not.toContain('abcdabcd');
    app.unmount();
  });
});
