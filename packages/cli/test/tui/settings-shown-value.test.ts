import { describe, expect, it } from 'vitest';
import { shownValue } from '../../src/tui/settings-screen.tsx';

describe('the value a settings row shows', () => {
  it('shows each entry of a list by its name, a named object included', () => {
    expect(shownValue(['docs', { name: 'tracker', digest: 'a'.repeat(64) }])).toBe('docs, tracker');
  });

  it('counts the entries of a list whose entries have no name', () => {
    expect(shownValue([{ command: 'x' }, 'docs'])).toBe('2 entries');
  });
});
