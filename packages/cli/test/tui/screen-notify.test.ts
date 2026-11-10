import { describe, expect, it } from 'vitest';
import { NOTIFY_MODES, UNSTORED_TUI_SETTINGS, bellDue, focusKnowledgeOf } from '../../src/tui/screen/notify.ts';
import { TITLE_STATES } from '../../src/tui/terminal/title.ts';

describe('what is known of the focus', () => {
  it('is what the terminal last reported while focus reporting is on', () => {
    expect(focusKnowledgeOf(true, 'in')).toBe('in');
    expect(focusKnowledgeOf(true, 'out')).toBe('out');
  });

  it('is unreported while focus reporting is off or the terminal has reported nothing', () => {
    expect(focusKnowledgeOf(false, undefined)).toBe('unreported');
    expect(focusKnowledgeOf(false, 'in')).toBe('unreported');
    expect(focusKnowledgeOf(true, undefined)).toBe('unreported');
  });
});

describe('when the bell is due', () => {
  it('has the two values off and bell, and off is the value without a settings file', () => {
    expect(NOTIFY_MODES).toEqual(['off', 'bell']);
    expect(UNSTORED_TUI_SETTINGS.initial).toEqual({ theme: 'auto', notify: 'off' });
  });

  it('never rings while the switch is off', () => {
    for (const state of TITLE_STATES) for (const focus of ['in', 'out', 'unreported'] as const) expect(bellDue({ notify: 'off', focus, state })).toBe(false);
  });

  it.each(['out', 'unreported'] as const)('rings for a run that ended and for a prompt that needs the user when the focus is %s', (focus) => {
    expect(TITLE_STATES.filter((state) => bellDue({ notify: 'bell', focus, state }))).toEqual(['waiting for you', 'done', 'error']);
  });

  it('never rings while the terminal reports that it has the focus', () => {
    for (const state of TITLE_STATES) expect(bellDue({ notify: 'bell', focus: 'in', state })).toBe(false);
  });
});
