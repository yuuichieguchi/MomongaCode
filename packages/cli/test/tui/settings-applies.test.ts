import { describe, expect, it } from 'vitest';
import { SETTING_READ_POINTS } from '@momonga/config';
import { SETTING_ROWS, appliesNowOf } from '../../src/tui/settings-screen.tsx';

describe('the label "applies now" comes from the table of the readers (design-settings-live 3.3)', () => {
  it('labels a setting whose reader loads it per operation as applying now, and one read at the start of the screen as applying from the next session', () => {
    expect(appliesNowOf('verification.commands', SETTING_READ_POINTS)).toBe(true);
    expect(appliesNowOf('memory.forgetAfterDays', SETTING_READ_POINTS)).toBe(true);
    expect(appliesNowOf('network.httpsProxy', SETTING_READ_POINTS)).toBe(true);
    expect(appliesNowOf('tui.theme', SETTING_READ_POINTS)).toBe(true);
    expect(appliesNowOf('tui.mouse', SETTING_READ_POINTS)).toBe(false);
  });

  it('follows the table: a reader that moves to the start changes the label', () => {
    expect(appliesNowOf('verification.commands', { ...SETTING_READ_POINTS, verification: 'start' })).toBe(false);
  });

  it('has a read point for every setting the screen shows, and the screen holds no flag of its own', () => {
    for (const key of Object.keys(SETTING_ROWS)) expect(() => appliesNowOf(key, SETTING_READ_POINTS)).not.toThrow();
    for (const presentation of Object.values(SETTING_ROWS)) expect(presentation).not.toHaveProperty('appliesNow');
  });
});
