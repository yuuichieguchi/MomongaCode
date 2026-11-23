import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { systemTiming } from '@momonga/foundation';
import type { ResolvedTuiSettings } from '@momonga/config';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/tui/app.tsx';
import type { AttentionTerminal, TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import type { ScreenTimers } from '../../src/tui/screen/timers.ts';
import { createScreenInput } from '../../src/tui/screen/input.ts';
import { TerminalFrame } from '../../src/tui/terminal/frame.tsx';
import { createInkStdin } from '../../src/tui/terminal/ink-stdin.ts';
import { createTerminalLayer } from '../../src/tui/terminal/layer.ts';
import { titleSequence } from '../../src/tui/terminal/title.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import { fakeBackend, runView } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, TUI_TEST_TIMEOUT_MS, renderObservable, untilFrame, untilOutput, settleAtOnce } from '../ink-helpers.ts';
import { frame } from '../tui-harness.tsx';
import { fakeScreenTerminal } from './screen-fakes.ts';
import { createFakeClock, pollUntil } from '@momonga/testkit';
import { manualClock } from './screen-clock.ts';
import type { ManualClock } from './screen-clock.ts';
import type { FakeClock } from '@momonga/testkit';

const HOSTILE_FOLDER = '/work/pro\u001b]0;pwn\u0007ject\u009b2J\n';
const FOLDER = 'pro]0;pwnject2J';
const PLAIN = `${FOLDER} - momonga`;
const WORKING = `⠋ ${FOLDER} - momonga`;
const SECOND_FRAME = `⠙ ${FOLDER} - momonga`;
const STILL = `• ${FOLDER} - momonga`;
const ACTION = `[ ! ] Action Required - ${FOLDER} - momonga`;
const ACTION_DOT = `[ . ] Action Required - ${FOLDER} - momonga`;
const NOTICE = (text: string): string => `${text} - ${FOLDER}`;
const ANIMATION_AND_SIGNAL_MS: readonly number[] = [100, 1000];
const CLOCK_START_MS = 1_700_000_000_000;

const keyX: TerminalEvent = { type: 'key', text: 'x', ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };
const focus = (direction: 'in' | 'out'): TerminalEvent => ({ type: 'focus', direction });

const until = (met: () => boolean, what: string): Promise<void> => pollUntil(met, { description: what, boundMs: SCREEN_REACHED_BOUND_MS });

const SCREEN_REACHED_BOUND_MS = 3000;

const storedSettings = (initial: Partial<ResolvedTuiSettings> = {}) => {
  const saved: { name: string; value: string | boolean; aborted: boolean }[] = [];
  const port: TuiSettingsPort = {
    initial: { theme: 'auto', notify: 'auto', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true, ...initial },
    save: async (name, value, signal) => {
      saved.push({ name, value, aborted: signal.aborted });
    },
  };
  return { port, saved };
};

type StartGiven = { scrollback?: boolean; attentionTerminal?: AttentionTerminal; timers?: ScreenTimers; unstored?: boolean; clock?: FakeClock; before?: (backend: ReturnType<typeof fakeBackend>, terminal: ReturnType<typeof fakeScreenTerminal>) => void };

const routed = (base: ScreenTimers, manual: ManualClock): ScreenTimers => {
  const owned = new WeakSet<object>();
  return {
    setTimeout: (run, ms) => {
      if (!ANIMATION_AND_SIGNAL_MS.includes(ms)) return base.setTimeout(run, ms);
      const handle = manual.timers.setTimeout(run, ms);
      if (typeof handle === 'object' && handle !== null) owned.add(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'object' && handle !== null && owned.has(handle)) manual.timers.clearTimeout(handle);
      else base.clearTimeout(handle);
    },
  };
};

const start = async (options: FakeBackendOptions = {}, initial: Partial<ResolvedTuiSettings> = {}, given: StartGiven = {}) => {
  const backend = fakeBackend({ session: { cwd: HOSTILE_FOLDER }, ...options });
  const terminal = fakeScreenTerminal({ ...(given.scrollback === true ? { screen: 'scrollback' } : {}), columns: 100, rows: 30 });
  const disabled: string[] = [];
  const disable = terminal.disable;
  terminal.disable = (mode) => {
    disabled.push(mode);
    disable(mode);
  };
  given.before?.(backend, terminal);
  const clock = given.clock ?? createFakeClock(CLOCK_START_MS);
  const settings = storedSettings(initial);
  const manual = manualClock(0);
  const app = renderObservable(
    <App
      backend={backend}
      terminal={terminal}
      initialMode={undefined}
      now={clock.now}
      timers={routed(given.timers ?? settleAtOnce(systemTiming), manual)}
      {...(given.unstored === true ? {} : { tuiSettings: settings.port })}
      {...(given.attentionTerminal === undefined ? {} : { attentionTerminal: given.attentionTerminal })}
      onExit={() => undefined}
    />,
  );
  return { backend, terminal, app, saved: settings.saved, disabled, clock, manual };
};

type Started = Awaited<ReturnType<typeof start>>;

const untilTitle = async (started: Started, title: string, what: string): Promise<void> => {
  await until(() => started.terminal.titles.at(-1) === title, what);
};

const signalCount = (started: Started): number => started.terminal.bells.length + started.terminal.notifications.length;

const afterTheDelay = async (started: Started, signals: number): Promise<void> => {
  started.manual.advance(100);
  await until(() => signalCount(started) >= signals, `${signals} signal(s) after the delay`);
};

const nothingAfterTheDelay = async (started: Started): Promise<void> => {
  started.manual.advance(100);
  started.terminal.resize(100, 31);
  await untilFrame(started.app, 'mode: manual');
  started.terminal.resize(100, 30);
  await untilFrame(started.app, 'mode: manual');
};

const ready = async (options: FakeBackendOptions = {}, initial: Partial<ResolvedTuiSettings> = {}, given: StartGiven = {}) => {
  const started = await start(options, initial, given);
  await untilFrame(started.app, 'mode: manual');
  return started;
};

const submit = async (started: Awaited<ReturnType<typeof start>>, text: string): Promise<void> => {
  started.app.stdin.write(text);
  await untilFrame(started.app, `> ${text}`);
  started.app.stdin.write(KEYS.enter);
};

const run = async (started: Awaited<ReturnType<typeof start>>, text = 'go'): Promise<void> => {
  const runs = started.backend.started.length;
  await submit(started, text);
  await until(() => started.backend.started.length > runs, 'the run is started');
  await untilTitle(started, WORKING, 'the title shows the first spinner frame');
};

const ask = (started: Awaited<ReturnType<typeof start>>): void => {
  started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'Bash c1', rawInput: { command: 'ls' } }));
  started.backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'asks', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'approval', input: {} } }));
};

describe('the terminal title names the state of the session', () => {
  it('shows the folder made safe and the product at the start, and is not repeated while nothing changes', async () => {
    const started = await ready();
    expect(started.terminal.titles).toEqual([PLAIN]);
    started.app.stdin.write('abc');
    await untilFrame(started.app, '> abc');
    started.terminal.resize(100, 31);
    started.manual.advance(3000);
    await untilFrame(started.app, 'mode: manual');
    expect(started.terminal.titles).toEqual([PLAIN]);
    started.app.unmount();
  });

  it('spins during a run, asks for action while an approval is open, and is plain after a run that ended well', async () => {
    const started = await ready();
    await run(started);
    ask(started);
    await untilTitle(started, ACTION, 'the title asks for action');
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilTitle(started, WORKING, 'the spinner again');
    started.backend.finish(runView());
    await untilTitle(started, PLAIN, 'the plain title after the run');
    expect(started.terminal.titles).toEqual([PLAIN, WORKING, ACTION, WORKING, PLAIN]);
    started.terminal.emit({ type: 'focus', direction: 'out' });
    started.terminal.resize(100, 31);
    expect(started.terminal.titles.at(-1)).toBe(PLAIN);
    await run(started, 'again');
    expect(started.terminal.titles.slice(-2)).toEqual([PLAIN, WORKING]);
    started.app.unmount();
  });

  it('turns the spinner every 100 ms of the screen timers while a run works', async () => {
    const started = await ready();
    await run(started);
    started.manual.advance(100);
    await untilTitle(started, SECOND_FRAME, 'the second spinner frame');
    expect(started.terminal.titles).toEqual([PLAIN, WORKING, SECOND_FRAME]);
    started.app.unmount();
  });

  it('swaps the mark of the action title every 1000 ms of the screen timers while a prompt is shown', async () => {
    const started = await ready();
    await run(started);
    ask(started);
    await untilTitle(started, ACTION, 'the title asks for action');
    started.manual.advance(1000);
    await untilTitle(started, ACTION_DOT, 'the dot');
    started.manual.advance(1000);
    await untilTitle(started, ACTION, 'the exclamation mark again');
    started.app.unmount();
  });

  it.each([{ setting: 'reducedMotion' }, { setting: 'screenReader' }] as const)('with $setting shows the static mark while working and a steady action title while a prompt is shown', async ({ setting }) => {
    const started = await start({}, { [setting]: true }, { scrollback: true });
    await untilOutput(started.app, 'mode: manual');
    await submit(started, 'go');
    await until(() => started.backend.started.length === 1, 'the run is started');
    await untilTitle(started, STILL, 'the static mark');
    started.manual.advance(1000);
    ask(started);
    await untilTitle(started, ACTION, 'the title asks for action');
    started.manual.advance(1000);
    started.manual.advance(1000);
    started.terminal.resize(100, 31);
    await until(() => started.terminal.titles.length >= 3, 'the titles are written');
    expect(started.terminal.titles).toEqual([PLAIN, STILL, ACTION]);
    started.app.unmount();
  }, TUI_TEST_TIMEOUT_MS);

  it('is plain after a run that failed, and stays so without a new write after the next key', async () => {
    const started = await ready();
    await run(started);
    started.backend.finish(runView({ status: 'FAILED', error: { code: 'provider_error', message: 'the provider failed' } }));
    await untilTitle(started, PLAIN, 'the plain title after the failure');
    started.terminal.emit(keyX);
    started.terminal.resize(100, 31);
    await untilFrame(started.app, 'mode: manual');
    expect(started.terminal.titles).toEqual([PLAIN, WORKING, PLAIN]);
    started.app.unmount();
  });

  it('is plain after a run the user cancelled', async () => {
    const started = await ready();
    await run(started);
    started.backend.finish(runView({ status: 'CANCELLED' }));
    await untilTitle(started, PLAIN, 'the plain title after a cancel');
    expect(started.terminal.titles).toEqual([PLAIN, WORKING, PLAIN]);
    started.app.unmount();
  });

  it('asks for action while the trust question is open', async () => {
    const started = await start({ trust: { path: HOSTILE_FOLDER, decision: null } });
    await untilTitle(started, ACTION, 'the title asks for action');
    started.app.unmount();
  });

  it('writes no title after the screen ended', async () => {
    const started = await ready();
    await run(started);
    const written = started.terminal.titles.length;
    started.app.unmount();
    started.manual.advance(5000);
    expect(started.terminal.titles).toHaveLength(written);
  });

  it('never holds more than 120 characters and nothing a terminal acts on', async () => {
    const started = await ready({ session: { cwd: `/work/${'字'.repeat(200)}\u001b[2J` } });
    await submit(started, 'go');
    await until(() => started.terminal.titles.at(-1)?.startsWith('⠋ ') === true, 'the title shows the first spinner frame');
    for (const title of started.terminal.titles) {
      expect([...title].length).toBeLessThanOrEqual(120);
      expect(title).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(started.terminal.titles.at(-1)).toBe(`⠋ ${'字'.repeat(108)} - momonga`);
    started.app.unmount();
  });
});

const OSC9_TERMINAL: AttentionTerminal = { osc9: true, tmux: false };
const BELL_TERMINAL: AttentionTerminal = { osc9: false, tmux: false };

const LONG_WAIT_MS = 500;

const heldLongWaits = (base: ScreenTimers) => {
  type Held = { run: () => void; real: unknown };
  let holding = false;
  const held = new Set<Held>();
  const timers: ScreenTimers = {
    setTimeout: (run, ms) => {
      if (!holding || ms < LONG_WAIT_MS) return base.setTimeout(run, ms);
      const entry: Held = {
        run,
        real: base.setTimeout(() => {
          held.delete(entry);
          run();
        }, ms),
      };
      held.add(entry);
      return entry;
    },
    clearTimeout: (handle) => {
      const entry = [...held].find((one) => one === handle);
      if (entry === undefined) {
        base.clearTimeout(handle);
        return;
      }
      held.delete(entry);
      base.clearTimeout(entry.real);
    },
  };
  return {
    timers,
    hold: () => {
      holding = true;
    },
    endEveryHeldWait: (): number => {
      holding = false;
      const due = [...held];
      held.clear();
      for (const entry of due) {
        base.clearTimeout(entry.real);
        entry.run();
      }
      return due.length;
    },
  };
};

const finishDone = async (started: Started, text = 'go'): Promise<void> => {
  await run(started, text);
  started.backend.finish(runView());
  await untilTitle(started, PLAIN, 'the plain title after the run');
};

const ended = async (started: Started, view: Parameters<typeof runView>[0]): Promise<void> => {
  started.backend.finish(runView(view));
  await untilTitle(started, PLAIN, 'the plain title after the run');
};

const lastTitleBeforeEachSignal = (started: Started): string[] => {
  const seen: string[] = [];
  let title = '';
  for (const entry of started.terminal.written) {
    if (entry.kind === 'title') title = entry.text;
    else seen.push(title);
  }
  return seen;
};

describe('the notification setting in the running screen', () => {
  it('off writes no signal for a prompt, a run that ended or a failure, and focus reporting stays off', async () => {
    const started = await ready({}, { notify: 'off' });
    started.terminal.emit(focus('out'));
    await run(started);
    ask(started);
    await untilTitle(started, ACTION, 'the title asks for action');
    await nothingAfterTheDelay(started);
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilTitle(started, WORKING, 'the spinner again');
    await ended(started, {});
    await nothingAfterTheDelay(started);
    await run(started, 'again');
    await ended(started, { status: 'FAILED', error: { code: 'provider_error', message: 'the provider failed' } });
    await nothingAfterTheDelay(started);
    expect(started.terminal.bells).toEqual([]);
    expect(started.terminal.notifications).toEqual([]);
    expect(started.terminal.state().enabled).not.toContain('focus');
    started.app.unmount();
  });

  it('with nothing stored, auto is in force and focus reporting is turned on', async () => {
    const started = await ready({}, {}, { unstored: true });
    expect(started.terminal.state().enabled).toContain('focus');
    await submit(started, '/config notify');
    await untilOutput(started.app, 'notify: auto');
    started.app.unmount();
  });

  it('auto on a terminal that shows OSC 9 sends one desktop notification 100 ms after the plain title when a run ends while the focus is out', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    expect(started.terminal.state().enabled).toContain('focus');
    started.terminal.emit(focus('out'));
    await finishDone(started);
    started.terminal.resize(100, 31);
    await untilFrame(started.app, 'mode: manual');
    expect(started.terminal.notifications).toEqual([]);
    started.manual.advance(99);
    started.terminal.resize(100, 30);
    await untilFrame(started.app, 'mode: manual');
    expect(started.terminal.notifications).toEqual([]);
    started.manual.advance(1);
    await until(() => started.terminal.notifications.length === 1, 'the notification');
    expect(started.terminal.written.slice(-2)).toEqual([
      { kind: 'title', text: PLAIN },
      { kind: 'notification', text: NOTICE('Run complete in 0s'), tmux: false },
    ]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('auto inside tmux asks for the passthrough', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: { osc9: true, tmux: true } });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    await afterTheDelay(started, 1);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('Run complete in 0s'), tmux: true }]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('auto on a terminal that does not show OSC 9 rings the bell once, 100 ms after the plain title', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: BELL_TERMINAL });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    expect(started.terminal.bells).toEqual([]);
    await afterTheDelay(started, 1);
    expect(started.terminal.bells).toEqual([PLAIN]);
    expect(started.terminal.written.slice(-2)).toEqual([{ kind: 'title', text: PLAIN }, { kind: 'bell' }]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it('auto without a terminal given rings the bell, as on a terminal that does not show OSC 9', async () => {
    const started = await ready({}, { notify: 'auto' });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    await afterTheDelay(started, 1);
    expect(started.terminal.bells).toEqual([PLAIN]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it('auto sends the approval heading after the action title while the focus is out, and the run end after the plain title', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    ask(started);
    await untilTitle(started, ACTION, 'the title asks for action');
    await afterTheDelay(started, 1);
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilTitle(started, WORKING, 'the spinner again');
    await ended(started, {});
    await afterTheDelay(started, 2);
    expect(started.terminal.notifications.map((sent) => sent.text)).toEqual([NOTICE('Permission requested: Bash c1'), NOTICE('Run complete in 0s')]);
    expect(lastTitleBeforeEachSignal(started)).toEqual([ACTION, PLAIN]);
    started.app.unmount();
  });

  it('drops the approval signal when the approval is answered within 100 ms', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    ask(started);
    await untilTitle(started, ACTION, 'the title asks for action');
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilTitle(started, WORKING, 'the spinner again');
    started.manual.advance(1000);
    started.terminal.resize(100, 31);
    await untilFrame(started.app, 'mode: manual');
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it('drops the run-end signal when the next run starts within 100 ms', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    await run(started, 'again');
    started.manual.advance(1000);
    started.terminal.resize(100, 31);
    await untilFrame(started.app, 'mode: manual');
    expect(started.terminal.notifications).toEqual([]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('drops the run-end signal when the focus comes back within 100 ms', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    started.terminal.emit(focus('in'));
    await nothingAfterTheDelay(started);
    started.manual.advance(1000);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it('drops the run-end signal when the setting changes within 100 ms', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: BELL_TERMINAL });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    await submit(started, '/config notify bell');
    await untilOutput(started.app, 'notify: bell');
    await nothingAfterTheDelay(started);
    started.manual.advance(1000);
    expect(started.terminal.bells).toEqual([]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it('drops the run-end signal when the screen ends within 100 ms', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    started.app.unmount();
    started.manual.advance(1000);
    expect(started.terminal.notifications).toEqual([]);
    expect(started.terminal.bells).toEqual([]);
  });

  it('auto sends error for a run that failed and nothing for one the user cancelled', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    await ended(started, { status: 'FAILED', error: { code: 'provider_error', message: 'the provider failed' } });
    await afterTheDelay(started, 1);
    await run(started, 'again');
    await ended(started, { status: 'CANCELLED' });
    await nothingAfterTheDelay(started);
    expect(started.terminal.notifications.map((sent) => sent.text)).toEqual([NOTICE('Run failed: provider_error: the provider failed')]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('bell rings once for a prompt that needs the user and once for the end of the run, even on a terminal that shows OSC 9', async () => {
    const started = await ready({}, { notify: 'bell' }, { attentionTerminal: OSC9_TERMINAL });
    expect(started.terminal.state().enabled).toContain('focus');
    started.terminal.emit(focus('out'));
    await run(started);
    ask(started);
    await untilTitle(started, ACTION, 'the title asks for action');
    await afterTheDelay(started, 1);
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await untilTitle(started, WORKING, 'the spinner again');
    await ended(started, {});
    await afterTheDelay(started, 2);
    started.terminal.resize(100, 31);
    expect(started.terminal.bells).toEqual([ACTION, PLAIN]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it.each(['auto', 'bell'] as const)('%s writes nothing when the terminal never reported the focus, even after every long wait has ended', async (notify) => {
    const waits = heldLongWaits(settleAtOnce(systemTiming));
    const started = await ready({}, { notify }, { attentionTerminal: OSC9_TERMINAL, timers: waits.timers });
    await run(started);
    waits.hold();
    await ended(started, {});
    waits.endEveryHeldWait();
    started.manual.advance(5000);
    started.terminal.resize(100, 31);
    await untilFrame(started.app, 'mode: manual');
    expect(started.terminal.bells).toEqual([]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it.each(['auto', 'bell'] as const)('%s writes nothing while the last focus report was in', async (notify) => {
    const started = await ready({}, { notify }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    started.terminal.emit(focus('in'));
    await finishDone(started);
    await nothingAfterTheDelay(started);
    expect(started.terminal.bells).toEqual([]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it.each(['auto', 'bell'] as const)('%s writes nothing for a focus out that arrives after the run ended, and signals the next run end', async (notify) => {
    const started = await ready({}, { notify }, { attentionTerminal: BELL_TERMINAL });
    await finishDone(started);
    await nothingAfterTheDelay(started);
    started.terminal.emit(focus('out'));
    await nothingAfterTheDelay(started);
    expect(started.terminal.bells).toEqual([]);
    await finishDone(started, 'again');
    await afterTheDelay(started, 1);
    expect(started.terminal.bells).toEqual([PLAIN]);
    started.app.unmount();
  });

  it('switching from auto to bell keeps focus reporting on and the last report, so the next run end rings', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await submit(started, '/config notify bell');
    await untilOutput(started.app, 'notify: bell');
    expect(started.saved).toEqual([{ name: 'notify', value: 'bell', aborted: false }]);
    await finishDone(started);
    await afterTheDelay(started, 1);
    expect(started.disabled).not.toContain('focus');
    expect(started.terminal.state().enabled).toContain('focus');
    expect(started.terminal.bells).toEqual([PLAIN]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it('switching to off turns focus reporting off and forgets the last report', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: BELL_TERMINAL });
    started.terminal.emit(focus('out'));
    await submit(started, '/config notify off');
    await until(() => started.saved.length === 1, 'off is stored');
    await until(() => !started.terminal.state().enabled.includes('focus'), 'focus reporting is off');
    expect(started.disabled).toEqual(['focus']);
    await finishDone(started);
    await nothingAfterTheDelay(started);
    expect(started.terminal.bells).toEqual([]);
    await submit(started, '/config notify auto');
    await until(() => started.terminal.state().enabled.includes('focus'), 'focus reporting is on again');
    await finishDone(started, 'again');
    await nothingAfterTheDelay(started);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('auto sends the trust question for the trust screen when the focus went out before it was shown', async () => {
    let openBoot: () => void = () => undefined;
    const started = await start({ trust: { path: '/tmp/work/trusted', decision: null } }, { notify: 'auto' }, {
      attentionTerminal: OSC9_TERMINAL,
      before: (backend) => {
        const boot = backend.boot;
        const opened = new Promise<void>((resolve) => {
          openBoot = resolve;
        });
        backend.boot = async () => {
          await opened;
          return boot();
        };
      },
    });
    await until(() => started.terminal.state().enabled.includes('focus'), 'focus reporting is on');
    started.terminal.emit(focus('out'));
    openBoot();
    await untilTitle(started, ACTION, 'the title asks for action');
    await afterTheDelay(started, 1);
    expect(started.terminal.notifications).toEqual([{ text: 'Do you trust the files in /tmp/work/trusted?', tmux: false }]);
    expect(lastTitleBeforeEachSignal(started)).toEqual([ACTION]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('the trust screen shown at start writes no signal because no focus report exists yet', async () => {
    const started = await start({ trust: { path: HOSTILE_FOLDER, decision: null } }, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    await untilTitle(started, ACTION, 'the title asks for action');
    await untilFrame(started.app, 'Do you trust the files in');
    started.manual.advance(100);
    started.terminal.resize(100, 31);
    await untilFrame(started.app, 'Do you trust the files in');
    started.terminal.resize(100, 30);
    await untilFrame(started.app, 'Do you trust the files in');
    expect(started.terminal.titles).toEqual([PLAIN, ACTION]);
    expect(started.terminal.notifications).toEqual([]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('auto sends one notification with the heading of a question to the person while the focus is out', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'mcp__calc__ask', kind: 'other', title: 'mcp__calc__ask {}', rawInput: {} }));
    started.backend.emit(frame({ type: 'tool.elicitation.requested', inputId: 'in1', callId: 'c1', server: 'calc', requests: [{ key: 'k1', mode: 'form', message: 'Which branch?', requestedSchema: { type: 'object', properties: { branch: { type: 'string' } } } }] }));
    await untilTitle(started, ACTION, 'the title asks for action');
    await afterTheDelay(started, 1);
    started.terminal.resize(100, 31);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('MCP server calc asks for input (mcp__calc__ask {})'), tmux: false }]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('writes no second signal while the state stays done', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    await afterTheDelay(started, 1);
    expect(started.terminal.notifications).toHaveLength(1);
    started.terminal.resize(100, 31);
    started.terminal.emit(focus('in'));
    started.terminal.emit(focus('out'));
    await nothingAfterTheDelay(started);
    started.manual.advance(5000);
    started.terminal.resize(100, 30);
    await untilFrame(started.app, 'mode: manual');
    expect(started.terminal.titles.at(-1)).toBe(PLAIN);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('Run complete in 0s'), tmux: false }]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('says how many whole seconds a completed run took, counted by the screen clock from when the screen follows the run', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    await until(() => started.backend.followed.length === 1, 'the run is followed');
    started.clock.advance(32_999);
    await ended(started, {});
    await afterTheDelay(started, 1);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('Run complete in 32s'), tmux: false }]);
    started.app.unmount();
  });

  it('says only that the run failed for a failed run with neither an error nor a stop reason', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    await ended(started, { status: 'FAILED' });
    await afterTheDelay(started, 1);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('Run failed'), tmux: false }]);
    started.app.unmount();
  });

  it('gives the stop reason of a failed run that has no error', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    await ended(started, { status: 'FAILED', stopReason: 'max_steps' });
    await afterTheDelay(started, 1);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('Run failed: max_steps'), tmux: false }]);
    started.app.unmount();
  });

  it('gives the first line of the failure when the run cannot be started', async () => {
    const started = await ready({}, { notify: 'auto' }, {
      attentionTerminal: OSC9_TERMINAL,
      before: (backend) => {
        backend.startRun = async () => {
          throw Object.assign(new Error('the gateway refused the run'), { detail: 'the quota is used up' });
        };
      },
    });
    started.terminal.emit(focus('out'));
    await submit(started, 'go');
    await untilOutput(started.app, 'the gateway refused the run');
    await afterTheDelay(started, 1);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('Run failed: the gateway refused the run'), tmux: false }]);
    started.app.unmount();
  });

  it('gives the heading of the approval of a file edit', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    started.backend.emit(frame({ type: 'tool.call', callId: 'e1', providerCallId: 'e1', name: 'Edit', kind: 'edit', title: 'Edit src/app.ts', rawInput: { file_path: 'src/app.ts' } }));
    started.backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'e1', subjectDigest: 'd', reason: 'edits require approval', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'approval', input: {} } }));
    await untilTitle(started, ACTION, 'the title asks for action');
    await afterTheDelay(started, 1);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('Permission requested: Edit src/app.ts'), tmux: false }]);
    started.app.unmount();
  });

  it('leaves the counter out of the notification while the panel shows that two approvals wait', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'Bash c1', rawInput: { command: 'ls' } }));
    started.backend.emit(frame({ type: 'tool.call', callId: 'c2', providerCallId: 'c2', name: 'Bash', kind: 'execute', title: 'Bash c2', rawInput: { command: 'pwd' } }));
    started.backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'asks', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'approval', input: {} } }));
    started.backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap2', callId: 'c2', subjectDigest: 'd', reason: 'asks', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'approval', input: {} } }));
    await untilFrame(started.app, 'Permission requested: Bash c1 (1 of 2)');
    await afterTheDelay(started, 1);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('Permission requested: Bash c1'), tmux: false }]);
    started.app.unmount();
  });

  it('leaves the position in the flow out of the notification for a question of several steps', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    started.backend.emit(frame({ type: 'tool.call', callId: 'm1', providerCallId: 'm1', name: 'mcp__github__ask', kind: 'other', title: 'mcp__github__ask {}', rawInput: {} }));
    started.backend.emit(
      frame({
        type: 'tool.elicitation.requested',
        inputId: 'in1',
        callId: 'm1',
        server: 'github',
        requests: [
          { key: 'k1', mode: 'form', message: 'Which branch?', requestedSchema: { type: 'object', properties: { branch: { type: 'string' } } } },
          { key: 'k2', mode: 'form', message: 'Which tag?', requestedSchema: { type: 'object', properties: { tag: { type: 'string' } } } },
        ],
      }),
    );
    await untilFrame(started.app, 'MCP server github asks for input (mcp__github__ask {}) 1/2');
    await afterTheDelay(started, 1);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('MCP server github asks for input (mcp__github__ask {})'), tmux: false }]);
    started.app.unmount();
  });

  it('writes one notification only, for the approval, when a question follows the answered approval while the state stays waiting for you', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    ask(started);
    await untilTitle(started, ACTION, 'the title asks for action');
    await afterTheDelay(started, 1);
    const titlesBefore = started.terminal.titles.length;
    started.backend.emit(frame({ type: 'tool.call', callId: 'm1', providerCallId: 'm1', name: 'mcp__calc__ask', kind: 'other', title: 'mcp__calc__ask {}', rawInput: {} }));
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    started.backend.emit(frame({ type: 'tool.elicitation.requested', inputId: 'in1', callId: 'm1', server: 'calc', requests: [{ key: 'k1', mode: 'form', message: 'Which branch?', requestedSchema: { type: 'object', properties: { branch: { type: 'string' } } } }] }));
    await untilFrame(started.app, 'MCP server calc asks for input');
    await nothingAfterTheDelay(started);
    expect(started.terminal.titles.slice(titlesBefore)).toEqual([]);
    expect(started.terminal.notifications).toEqual([{ text: NOTICE('Permission requested: Bash c1'), tmux: false }]);
    started.app.unmount();
  });

  it('off turns off focus reporting the terminal was adopted with', async () => {
    const started = await ready({}, { notify: 'off' }, { before: (_backend, terminal) => terminal.enable('focus') });
    await until(() => started.disabled.includes('focus'), 'focus reporting is turned off');
    expect(started.terminal.state().enabled).not.toContain('focus');
    started.app.unmount();
  });

  it('auto keeps focus reporting the terminal was adopted with', async () => {
    const started = await ready({}, { notify: 'auto' }, { before: (_backend, terminal) => terminal.enable('focus') });
    started.terminal.resize(100, 31);
    await untilFrame(started.app, 'mode: manual');
    expect(started.disabled).not.toContain('focus');
    expect(started.terminal.state().enabled).toContain('focus');
    started.app.unmount();
  });

  it('refuses a value that is not one of the three and names them', async () => {
    const started = await ready();
    await submit(started, '/config notify osc9');
    await untilOutput(started.app, 'unknown notify value osc9; available: auto, bell, off');
    await submit(started, '/config nothing');
    await untilOutput(started.app, 'usage: /config notify [auto|bell|off]');
    expect(started.saved).toEqual([]);
    started.app.unmount();
  });
});

const ESC = '\u001b';
const BEL = '\u0007';
const FOCUS_OUT = `${ESC}[O`;
const FOCUS_ON = `${ESC}[?1004h`;
const FOCUS_OFF = `${ESC}[?1004l`;
const PLAIN_FOLDER = '/work/myproject';
const LAYER_PLAIN = titleSequence('myproject - momonga');
const LAYER_WORKING = titleSequence('⠋ myproject - momonga');
const LAYER_ACTION = titleSequence('[ ! ] Action Required - myproject - momonga');
const DONE_NOTICE = 'Run complete in 5s - myproject';
const LAYER_BOUND_MS = 3000;

const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  written: string[] = [];
  write = (data: string, done?: () => void): boolean => {
    this.written.push(data);
    done?.();
    return true;
  };
}

const onLayer = async (notify: ResolvedTuiSettings['notify'] | undefined, attentionTerminal?: AttentionTerminal) => {
  const terminalInput = new EventEmitter();
  const stdout = new FakeStdout();
  const control: string[] = [];
  const inkStdin = createInkStdin();
  const input = createScreenInput();
  const layer = createTerminalLayer({
    input: { setRawMode: () => undefined, resume: () => undefined, pause: () => undefined, on: (event, listener) => terminalInput.on(event, listener), off: (event, listener) => terminalInput.off(event, listener) },
    output: { writeSync: (text) => control.push(text), size: () => ({ columns: stdout.columns, rows: stdout.rows }), onResize: () => () => undefined },
    process: { on: () => undefined, off: () => undefined, kill: () => undefined, deliverable: () => true },
    timers: systemTiming,
    screen: 'scrollback',
    screenSetByUser: true,
    mouse: false,
    onFailure: (error) => {
      throw error;
    },
    onEvents: (events) => input.push(events),
  });
  layer.start();
  const backend = fakeBackend({ session: { cwd: PLAIN_FOLDER } });
  const clock = createFakeClock(CLOCK_START_MS);
  const manual = manualClock(0);
  const settings = storedSettings(notify === undefined ? {} : { notify });
  const instance = render(
    <TerminalFrame layer={layer}>
      <App
        backend={backend}
        terminal={{ state: layer.state, subscribe: layer.subscribe, subscribeScreen: layer.subscribeScreen, setScreen: layer.setScreen, setTitle: layer.setTitle, bell: layer.bell, desktopNotification: layer.desktopNotification, enable: layer.enable, disable: layer.disable, input }}
        now={clock.now}
        timers={routed(settleAtOnce(systemTiming), manual)}
        initialMode={undefined}
        {...(notify === undefined ? {} : { tuiSettings: settings.port })}
        {...(attentionTerminal === undefined ? {} : { attentionTerminal })}
        onExit={() => undefined}
      />
    </TerminalFrame>,
    { stdin: inkStdin.stream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false, onRender: () => input.framed() },
  );
  closers.push(() => {
    instance.unmount();
    layer.close();
  });
  const written = (): string => control.join('');
  const waitFor = (met: () => boolean, what: string): Promise<void> => pollUntil(met, { description: what, boundMs: LAYER_BOUND_MS });
  await waitFor(() => stdout.written.join('').includes('mode: manual'), 'the app is ready');
  const feed = (text: string): void => void terminalInput.emit('data', Buffer.from(text, 'utf8'));
  const runToDone = async (): Promise<void> => {
    feed('go');
    await waitFor(() => stdout.written.join('').includes('> go'), 'the prompt is typed');
    feed('\r');
    await waitFor(() => backend.started.length === 1, 'the run is started');
    await waitFor(() => written().includes(LAYER_WORKING), 'the title shows the first spinner frame');
    await waitFor(() => backend.followed.length === 1, 'the run is followed');
    clock.advance(5_000);
    backend.finish(runView());
    await waitFor(() => written().lastIndexOf(LAYER_PLAIN) > written().lastIndexOf(LAYER_WORKING), 'the plain title after the run');
  };
  const pastTheDelay = (): void => manual.advance(100);
  const typed = (shown: string): Promise<void> => waitFor(() => stdout.written.join('').includes(shown), `${shown} is shown`);
  return { written, feed, runToDone, typed, backend, waitFor, pastTheDelay };
};

const count = (text: string, part: string): number => text.split(part).length - 1;

describe('the signal in the bytes the terminal layer writes', () => {
  it('with nothing stored turns focus reporting on', async () => {
    const t = await onLayer(undefined);
    expect(t.written()).toContain(FOCUS_ON);
  });

  it('auto on a terminal that shows OSC 9 writes exactly one OSC 9 with the run time and the folder after a focus out and a run end', async () => {
    const t = await onLayer('auto', OSC9_TERMINAL);
    t.feed(FOCUS_OUT);
    await t.runToDone();
    expect(t.written()).not.toContain(`${ESC}]9;`);
    t.pastTheDelay();
    await t.waitFor(() => t.written().includes(`${ESC}]9;`), 'the notification');
    expect(count(t.written(), `${ESC}]9;`)).toBe(1);
    expect(t.written()).toContain(`${ESC}]9;${DONE_NOTICE}${BEL}`);
    expect(t.written().lastIndexOf(LAYER_PLAIN)).toBeLessThan(t.written().indexOf(`${ESC}]9;${DONE_NOTICE}${BEL}`));
    expect(t.written().lastIndexOf(LAYER_WORKING)).toBeLessThan(t.written().lastIndexOf(LAYER_PLAIN));
    expect(count(t.written(), BEL)).toBe(1);
  });

  it('auto inside tmux writes the OSC 9 wrapped for passthrough', async () => {
    const t = await onLayer('auto', { osc9: true, tmux: true });
    t.feed(FOCUS_OUT);
    await t.runToDone();
    t.pastTheDelay();
    await t.waitFor(() => t.written().includes(`]9;`), 'the notification');
    expect(t.written()).toContain(`${ESC}Ptmux;${ESC}${ESC}]9;${DONE_NOTICE}${BEL}${ESC}\\`);
    expect(count(t.written(), `]9;`)).toBe(1);
  });

  it('auto writes exactly one OSC 9 with the heading of the approval of a file edit', async () => {
    const t = await onLayer('auto', OSC9_TERMINAL);
    t.feed(FOCUS_OUT);
    t.feed('go');
    await t.typed('> go');
    t.feed('\r');
    await t.waitFor(() => t.written().includes(LAYER_WORKING), 'the title shows the first spinner frame');
    t.backend.emit(frame({ type: 'tool.call', callId: 'e1', providerCallId: 'e1', name: 'Edit', kind: 'edit', title: 'Edit src/app.ts', rawInput: { file_path: 'src/app.ts' } }));
    t.backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'e1', subjectDigest: 'd', reason: 'edits require approval', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'approval', input: {} } }));
    await t.waitFor(() => t.written().includes(LAYER_ACTION), 'the title asks for action');
    expect(t.written()).not.toContain(`${ESC}]9;`);
    t.pastTheDelay();
    await t.waitFor(() => t.written().includes(`${ESC}]9;`), 'the notification');
    const approval = `${ESC}]9;Permission requested: Edit src/app.ts - myproject${BEL}`;
    expect(t.written()).toContain(approval);
    expect(t.written().indexOf(LAYER_ACTION)).toBeLessThan(t.written().indexOf(approval));
    expect(count(t.written(), `${ESC}]9;`)).toBe(1);
  });

  it('auto on a terminal that does not show OSC 9 writes exactly one BEL', async () => {
    const t = await onLayer('auto', BELL_TERMINAL);
    t.feed(FOCUS_OUT);
    await t.runToDone();
    expect(count(t.written(), BEL)).toBe(0);
    t.pastTheDelay();
    await t.waitFor(() => count(t.written(), BEL) === 1, 'the bell');
    expect(t.written().lastIndexOf(LAYER_PLAIN)).toBeLessThan(t.written().lastIndexOf(BEL));
    expect(t.written()).not.toContain(`${ESC}]9;`);
  });

  it('off writes neither a signal nor the focus reporting mode', async () => {
    const t = await onLayer('off', OSC9_TERMINAL);
    t.feed(FOCUS_OUT);
    await t.runToDone();
    t.pastTheDelay();
    t.feed('x');
    await t.typed('> x');
    expect(t.written()).not.toContain(FOCUS_ON);
    expect(t.written()).not.toContain(BEL);
    expect(t.written()).not.toContain(FOCUS_OFF);
  });

  it('auto writes no signal for a focus out that arrives after the run ended', async () => {
    const t = await onLayer('auto', OSC9_TERMINAL);
    await t.runToDone();
    t.pastTheDelay();
    t.feed(FOCUS_OUT);
    t.pastTheDelay();
    t.feed('x');
    await t.typed('> x');
    expect(t.written()).not.toContain(`${ESC}]9;`);
    expect(count(t.written(), BEL)).toBe(0);
  });
});
