import { describe, expect, it } from 'vitest';
import { SETTING_READ_POINTS, SETTING_READ_POINT_KINDS } from '@momonga/config';
import { APPLIES_NEXT_DAEMON_START, APPLIES_NEXT_SESSION, APPLIES_NOW, SETTING_ROWS, appliesLabelOf } from '../../src/tui/settings-screen.tsx';

describe('the label after a write comes from the table of the readers (design-settings-live 3.3)', () => {
  it('labels a setting read per operation as applying now, one read at the start of the terminal session as applying from the next session, and one a running daemon keeps as applying when the daemon next starts', () => {
    expect(appliesLabelOf('verification.commands', SETTING_READ_POINTS)).toBe(APPLIES_NOW);
    expect(appliesLabelOf('memory.forgetAfterDays', SETTING_READ_POINTS)).toBe(APPLIES_NOW);
    expect(appliesLabelOf('network.httpsProxy', SETTING_READ_POINTS)).toBe(APPLIES_NOW);
    expect(appliesLabelOf('tui.theme', SETTING_READ_POINTS)).toBe(APPLIES_NOW);
    expect(appliesLabelOf('context.compactAt', SETTING_READ_POINTS)).toBe(APPLIES_NOW);
    expect(appliesLabelOf('tui.mouse', SETTING_READ_POINTS)).toBe(APPLIES_NEXT_SESSION);
    expect(appliesLabelOf('daemon.startupStallMs', SETTING_READ_POINTS)).toBe(APPLIES_NEXT_DAEMON_START);
  });

  it('states the three kinds of read point with their labels', () => {
    expect(SETTING_READ_POINT_KINDS).toEqual(['operation', 'start', 'daemon-start']);
    expect(APPLIES_NEXT_DAEMON_START).toBe('applies when the daemon next starts');
  });

  it('follows the table: a reader that moves changes the label', () => {
    expect(appliesLabelOf('verification.commands', { ...SETTING_READ_POINTS, verification: 'start' })).toBe(APPLIES_NEXT_SESSION);
    expect(appliesLabelOf('verification.commands', { ...SETTING_READ_POINTS, verification: 'daemon-start' })).toBe(APPLIES_NEXT_DAEMON_START);
  });

  it('has a read point for every setting the screen shows, and the screen holds no flag of its own', () => {
    for (const key of Object.keys(SETTING_ROWS)) expect(() => appliesLabelOf(key, SETTING_READ_POINTS)).not.toThrow();
    for (const presentation of Object.values(SETTING_ROWS)) expect(presentation).not.toHaveProperty('appliesNow');
  });
});
