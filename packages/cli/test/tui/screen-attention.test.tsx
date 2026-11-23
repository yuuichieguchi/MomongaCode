import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { pollUntil } from '@momonga/testkit';
import { NOTIFY_DELAY_MS, useAttention } from '../../src/tui/screen/notify.ts';
import type { Attention, AttentionTerminal, NotifyMode, RunOutcome, WaitingNotice } from '../../src/tui/screen/notify.ts';
import type { ScreenTimers } from '../../src/tui/screen/timers.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import { TITLE_BLINK_MS } from '../../src/tui/terminal/title.ts';
import { renderObservable, untilFrame } from '../ink-helpers.ts';
import { manualClock } from './screen-clock.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';
import type { FakeScreenTerminal, Written } from './screen-fakes.ts';

const CWD = '/tmp/work/myproject';
const PLAIN = 'myproject - momonga';
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN = (index: number): string => `${FRAMES[index % FRAMES.length]} myproject - momonga`;
const ACTION = '[ ! ] Action Required - myproject - momonga';
const ACTION_DOT = '[ . ] Action Required - myproject - momonga';
const STILL = '• myproject - momonga';
const APPROVAL: WaitingNotice = { heading: 'Permission requested: npm test', namesFolder: false };
const QUESTION: WaitingNotice = { heading: 'MCP server github asks for input (Pick a branch)', namesFolder: false };
const DONE_32S: RunOutcome = { kind: 'done', elapsedMs: 32_000 };
const DONE_NOTICE = 'Run complete in 32s - myproject';
const OSC9_TERMINAL: AttentionTerminal = { osc9: true, tmux: false };
const BELL_TERMINAL: AttentionTerminal = { osc9: false, tmux: false };
const BOUND_MS = 3000;
const keyX: TerminalEvent = { type: 'key', text: 'x', ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };
const focus = (direction: 'in' | 'out'): TerminalEvent => ({ type: 'focus', direction });

type Facts = { working: boolean; waiting: WaitingNotice | undefined; notify: NotifyMode; reducedMotion: boolean };

type ProbeProps = { terminal: FakeScreenTerminal; timers: ScreenTimers; facts: Facts; mark: number; attentionTerminal: AttentionTerminal; onAttention: (attention: Attention) => void };

const Probe = ({ terminal, timers, facts, mark, attentionTerminal, onAttention }: ProbeProps) => {
  onAttention(useAttention({ terminal, cwd: CWD, working: facts.working, waiting: facts.waiting, notify: facts.notify, attentionTerminal, timers, reducedMotion: facts.reducedMotion }));
  return <Text>{`mark ${mark}`}</Text>;
};

const mount = async (given: Partial<Facts> = {}, attentionTerminal: AttentionTerminal = OSC9_TERMINAL) => {
  const terminal = fakeScreenTerminal({ columns: 80, rows: 24 });
  const clock = manualClock(0);
  let facts: Facts = { working: false, waiting: undefined, notify: 'auto', reducedMotion: false, ...given };
  let mark = 0;
  let attention: Attention | undefined;
  const element = () => <Probe terminal={terminal} timers={clock.timers} facts={facts} mark={mark} attentionTerminal={attentionTerminal} onAttention={(latest) => void (attention = latest)} />;
  const app = renderObservable(element());
  const set = async (change: Partial<Facts>): Promise<void> => {
    facts = { ...facts, ...change };
    mark += 1;
    app.rerender(element());
    await untilFrame(app, `mark ${mark}`);
    mark += 1;
    app.rerender(element());
    await untilFrame(app, `mark ${mark}`);
  };
  const flush = (): Promise<void> => set({});
  await untilFrame(app, 'mark 0');
  await flush();
  const advance = async (ms: number): Promise<void> => {
    clock.advance(ms);
    await flush();
  };
  const runEnded = async (outcome: RunOutcome): Promise<void> => {
    attention?.runEnded(outcome);
    await set({ working: false });
  };
  const titlesUntil = (title: string, what: string): Promise<void> => pollUntil(() => terminal.titles.at(-1) === title, { description: what, boundMs: BOUND_MS });
  const signalsUntil = (count: number, what: string): Promise<void> => pollUntil(() => signalsOf(terminal.written).length >= count, { description: what, boundMs: BOUND_MS });
  return { terminal, clock, app, set, flush, advance, runEnded, titlesUntil, signalsUntil };
};

const signalsOf = (written: readonly Written[]): Written[] => written.filter((entry) => entry.kind !== 'title');

const stepEvery = async (started: Awaited<ReturnType<typeof mount>>, ms: number, expected: readonly string[]): Promise<void> => {
  for (const title of expected) {
    started.clock.advance(ms);
    await started.titlesUntil(title, `the title ${title}`);
  }
};

describe('the durations of the attention', () => {
  it('turns the spinner every 100 ms, blinks every 1000 ms and signals 100 ms after the title', () => {
    expect(NOTIFY_DELAY_MS).toBe(100);
    expect(TITLE_BLINK_MS).toBe(1000);
  });
});

describe('the animated terminal title', () => {
  it('writes the plain title once at the start and never again while idle', async () => {
    const started = await mount();
    expect(started.terminal.titles).toEqual([PLAIN]);
    await started.advance(5000);
    expect(started.terminal.titles).toEqual([PLAIN]);
    expect(started.clock.pending()).toBe(0);
    started.app.unmount();
  });

  it('writes the first spinner frame at once when a run starts, then the next frame every 100 ms through all ten and around again', async () => {
    const started = await mount();
    await started.set({ working: true });
    expect(started.terminal.titles).toEqual([PLAIN, SPIN(0)]);
    await stepEvery(started, 100, [SPIN(1), SPIN(2), SPIN(3), SPIN(4), SPIN(5), SPIN(6), SPIN(7), SPIN(8), SPIN(9), SPIN(0), SPIN(1)]);
    await started.flush();
    expect(started.terminal.titles).toEqual([PLAIN, ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1].map(SPIN)]);
    started.app.unmount();
  });

  it('keeps a spinner frame for the whole 100 ms', async () => {
    const started = await mount();
    await started.set({ working: true });
    await started.advance(99);
    expect(started.terminal.titles).toEqual([PLAIN, SPIN(0)]);
    started.clock.advance(1);
    await started.titlesUntil(SPIN(1), 'the second frame');
    expect(started.terminal.titles).toEqual([PLAIN, SPIN(0), SPIN(1)]);
    started.app.unmount();
  });

  it('asks for action at once when a prompt is shown, swapping the mark every 1000 ms and not in between', async () => {
    const started = await mount();
    await started.set({ waiting: APPROVAL });
    expect(started.terminal.titles).toEqual([PLAIN, ACTION]);
    await started.advance(999);
    expect(started.terminal.titles).toEqual([PLAIN, ACTION]);
    started.clock.advance(1);
    await started.titlesUntil(ACTION_DOT, 'the dot');
    await stepEvery(started, 1000, [ACTION, ACTION_DOT]);
    await started.flush();
    expect(started.terminal.titles).toEqual([PLAIN, ACTION, ACTION_DOT, ACTION, ACTION_DOT]);
    started.app.unmount();
  });

  it('asks for action rather than spin while a prompt is shown during a run', async () => {
    const started = await mount();
    await started.set({ working: true, waiting: APPROVAL });
    await started.advance(300);
    expect(started.terminal.titles).toEqual([PLAIN, ACTION]);
    started.app.unmount();
  });

  it('blinks whatever the focus reports say', async () => {
    const started = await mount();
    await started.set({ waiting: APPROVAL });
    started.terminal.emit(focus('in'));
    await stepEvery(started, 1000, [ACTION_DOT]);
    started.terminal.emit(focus('out'));
    await stepEvery(started, 1000, [ACTION]);
    expect(started.terminal.titles).toEqual([PLAIN, ACTION, ACTION_DOT, ACTION]);
    started.app.unmount();
  });

  it('restarts the animation at its first frame on every change of state', async () => {
    const started = await mount({ notify: 'off' });
    await started.set({ working: true });
    await stepEvery(started, 100, [SPIN(1), SPIN(2)]);
    await started.advance(50);
    await started.set({ waiting: APPROVAL });
    expect(started.terminal.titles.at(-1)).toBe(ACTION);
    await started.advance(500);
    await started.set({ waiting: undefined });
    expect(started.terminal.titles.at(-1)).toBe(SPIN(0));
    await started.advance(99);
    expect(started.terminal.titles.at(-1)).toBe(SPIN(0));
    started.clock.advance(1);
    await started.titlesUntil(SPIN(1), 'the second frame after the restart');
    await started.set({ waiting: APPROVAL });
    await started.advance(999);
    expect(started.terminal.titles.at(-1)).toBe(ACTION);
    started.clock.advance(1);
    await started.titlesUntil(ACTION_DOT, 'the dot a whole second after the prompt');
    expect(started.terminal.titles).toEqual([PLAIN, SPIN(0), SPIN(1), SPIN(2), ACTION, SPIN(0), SPIN(1), ACTION, ACTION_DOT]);
    started.app.unmount();
  });

  it('writes the plain title at once when the run ends and nothing after it', async () => {
    const started = await mount({ notify: 'off' });
    await started.set({ working: true });
    await stepEvery(started, 100, [SPIN(1)]);
    await started.runEnded(DONE_32S);
    expect(started.terminal.titles).toEqual([PLAIN, SPIN(0), SPIN(1), PLAIN]);
    await started.advance(3000);
    expect(started.terminal.titles).toEqual([PLAIN, SPIN(0), SPIN(1), PLAIN]);
    expect(started.clock.pending()).toBe(0);
    started.app.unmount();
  });

  it('writes nothing new for an error the next key clears, since the text stays the same', async () => {
    const started = await mount({ notify: 'off' });
    await started.set({ working: true });
    await started.runEnded({ kind: 'error', reason: 'boom' });
    started.terminal.emit(keyX);
    await started.advance(1000);
    expect(started.terminal.titles).toEqual([PLAIN, SPIN(0), PLAIN]);
    started.app.unmount();
  });

  it('shows the static mark while working with reduced motion and never changes it', async () => {
    const started = await mount({ reducedMotion: true });
    await started.set({ working: true });
    await started.advance(100);
    await started.advance(100);
    await started.advance(1000);
    expect(started.terminal.titles).toEqual([PLAIN, STILL]);
    started.app.unmount();
  });

  it('keeps the exclamation mark while a prompt is shown with reduced motion', async () => {
    const started = await mount({ reducedMotion: true });
    await started.set({ waiting: APPROVAL });
    await started.advance(1000);
    await started.advance(1000);
    await started.advance(1000);
    expect(started.terminal.titles).toEqual([PLAIN, ACTION]);
    started.app.unmount();
  });

  it('shows the static mark at once when reduced motion is switched on while working, stops changing, and restarts the spinner at the first frame when it is switched off, with no signal', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await stepEvery(started, 100, [SPIN(1), SPIN(2)]);
    await started.advance(50);
    await started.set({ reducedMotion: true });
    expect(started.terminal.titles.at(-1)).toBe(STILL);
    await started.advance(100);
    await started.advance(1000);
    expect(started.terminal.titles).toEqual([PLAIN, SPIN(0), SPIN(1), SPIN(2), STILL]);
    await started.set({ reducedMotion: false });
    expect(started.terminal.titles.at(-1)).toBe(SPIN(0));
    await started.advance(99);
    expect(started.terminal.titles.at(-1)).toBe(SPIN(0));
    started.clock.advance(1);
    await started.titlesUntil(SPIN(1), 'the second frame after the switch');
    expect(started.terminal.titles).toEqual([PLAIN, SPIN(0), SPIN(1), SPIN(2), STILL, SPIN(0), SPIN(1)]);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    started.app.unmount();
  });

  it.each([
    { what: 'working', facts: { working: true } },
    { what: 'a prompt', facts: { waiting: APPROVAL } },
  ])('clears its timers when the screen ends during $what', async ({ facts }) => {
    const started = await mount({ notify: 'off' });
    await started.set(facts);
    const written = started.terminal.titles.length;
    started.app.unmount();
    expect(started.clock.pending()).toBe(0);
    started.clock.advance(5000);
    expect(started.terminal.titles).toHaveLength(written);
  });
});

describe('the signal 100 ms after the title', () => {
  it('sends the notification of a completed run 100 ms after the plain title, and nothing before', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await started.runEnded(DONE_32S);
    expect(started.terminal.written.at(-1)).toEqual({ kind: 'title', text: PLAIN });
    await started.advance(99);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    started.clock.advance(1);
    await started.signalsUntil(1, 'the notification');
    expect(started.terminal.written.slice(-2)).toEqual([
      { kind: 'title', text: PLAIN },
      { kind: 'notification', text: DONE_NOTICE, tmux: false },
    ]);
    await started.advance(5000);
    expect(signalsOf(started.terminal.written)).toHaveLength(1);
    started.app.unmount();
  });

  it('rings the bell 100 ms after the plain title on a terminal without OSC 9', async () => {
    const started = await mount({}, BELL_TERMINAL);
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await started.runEnded(DONE_32S);
    await started.advance(99);
    expect(started.terminal.bells).toEqual([]);
    started.clock.advance(1);
    await started.signalsUntil(1, 'the bell');
    expect(started.terminal.written.slice(-2)).toEqual([{ kind: 'title', text: PLAIN }, { kind: 'bell' }]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it('rings the bell with the setting bell even on a terminal with OSC 9', async () => {
    const started = await mount({ notify: 'bell' });
    started.terminal.emit(focus('out'));
    await started.set({ waiting: APPROVAL });
    await started.advance(99);
    expect(started.terminal.bells).toEqual([]);
    started.clock.advance(1);
    await started.signalsUntil(1, 'the bell');
    expect(started.terminal.written).toEqual([{ kind: 'title', text: PLAIN }, { kind: 'title', text: ACTION }, { kind: 'bell' }]);
    started.app.unmount();
  });

  it('sends the heading of a prompt 100 ms after the action title, and the blink adds no signal', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true, waiting: APPROVAL });
    await started.advance(99);
    expect(started.terminal.notifications).toEqual([]);
    started.clock.advance(1);
    await started.signalsUntil(1, 'the notification');
    expect(started.terminal.written).toEqual([
      { kind: 'title', text: PLAIN },
      { kind: 'title', text: ACTION },
      { kind: 'notification', text: 'Permission requested: npm test - myproject', tmux: false },
    ]);
    await stepEvery(started, 1000, [ACTION_DOT, ACTION]);
    expect(signalsOf(started.terminal.written)).toHaveLength(1);
    started.app.unmount();
  });

  it('sends the failure 100 ms after the plain title', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await started.runEnded({ kind: 'error', reason: 'the provider failed\ndetail' });
    await started.advance(99);
    expect(started.terminal.notifications).toEqual([]);
    started.clock.advance(1);
    await started.signalsUntil(1, 'the notification');
    expect(started.terminal.written.slice(-2)).toEqual([
      { kind: 'title', text: PLAIN },
      { kind: 'notification', text: 'Run failed: the provider failed - myproject', tmux: false },
    ]);
    started.app.unmount();
  });

  it('asks for the tmux passthrough for the delayed notification inside tmux', async () => {
    const started = await mount({}, { osc9: true, tmux: true });
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await started.runEnded(DONE_32S);
    started.clock.advance(100);
    await started.signalsUntil(1, 'the notification');
    expect(started.terminal.notifications).toEqual([{ text: DONE_NOTICE, tmux: true }]);
    started.app.unmount();
  });

  it('drops the signal of a run end when the next run starts within 100 ms', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await started.runEnded(DONE_32S);
    await started.advance(50);
    await started.set({ working: true });
    await started.advance(1000);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    expect(started.terminal.titles.at(-1)).not.toBe(PLAIN);
    started.app.unmount();
  });

  it('drops the signal of a prompt answered within 100 ms', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true, waiting: APPROVAL });
    await started.advance(99);
    await started.set({ waiting: undefined });
    await started.advance(1000);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    started.app.unmount();
  });

  it('sends exactly one signal, for the new state, 100 ms after a change to another state that needs the person', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true, waiting: APPROVAL });
    await started.advance(50);
    started.terminal.written.length = 0;
    await started.runEnded({ kind: 'error', reason: undefined });
    await started.set({ waiting: undefined });
    expect(started.terminal.written).toEqual([{ kind: 'title', text: PLAIN }]);
    await started.advance(99);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    started.clock.advance(1);
    await started.signalsUntil(1, 'the notification of the failure');
    await started.advance(1000);
    expect(started.terminal.written).toEqual([
      { kind: 'title', text: PLAIN },
      { kind: 'notification', text: 'Run failed - myproject', tmux: false },
    ]);
    started.app.unmount();
  });

  it('drops the signal when the focus comes back within 100 ms', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await started.runEnded(DONE_32S);
    await started.advance(50);
    started.terminal.emit(focus('in'));
    await started.advance(1000);
    started.terminal.emit(focus('out'));
    await started.advance(1000);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    started.app.unmount();
  });

  it('keeps one signal when another focus out arrives within 100 ms', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await started.runEnded(DONE_32S);
    await started.advance(50);
    started.terminal.emit(focus('out'));
    await started.advance(49);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    started.clock.advance(1);
    await started.signalsUntil(1, 'the notification');
    await started.advance(1000);
    expect(signalsOf(started.terminal.written)).toEqual([{ kind: 'notification', text: DONE_NOTICE, tmux: false }]);
    started.app.unmount();
  });

  it.each([
    { from: 'auto', to: 'bell' },
    { from: 'auto', to: 'off' },
    { from: 'bell', to: 'auto' },
    { from: 'bell', to: 'off' },
  ] as const)('drops the signal when the setting changes from $from to $to within 100 ms', async ({ from, to }) => {
    const started = await mount({ notify: from });
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await started.runEnded(DONE_32S);
    await started.advance(50);
    await started.set({ notify: to });
    await started.advance(1000);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    started.app.unmount();
  });

  it('drops the signal when the screen ends within 100 ms', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await started.runEnded(DONE_32S);
    await started.advance(50);
    started.app.unmount();
    expect(started.clock.pending()).toBe(0);
    started.clock.advance(1000);
    expect(signalsOf(started.terminal.written)).toEqual([]);
  });

  it('drops the signal of a failure when the key that clears it comes within 100 ms', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true });
    await started.runEnded({ kind: 'error', reason: 'boom' });
    await started.advance(50);
    started.terminal.emit(keyX);
    await started.advance(1000);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    started.app.unmount();
  });

  it('writes no new signal when a prompt is replaced by another while the state stays waiting for you', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true, waiting: APPROVAL });
    started.clock.advance(100);
    await started.signalsUntil(1, 'the notification of the approval');
    await started.set({ waiting: QUESTION });
    await started.advance(1000);
    expect(started.terminal.notifications).toEqual([{ text: 'Permission requested: npm test - myproject', tmux: false }]);
    started.app.unmount();
  });

  it('keeps the pending signal when the prompt is replaced within 100 ms, sends it 100 ms after the original change with the heading shown then, and writes no title for the replacement', async () => {
    const started = await mount();
    started.terminal.emit(focus('out'));
    await started.set({ working: true, waiting: APPROVAL });
    await started.advance(40);
    await started.set({ waiting: QUESTION });
    await started.advance(59);
    expect(started.terminal.written).toEqual([{ kind: 'title', text: PLAIN }, { kind: 'title', text: ACTION }]);
    started.clock.advance(1);
    await started.signalsUntil(1, 'the notification at 100 ms');
    expect(started.terminal.written).toEqual([
      { kind: 'title', text: PLAIN },
      { kind: 'title', text: ACTION },
      { kind: 'notification', text: 'MCP server github asks for input (Pick a branch) - myproject', tmux: false },
    ]);
    await started.advance(40);
    expect(signalsOf(started.terminal.written)).toHaveLength(1);
    await started.advance(859);
    expect(started.terminal.titles).toEqual([PLAIN, ACTION]);
    started.clock.advance(1);
    await started.titlesUntil(ACTION_DOT, 'the blink 1000 ms after the state change');
    await started.advance(2000);
    expect(signalsOf(started.terminal.written)).toHaveLength(1);
    started.app.unmount();
  });

  it('rings one bell 100 ms after the original change when the prompt is replaced within 100 ms with the setting bell', async () => {
    const started = await mount({ notify: 'bell' });
    started.terminal.emit(focus('out'));
    await started.set({ working: true, waiting: APPROVAL });
    await started.advance(40);
    await started.set({ waiting: QUESTION });
    await started.advance(59);
    expect(started.terminal.bells).toEqual([]);
    started.clock.advance(1);
    await started.signalsUntil(1, 'the bell at 100 ms');
    await started.advance(40);
    await started.advance(2000);
    expect(signalsOf(started.terminal.written)).toEqual([{ kind: 'bell' }]);
    expect(started.terminal.notifications).toEqual([]);
    started.app.unmount();
  });

  it.each(['auto', 'bell', 'off'] as const)('%s writes no signal when the terminal never reported the focus', async (notify) => {
    const started = await mount({ notify });
    await started.set({ working: true });
    await started.runEnded(DONE_32S);
    await started.advance(1000);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    started.app.unmount();
  });

  it('off writes no signal even with the focus out', async () => {
    const started = await mount({ notify: 'off' });
    started.terminal.emit(focus('out'));
    await started.set({ waiting: APPROVAL });
    await started.advance(1000);
    expect(signalsOf(started.terminal.written)).toEqual([]);
    started.app.unmount();
  });
});
