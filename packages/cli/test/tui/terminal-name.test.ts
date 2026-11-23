import { describe, expect, it } from 'vitest';
import { TERMINAL_NAMES, insideTmux, showsOsc9Notifications, terminalNameOf } from '../../src/tui/terminal/terminal-name.ts';
import type { TerminalEnv } from '../../src/tui/terminal/terminal-name.ts';

describe('the terminal named by the environment', () => {
  it('is one of the five terminals that show OSC 9, or other', () => {
    expect(TERMINAL_NAMES).toEqual(['ghostty', 'iterm2', 'kitty', 'warp', 'wezterm', 'other']);
  });

  it.each([
    ['ghostty', 'ghostty'],
    ['iTerm.app', 'iterm2'],
    ['iTerm2', 'iterm2'],
    ['iterm', 'iterm2'],
    ['WarpTerminal', 'warp'],
    ['warp', 'warp'],
    ['WezTerm', 'wezterm'],
    ['kitty', 'kitty'],
    ['  Ghost-ty_. ', 'ghostty'],
    ['Apple_Terminal', 'other'],
    ['vscode', 'other'],
  ] as const)('reads TERM_PROGRAM=%j as %s', (value, name) => {
    expect(terminalNameOf({ TERM_PROGRAM: value })).toBe(name);
  });

  it('decides other from an unknown TERM_PROGRAM without reading the later probes', () => {
    expect(terminalNameOf({ TERM_PROGRAM: 'vscode', KITTY_WINDOW_ID: '1' })).toBe('other');
    expect(terminalNameOf({ TERM_PROGRAM: 'Apple_Terminal', GHOSTTY_RESOURCES_DIR: '/g', TERM: 'xterm-ghostty' })).toBe('other');
  });

  it.each(['tmux', 'TMUX', 'Tmux'])('skips TERM_PROGRAM=%s so the later probes decide', (value) => {
    expect(terminalNameOf({ TERM_PROGRAM: value, KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(terminalNameOf({ TERM_PROGRAM: value })).toBe('other');
  });

  it('does not trim TERM_PROGRAM before the tmux skip, so " tmux" decides other', () => {
    expect(terminalNameOf({ TERM_PROGRAM: ' tmux', KITTY_WINDOW_ID: '1' })).toBe('other');
  });

  it('keeps a tab inside TERM_PROGRAM, so "i\\tTerm" is other', () => {
    expect(terminalNameOf({ TERM_PROGRAM: 'i\tTerm' })).toBe('other');
  });

  it('removes inner spaces from TERM_PROGRAM', () => {
    expect(terminalNameOf({ TERM_PROGRAM: 'i Term 2' })).toBe('iterm2');
  });

  it('trims any whitespace at the ends of TERM_PROGRAM', () => {
    expect(terminalNameOf({ TERM_PROGRAM: '\tghostty\n' })).toBe('ghostty');
  });

  it('lower-cases only ASCII letters of TERM_PROGRAM, so the Kelvin sign is not k', () => {
    expect(terminalNameOf({ TERM_PROGRAM: 'Kitty' })).toBe('other');
  });

  it.each(['', '   '])('skips a blank TERM_PROGRAM %j so the later probes decide', (value) => {
    expect(terminalNameOf({ TERM_PROGRAM: value, WEZTERM_VERSION: '1' })).toBe('wezterm');
  });

  it('reads a non-blank GHOSTTY_RESOURCES_DIR as ghostty and skips a blank one', () => {
    expect(terminalNameOf({ GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources/ghostty' })).toBe('ghostty');
    expect(terminalNameOf({ GHOSTTY_RESOURCES_DIR: ' ', KITTY_WINDOW_ID: '1' })).toBe('kitty');
  });

  it('reads GHOSTTY_RESOURCES_DIR before WEZTERM_VERSION', () => {
    expect(terminalNameOf({ GHOSTTY_RESOURCES_DIR: '/g', WEZTERM_VERSION: '1' })).toBe('ghostty');
  });

  it('reads WEZTERM_VERSION as wezterm even when it is empty', () => {
    expect(terminalNameOf({ WEZTERM_VERSION: '20240203' })).toBe('wezterm');
    expect(terminalNameOf({ WEZTERM_VERSION: '' })).toBe('wezterm');
  });

  it('reads WEZTERM_VERSION before the iTerm2 variables', () => {
    expect(terminalNameOf({ WEZTERM_VERSION: '1', ITERM_SESSION_ID: 'w0t0p0' })).toBe('wezterm');
  });

  it.each(['ITERM_SESSION_ID', 'ITERM_PROFILE', 'ITERM_PROFILE_NAME'])('reads %s as iterm2', (name) => {
    expect(terminalNameOf({ [name]: 'x' })).toBe('iterm2');
  });

  it('reads the iTerm2 variables before the kitty ones', () => {
    expect(terminalNameOf({ ITERM_PROFILE: 'Default', KITTY_WINDOW_ID: '1' })).toBe('iterm2');
  });

  it('reads KITTY_WINDOW_ID, or a TERM that contains kitty, as kitty', () => {
    expect(terminalNameOf({ KITTY_WINDOW_ID: '3' })).toBe('kitty');
    expect(terminalNameOf({ TERM: 'xterm-kitty' })).toBe('kitty');
  });

  it('reads the kitty probe before the alacritty one', () => {
    expect(terminalNameOf({ KITTY_WINDOW_ID: '3', ALACRITTY_SOCKET: '/s' })).toBe('kitty');
  });

  it.each([
    [{ ALACRITTY_SOCKET: '/tmp/a.sock' }],
    [{ TERM: 'alacritty' }],
    [{ KONSOLE_VERSION: '230800' }],
    [{ GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/1' }],
    [{ VTE_VERSION: '7600' }],
    [{ WT_SESSION: 'abc' }],
  ] as const)('reads %j as other', (env) => {
    expect(terminalNameOf(env)).toBe('other');
  });

  it('decides other from ALACRITTY_SOCKET before TERM is read', () => {
    expect(terminalNameOf({ ALACRITTY_SOCKET: '/s', TERM: 'xterm-ghostty' })).toBe('other');
  });

  it.each([
    [{ KONSOLE_VERSION: '1', TERM: 'xterm-ghostty' }],
    [{ GNOME_TERMINAL_SCREEN: '1', TERM: 'wezterm' }],
    [{ VTE_VERSION: '1', TERM: 'xterm-ghostty' }],
    [{ WT_SESSION: '1', TERM: 'wezterm' }],
  ] as const)('decides other from %j before TERM is read', (env) => {
    expect(terminalNameOf(env)).toBe('other');
  });

  it.each([
    ['xterm-ghostty', 'ghostty'],
    ['wezterm', 'wezterm'],
    ['wezterm-mux', 'wezterm'],
    ['xterm-256color', 'other'],
  ] as const)('reads TERM=%s as %s when nothing else is set', (term, name) => {
    expect(terminalNameOf({ TERM: term })).toBe(name);
  });

  it('is other when nothing is set', () => {
    expect(terminalNameOf({})).toBe('other');
    expect(terminalNameOf({ TERM: '  ' })).toBe('other');
  });

  it('reads only the environment it is given', () => {
    const env: TerminalEnv = { TERM_PROGRAM: undefined, TERM: undefined };
    expect(terminalNameOf(env)).toBe('other');
  });
});

describe('the terminals that show an OSC 9 notification', () => {
  it.each([
    [{ TERM_PROGRAM: 'ghostty' }, true],
    [{ TERM_PROGRAM: 'iTerm.app' }, true],
    [{ KITTY_WINDOW_ID: '1' }, true],
    [{ TERM_PROGRAM: 'WarpTerminal' }, true],
    [{ WEZTERM_VERSION: '' }, true],
    [{ TERM_PROGRAM: 'Apple_Terminal' }, false],
    [{ VTE_VERSION: '7600' }, false],
    [{}, false],
  ] as const)('%j shows them: %s', (env, shows) => {
    expect(showsOsc9Notifications(env)).toBe(shows);
  });
});

describe('inside tmux', () => {
  it.each([
    [{ TMUX: '/tmp/tmux-501/default,1,0' }, true],
    [{ TMUX_PANE: '%1' }, true],
    [{ TMUX: '', TMUX_PANE: ' ' }, false],
    [{}, false],
    [{ TERM_PROGRAM: 'tmux' }, false],
  ] as const)('%j is inside tmux: %s', (env, inside) => {
    expect(insideTmux(env)).toBe(inside);
  });
});
