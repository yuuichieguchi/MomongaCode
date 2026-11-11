import { systemTiming } from '@momonga/foundation';
import type { ResolvedTuiSettings } from '@momonga/config';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/tui/app.tsx';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import { fakeBackend, runView } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, renderObservable, untilFrame, untilOutput, TEST_KEY_SETTLE_MS, settleAtOnce } from '../ink-helpers.ts';
import { frame } from '../tui-harness.tsx';
import { fakeScreenTerminal } from './screen-fakes.ts';
import { pollUntil } from '@momonga/testkit';

const HOSTILE_FOLDER = '/work/pro\u001b]0;pwn\u0007ject\u009b2J\n';
const TITLE = (state: string): string => `momonga · pro]0;pwnject2J · ${state}`;

const keyX: TerminalEvent = { type: 'key', text: 'x', ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };
const focus = (direction: 'in' | 'out'): TerminalEvent => ({ type: 'focus', direction });

const until = (met: () => boolean, what: string): Promise<void> => pollUntil(met, { description: what, boundMs: SCREEN_REACHED_BOUND_MS });

const SCREEN_REACHED_BOUND_MS = 3000;

const storedSettings = (initial: Partial<ResolvedTuiSettings> = {}) => {
  const saved: { name: string; value: string | boolean; aborted: boolean }[] = [];
  const port: TuiSettingsPort = {
    initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true, ...initial },
    save: async (name, value, signal) => {
      saved.push({ name, value, aborted: signal.aborted });
    },
  };
  return { port, saved };
};

const start = async (options: FakeBackendOptions = {}, initial: Partial<ResolvedTuiSettings> = {}) => {
  const backend = fakeBackend({ session: { cwd: HOSTILE_FOLDER }, ...options });
  const terminal = fakeScreenTerminal({ columns: 100, rows: 30 });
  const settings = storedSettings(initial);
  const app = renderObservable(<App backend={backend} terminal={terminal} initialMode={undefined} now={Date.now} timers={settleAtOnce(systemTiming)} keySettleMs={TEST_KEY_SETTLE_MS} tuiSettings={settings.port} onExit={() => undefined} />);
  return { backend, terminal, app, saved: settings.saved };
};

const ready = async (options: FakeBackendOptions = {}, initial: Partial<ResolvedTuiSettings> = {}) => {
  const started = await start(options, initial);
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
  await until(() => started.terminal.titles.at(-1)?.endsWith(' · working') === true, 'the title says working');
};

const ask = (started: Awaited<ReturnType<typeof start>>): void => {
  started.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'Bash c1', rawInput: { command: 'ls' } }));
  started.backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'asks', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }] }));
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
    expect(started.terminal.titles.at(-1)?.endsWith(' · working')).toBe(true);
    started.app.unmount();
  });
});

describe('the notification switch', () => {
  it('is off unless turned on: no bell for a prompt, a run that ended or a failure, and focus reporting stays off', async () => {
    const started = await ready();
    await run(started);
    ask(started);
    await until(() => started.terminal.titles.at(-1) === TITLE('waiting for you'), 'waiting for you');
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done');
    expect(started.terminal.bells).toEqual([]);
    expect(started.terminal.state().enabled).not.toContain('focus');
    started.app.unmount();
  });

  it('when on, rings once for a prompt that needs the user and once for the end of the run, and for nothing else', async () => {
    const started = await ready({}, { notify: 'bell' });
    expect(started.terminal.state().enabled).toContain('focus');
    await run(started);
    ask(started);
    await until(() => started.terminal.titles.at(-1) === TITLE('waiting for you'), 'waiting for you');
    started.backend.emit(frame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await until(() => started.terminal.titles.at(-1) === TITLE('working'), 'working again');
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done');
    started.terminal.resize(100, 31);
    expect(started.terminal.bells).toEqual([TITLE('waiting for you'), TITLE('done')]);
    started.app.unmount();
  });

  it('when on, rings for a run that failed and not for one the user cancelled', async () => {
    const started = await ready({}, { notify: 'bell' });
    await run(started);
    started.backend.finish(runView({ status: 'FAILED', error: { code: 'provider_error', message: 'the provider failed' } }));
    await until(() => started.terminal.titles.at(-1) === TITLE('error'), 'error');
    await run(started, 'again');
    started.backend.finish(runView({ status: 'CANCELLED' }));
    await until(() => started.terminal.titles.at(-1) === TITLE('ready'), 'ready');
    expect(started.terminal.bells).toEqual([TITLE('error')]);
    started.app.unmount();
  });

  it('when on, is silent while the terminal reports that it has the focus and rings after it reports that it lost it', async () => {
    const started = await ready({}, { notify: 'bell' });
    started.terminal.emit(focus('in'));
    await run(started);
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done');
    expect(started.terminal.bells).toEqual([]);
    started.terminal.emit(focus('out'));
    await run(started, 'again');
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done again');
    expect(started.terminal.bells).toEqual([TITLE('done')]);
    started.app.unmount();
  });

  it('is turned on and off from inside the TUI with /config notify, which stores the value and applies it at once', async () => {
    const started = await ready();
    await submit(started, '/config notify');
    await untilOutput(started.app, 'notify: off');
    await submit(started, '/config notify bell');
    await untilOutput(started.app, 'notify: bell');
    expect(started.saved).toEqual([{ name: 'notify', value: 'bell', aborted: false }]);
    await until(() => started.terminal.state().enabled.includes('focus'), 'focus reporting is on');
    await run(started);
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done');
    expect(started.terminal.bells).toEqual([TITLE('done')]);
    await submit(started, '/config notify off');
    await until(() => started.saved.length === 2, 'off is stored');
    await until(() => !started.terminal.state().enabled.includes('focus'), 'focus reporting is off');
    await run(started, 'again');
    started.backend.finish(runView());
    await until(() => started.terminal.titles.at(-1) === TITLE('done'), 'done again');
    expect(started.terminal.bells).toEqual([TITLE('done')]);
    started.app.unmount();
  });

  it('refuses a value that is not one of the two and names them', async () => {
    const started = await ready();
    await submit(started, '/config notify osc9');
    await untilOutput(started.app, 'unknown notify value osc9; available: off, bell');
    await submit(started, '/config nothing');
    await untilOutput(started.app, 'usage: /config notify [off|bell]');
    expect(started.saved).toEqual([]);
    started.app.unmount();
  });
});
