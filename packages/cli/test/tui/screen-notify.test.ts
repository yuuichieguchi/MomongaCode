import { describe, expect, it } from 'vitest';
import { NOTIFY_MODES, UNSTORED_TUI_SETTINGS, signalDue } from '../../src/tui/screen/notify.ts';
import { TITLE_STATES } from '../../src/tui/terminal/title.ts';

const FOCUSES = [undefined, 'in', 'out'] as const;
const OSC9 = [true, false] as const;
const NEEDS_THE_PERSON = ['waiting for you', 'done', 'error'] as const;

const everyCase = () => NOTIFY_MODES.flatMap((notify) => FOCUSES.flatMap((focus) => TITLE_STATES.flatMap((state) => OSC9.map((osc9) => ({ notify, focus, state, osc9 })))));

describe('the notification setting', () => {
  it('has the values auto, bell and off in that order, and auto is the value without a settings file', () => {
    expect(NOTIFY_MODES).toEqual(['auto', 'bell', 'off']);
    expect(UNSTORED_TUI_SETTINGS.initial).toEqual({ theme: 'auto', notify: 'auto', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true });
  });
});

describe('when a signal is due', () => {
  it('covers all 90 cases of setting, focus, state and terminal', () => {
    expect(everyCase()).toHaveLength(90);
  });

  it('OffIsSilent: off gives no signal in any case', () => {
    for (const given of everyCase().filter((one) => one.notify === 'off')) expect(signalDue(given), JSON.stringify(given)).toBe('none');
  });

  it('OnlyWhenReportedOut: no signal unless the last focus report was out, nor when nothing was reported', () => {
    for (const given of everyCase().filter((one) => one.focus !== 'out')) expect(signalDue(given), JSON.stringify(given)).toBe('none');
  });

  it('OnlyOnChangeToNeedsPerson: no signal for ready or working', () => {
    for (const given of everyCase().filter((one) => one.state === 'ready' || one.state === 'working')) expect(signalDue(given), JSON.stringify(given)).toBe('none');
  });

  it('SignalKind: bell rings for every state that needs the person when focus is out, on any terminal', () => {
    for (const state of NEEDS_THE_PERSON) for (const osc9 of OSC9) expect(signalDue({ notify: 'bell', focus: 'out', state, osc9 }), `${state} ${String(osc9)}`).toBe('bell');
  });

  it('SignalKind: auto sends a desktop notification on a terminal that shows OSC 9', () => {
    for (const state of NEEDS_THE_PERSON) expect(signalDue({ notify: 'auto', focus: 'out', state, osc9: true }), state).toBe('notification');
  });

  it('SignalKind: auto rings the bell on a terminal that does not show OSC 9', () => {
    for (const state of NEEDS_THE_PERSON) expect(signalDue({ notify: 'auto', focus: 'out', state, osc9: false }), state).toBe('bell');
  });

  it('gives a signal in exactly the 12 cases of setting on, focus out and a state that needs the person', () => {
    expect(everyCase().filter((given) => signalDue(given) !== 'none')).toHaveLength(12);
  });
});
