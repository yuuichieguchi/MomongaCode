import { describe, expect, it, vi } from 'vitest';
import { shortenHome } from '../src/tui/startup.tsx';
import { startupCases } from './tui-startup-cases.tsx';

vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

startupCases('set');

describe('shortenHome', () => {
  it('abbreviates the home folder and what is below it and leaves other folders alone', () => {
    expect(shortenHome('/Users/ada', '/Users/ada')).toBe('~');
    expect(shortenHome('/Users/ada/src/x', '/Users/ada')).toBe('~/src/x');
    expect(shortenHome('/Users/adam/src', '/Users/ada')).toBe('/Users/adam/src');
    expect(shortenHome('/srv/app', '/Users/ada')).toBe('/srv/app');
  });
});
