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
import { KEYS, renderObservable, untilFrame, untilOutput, settleAtOnce } from '../ink-helpers.ts';
import { frame } from '../tui-harness.tsx';
import { fakeScreenTerminal } from './screen-fakes.ts';
import { pollUntil } from '@momonga/testkit';

const HOSTILE_FOLDER = '/work/pro\u001b]0;pwn\u0007ject\u009b2J\n';
const TITLE = (state: string): string => `${state} · pro]0;pwnject2J · momonga`;

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

type StartGiven = { attentionTerminal?: AttentionTerminal; timers?: ScreenTimers; unstored?: boolean; before?: (backend: ReturnType<typeof fakeBackend>, terminal: ReturnType<typeof fakeScreenTerminal>) => void };

const start = async (options: FakeBackendOptions = {}, initial: Partial<ResolvedTuiSettings> = {}, given: StartGiven = {}) => {
  const backend = fakeBackend({ session: { cwd: HOSTILE_FOLDER }, ...options });
  const terminal = fakeScreenTerminal({ columns: 100, rows: 30 });
  const disabled: string[] = [];
  const disable = terminal.disable;
  terminal.disable = (mode) => {
    disabled.push(mode);
    disable(mode);
  };
  given.before?.(backend, terminal);
  const settings = storedSettings(initial);
  const app = renderObservable(
    <App
      backend={backend}
      terminal={terminal}
      initialMode={undefined}
      now={Date.now}
      timers={given.timers ?? settleAtOnce(systemTiming)}
      {...(given.unstored === true ? {} : { tuiSettings: settings.port })}
      {...(given.attentionTerminal === undefined ? {} : { attentionTerminal: given.attentionTerminal })}
      onExit={() => undefined}
    />,
  );
  return { backend, terminal, app, saved: settings.saved, disabled };
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
  await until(() => started.terminal.titles.at(-1)?.startsWith('working · ') === true, 'the title says working');
};

const ask = (started: Awaited<ReturnType<typeof start>>): void => {
  started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'Bash c1', rawInput: { command: 'ls' } }));
  started.backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'asks', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'approval', input: {} } }));
};

describe('the terminal title names the state of the session', () => {
  it('says ready at the start, with the folder name made safe, and is not repeated while nothing changes', async () => {
    const started = await ready();
    expect(started.terminal.titles).toEqual([TITLE('ready')]);
    started.app.stdin.write('abc');
    await untilFrame(started.app, '> abc');
    started.terminal.resize(100, 31);
    expect(started.terminal.titles).toEqual([TITLE('ready')]);
    started.app.unmount();
  });

  it('says working during a run, waiting for you while an approval is open, and done after a run that ended well', async () => {
    const started = await ready();
    await run(started);
    ask(started);
    await until(() => started.terminal.titles.at(-1) === TITLE('waiting for you'), 'waiting for you');
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await until(() => started.terminal.titles.at(-1) === TITLE('working'), 'working again');
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done');
    expect(started.terminal.titles).toEqual([TITLE('ready'), TITLE('working'), TITLE('waiting for you'), TITLE('working'), TITLE('done')]);
    started.terminal.emit({ type: 'focus', direction: 'out' });
    started.terminal.resize(100, 31);
    expect(started.terminal.titles.at(-1)).toBe(TITLE('done'));
    await run(started, 'again');
    expect(started.terminal.titles.slice(-2)).toEqual([TITLE('done'), TITLE('working')]);
    started.app.unmount();
  });

  it('says error after a run that failed, and ready again after the next key', async () => {
    const started = await ready();
    await run(started);
    started.backend.finish(runView({ status: 'FAILED', error: { code: 'provider_error', message: 'the provider failed' } }));
    await until(() => started.terminal.titles.at(-1) === TITLE('error'), 'error');
    started.terminal.emit(keyX);
    await until(() => started.terminal.titles.at(-1) === TITLE('ready'), 'ready after a key');
    started.app.unmount();
  });

  it('says ready after a run the user cancelled', async () => {
    const started = await ready();
    await run(started);
    started.backend.finish(runView({ status: 'CANCELLED' }));
    await until(() => started.terminal.titles.at(-1) === TITLE('ready'), 'ready after a cancel');
    started.app.unmount();
  });

  it('says waiting for you while the trust question is open', async () => {
    const started = await start({ trust: { path: HOSTILE_FOLDER, decision: null } });
    await until(() => started.terminal.titles.at(-1) === TITLE('waiting for you'), 'waiting for you');
    started.app.unmount();
  });

  it('never holds more than 120 characters and nothing a terminal acts on', async () => {
    const started = await ready({ session: { cwd: `/work/${'字'.repeat(200)}\u001b[2J` } });
    await run(started);
    for (const title of started.terminal.titles) {
      expect([...title].length).toBeLessThanOrEqual(120);
      expect(title).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(started.terminal.titles.at(-1)?.startsWith('working · ')).toBe(true);
    expect(started.terminal.titles.at(-1)?.endsWith(' · momonga')).toBe(true);
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

const finishDone = async (started: Awaited<ReturnType<typeof start>>, text = 'go'): Promise<void> => {
  await run(started, text);
  started.backend.finish(runView());
  await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done');
};

describe('the notification setting in the running screen', () => {
  it('off writes no signal for a prompt, a run that ended or a failure, and focus reporting stays off', async () => {
    const started = await ready({}, { notify: 'off' });
    started.terminal.emit(focus('out'));
    await run(started);
    ask(started);
    await until(() => started.terminal.titles.at(-1) === TITLE('waiting for you'), 'waiting for you');
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done');
    await run(started, 'again');
    started.backend.finish(runView({ status: 'FAILED', error: { code: 'provider_error', message: 'the provider failed' } }));
    await until(() => started.terminal.titles.at(-1) === TITLE('error'), 'error');
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

  it('auto on a terminal that shows OSC 9 sends one desktop notification with the title text when a run ends while the focus is out', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    expect(started.terminal.state().enabled).toContain('focus');
    started.terminal.emit(focus('out'));
    await finishDone(started);
    started.terminal.resize(100, 31);
    expect(started.terminal.notifications).toEqual([{ text: TITLE('done'), tmux: false }]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('auto inside tmux asks for the passthrough', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: { osc9: true, tmux: true } });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    expect(started.terminal.notifications).toEqual([{ text: TITLE('done'), tmux: true }]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('auto on a terminal that does not show OSC 9 rings the bell once', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: BELL_TERMINAL });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    expect(started.terminal.bells).toEqual([TITLE('done')]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it('auto without a terminal given rings the bell, as on a terminal that does not show OSC 9', async () => {
    const started = await ready({}, { notify: 'auto' });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    expect(started.terminal.bells).toEqual([TITLE('done')]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it('auto sends waiting for you for an approval while the focus is out, and done for the end of the run', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    ask(started);
    await until(() => started.terminal.titles.at(-1) === TITLE('waiting for you'), 'waiting for you');
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await until(() => started.terminal.titles.at(-1) === TITLE('working'), 'working again');
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done');
    expect(started.terminal.notifications.map((sent) => sent.text)).toEqual([TITLE('waiting for you'), TITLE('done')]);
    started.app.unmount();
  });

  it('auto sends error for a run that failed and nothing for one the user cancelled', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    started.backend.finish(runView({ status: 'FAILED', error: { code: 'provider_error', message: 'the provider failed' } }));
    await until(() => started.terminal.titles.at(-1) === TITLE('error'), 'error');
    await run(started, 'again');
    started.backend.finish(runView({ status: 'CANCELLED' }));
    await until(() => started.terminal.titles.at(-1) === TITLE('ready'), 'ready');
    expect(started.terminal.notifications.map((sent) => sent.text)).toEqual([TITLE('error')]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('bell rings once for a prompt that needs the user and once for the end of the run, even on a terminal that shows OSC 9', async () => {
    const started = await ready({}, { notify: 'bell' }, { attentionTerminal: OSC9_TERMINAL });
    expect(started.terminal.state().enabled).toContain('focus');
    started.terminal.emit(focus('out'));
    await run(started);
    ask(started);
    await until(() => started.terminal.titles.at(-1) === TITLE('waiting for you'), 'waiting for you');
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await until(() => started.terminal.titles.at(-1) === TITLE('working'), 'working again');
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done');
    started.terminal.resize(100, 31);
    expect(started.terminal.bells).toEqual([TITLE('waiting for you'), TITLE('done')]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it.each(['auto', 'bell'] as const)('%s writes nothing when the terminal never reported the focus, even after every long wait has ended', async (notify) => {
    const waits = heldLongWaits(settleAtOnce(systemTiming));
    const started = await ready({}, { notify }, { attentionTerminal: OSC9_TERMINAL, timers: waits.timers });
    await run(started);
    waits.hold();
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done');
    waits.endEveryHeldWait();
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
    expect(started.terminal.bells).toEqual([]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it.each(['auto', 'bell'] as const)('%s writes nothing for a focus out that arrives after the run ended, and signals the next run end', async (notify) => {
    const started = await ready({}, { notify }, { attentionTerminal: BELL_TERMINAL });
    await finishDone(started);
    started.terminal.emit(focus('out'));
    started.terminal.resize(100, 31);
    await untilFrame(started.app, 'mode: manual');
    expect(started.terminal.bells).toEqual([]);
    await finishDone(started, 'again');
    expect(started.terminal.bells).toEqual([TITLE('done')]);
    started.app.unmount();
  });

  it('switching from auto to bell keeps focus reporting on and the last report, so the next run end rings', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await submit(started, '/config notify bell');
    await untilOutput(started.app, 'notify: bell');
    expect(started.saved).toEqual([{ name: 'notify', value: 'bell', aborted: false }]);
    await finishDone(started);
    expect(started.disabled).not.toContain('focus');
    expect(started.terminal.state().enabled).toContain('focus');
    expect(started.terminal.bells).toEqual([TITLE('done')]);
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
    expect(started.terminal.bells).toEqual([]);
    await submit(started, '/config notify auto');
    await until(() => started.terminal.state().enabled.includes('focus'), 'focus reporting is on again');
    await finishDone(started, 'again');
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('auto sends waiting for you for the trust screen when the focus went out before it was shown', async () => {
    let openBoot: () => void = () => undefined;
    const started = await start({ trust: { path: HOSTILE_FOLDER, decision: null } }, { notify: 'auto' }, {
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
    await until(() => started.terminal.titles.at(-1) === TITLE('waiting for you'), 'waiting for you');
    started.terminal.resize(100, 31);
    expect(started.terminal.notifications).toEqual([{ text: TITLE('waiting for you'), tmux: false }]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('the trust screen shown at start writes no signal because no focus report exists yet', async () => {
    const started = await start({ trust: { path: HOSTILE_FOLDER, decision: null } }, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    await until(() => started.terminal.titles.at(-1) === TITLE('waiting for you'), 'waiting for you');
    started.terminal.resize(100, 31);
    expect(started.terminal.notifications).toEqual([]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('auto sends one waiting for you for a question to the person while the focus is out', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await run(started);
    started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'mcp__calc__ask', kind: 'other', title: 'mcp__calc__ask {}', rawInput: {} }));
    started.backend.emit(frame({ type: 'tool.elicitation.requested', inputId: 'in1', callId: 'c1', server: 'calc', requests: [{ key: 'k1', mode: 'form', message: 'Which branch?', requestedSchema: { type: 'object', properties: { branch: { type: 'string' } } } }] }));
    await until(() => started.terminal.titles.at(-1) === TITLE('waiting for you'), 'waiting for you');
    started.terminal.resize(100, 31);
    expect(started.terminal.notifications).toEqual([{ text: TITLE('waiting for you'), tmux: false }]);
    expect(started.terminal.bells).toEqual([]);
    started.app.unmount();
  });

  it('writes no second signal while the state stays done', async () => {
    const started = await ready({}, { notify: 'auto' }, { attentionTerminal: OSC9_TERMINAL });
    started.terminal.emit(focus('out'));
    await finishDone(started);
    expect(started.terminal.notifications).toHaveLength(1);
    started.terminal.resize(100, 31);
    started.terminal.emit(focus('in'));
    started.terminal.emit(focus('out'));
    started.terminal.resize(100, 30);
    await untilFrame(started.app, 'mode: manual');
    expect(started.terminal.titles.at(-1)).toBe(TITLE('done'));
    expect(started.terminal.notifications).toEqual([{ text: TITLE('done'), tmux: false }]);
    expect(started.terminal.bells).toEqual([]);
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
const DONE = 'done · myproject · momonga';
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
  const settings = storedSettings(notify === undefined ? {} : { notify });
  const instance = render(
    <TerminalFrame layer={layer}>
      <App
        backend={backend}
        terminal={{ state: layer.state, subscribe: layer.subscribe, subscribeScreen: layer.subscribeScreen, setScreen: layer.setScreen, setTitle: layer.setTitle, bell: layer.bell, desktopNotification: layer.desktopNotification, enable: layer.enable, disable: layer.disable, input }}
        now={Date.now}
        timers={settleAtOnce(systemTiming)}
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
    await waitFor(() => written().includes(titleSequence('working · myproject · momonga')), 'the title says working');
    backend.finish(runView());
    await waitFor(() => written().includes(titleSequence(DONE)), 'the title says done');
  };
  const typed = (shown: string): Promise<void> => waitFor(() => stdout.written.join('').includes(shown), `${shown} is shown`);
  return { written, feed, runToDone, typed };
};

const count = (text: string, part: string): number => text.split(part).length - 1;

describe('the signal in the bytes the terminal layer writes', () => {
  it('with nothing stored turns focus reporting on', async () => {
    const t = await onLayer(undefined);
    expect(t.written()).toContain(FOCUS_ON);
  });

  it('auto on a terminal that shows OSC 9 writes exactly one OSC 9 with the title text after a focus out and a run end', async () => {
    const t = await onLayer('auto', OSC9_TERMINAL);
    t.feed(FOCUS_OUT);
    await t.runToDone();
    expect(count(t.written(), `${ESC}]9;`)).toBe(1);
    expect(t.written()).toContain(`${ESC}]9;${DONE}${BEL}`);
    expect(count(t.written(), BEL)).toBe(1);
  });

  it('auto inside tmux writes the OSC 9 wrapped for passthrough', async () => {
    const t = await onLayer('auto', { osc9: true, tmux: true });
    t.feed(FOCUS_OUT);
    await t.runToDone();
    expect(t.written()).toContain(`${ESC}Ptmux;${ESC}${ESC}]9;${DONE}${BEL}${ESC}\\`);
    expect(count(t.written(), `]9;`)).toBe(1);
  });

  it('auto on a terminal that does not show OSC 9 writes exactly one BEL', async () => {
    const t = await onLayer('auto', BELL_TERMINAL);
    t.feed(FOCUS_OUT);
    await t.runToDone();
    expect(count(t.written(), BEL)).toBe(1);
    expect(t.written()).not.toContain(`${ESC}]9;`);
  });

  it('off writes neither a signal nor the focus reporting mode', async () => {
    const t = await onLayer('off', OSC9_TERMINAL);
    t.feed(FOCUS_OUT);
    await t.runToDone();
    expect(t.written()).not.toContain(FOCUS_ON);
    expect(t.written()).not.toContain(BEL);
    expect(t.written()).not.toContain(FOCUS_OFF);
  });

  it('auto writes no signal for a focus out that arrives after the run ended', async () => {
    const t = await onLayer('auto', OSC9_TERMINAL);
    await t.runToDone();
    t.feed(FOCUS_OUT);
    t.feed('x');
    await t.typed('> x');
    expect(t.written()).not.toContain(`${ESC}]9;`);
    expect(count(t.written(), BEL)).toBe(0);
  });
});
