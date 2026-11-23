export type TerminalEnv = Readonly<Record<string, string | undefined>>;

export const TERMINAL_NAMES = ['ghostty', 'iterm2', 'kitty', 'warp', 'wezterm', 'other'] as const;

export type TerminalName = (typeof TERMINAL_NAMES)[number];

const isSet = (env: TerminalEnv, name: string): boolean => env[name] !== undefined;

const nonBlank = (env: TerminalEnv, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
};

const TERM_PROGRAM_NAMES: Readonly<Record<string, TerminalName>> = {
  ghostty: 'ghostty',
  iterm: 'iterm2',
  iterm2: 'iterm2',
  itermapp: 'iterm2',
  warp: 'warp',
  warpterminal: 'warp',
  wezterm: 'wezterm',
  kitty: 'kitty',
};

const TERM_NAMES: Readonly<Record<string, TerminalName>> = {
  'xterm-ghostty': 'ghostty',
  wezterm: 'wezterm',
  'wezterm-mux': 'wezterm',
};

const asciiLowerCase = (value: string): string => value.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

const fromTermProgram = (env: TerminalEnv): TerminalName | undefined => {
  const value = nonBlank(env, 'TERM_PROGRAM');
  if (value === undefined || asciiLowerCase(value) === 'tmux') return undefined;
  return TERM_PROGRAM_NAMES[asciiLowerCase(value.trim().replaceAll(/[ \-_.]/gu, ''))] ?? 'other';
};

const named =
  (name: TerminalName, matches: (env: TerminalEnv) => boolean) =>
  (env: TerminalEnv): TerminalName | undefined =>
    matches(env) ? name : undefined;

const anySet =
  (...names: readonly string[]) =>
  (env: TerminalEnv): boolean =>
    names.some((name) => isSet(env, name));

const fromTerm = (env: TerminalEnv): TerminalName | undefined => {
  const term = nonBlank(env, 'TERM');
  return term === undefined ? undefined : (TERM_NAMES[term] ?? 'other');
};

const PROBES: readonly ((env: TerminalEnv) => TerminalName | undefined)[] = [
  fromTermProgram,
  named('ghostty', (env) => nonBlank(env, 'GHOSTTY_RESOURCES_DIR') !== undefined),
  named('wezterm', anySet('WEZTERM_VERSION')),
  named('iterm2', anySet('ITERM_SESSION_ID', 'ITERM_PROFILE', 'ITERM_PROFILE_NAME')),
  named('kitty', (env) => isSet(env, 'KITTY_WINDOW_ID') || (env['TERM'] ?? '').includes('kitty')),
  named('other', (env) => isSet(env, 'ALACRITTY_SOCKET') || env['TERM'] === 'alacritty'),
  named('other', anySet('KONSOLE_VERSION', 'GNOME_TERMINAL_SCREEN', 'VTE_VERSION', 'WT_SESSION')),
  fromTerm,
];

export const terminalNameOf = (env: TerminalEnv): TerminalName => {
  for (const probe of PROBES) {
    const name = probe(env);
    if (name !== undefined) return name;
  }
  return 'other';
};

export const showsOsc9Notifications = (env: TerminalEnv): boolean => terminalNameOf(env) !== 'other';

export const insideTmux = (env: TerminalEnv): boolean => nonBlank(env, 'TMUX') !== undefined || nonBlank(env, 'TMUX_PANE') !== undefined;
