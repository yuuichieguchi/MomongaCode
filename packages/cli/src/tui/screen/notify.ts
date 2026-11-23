import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { TUI_NOTIFY_MODES, defaultTuiSettings } from '@momonga/config';
import type { ResolvedTuiSettings, TuiNotify } from '@momonga/config';
import type { FocusEvent } from '../terminal/events.ts';
import { titleOf, titleStateOf } from '../terminal/title.ts';
import type { RunEnd, TitleState } from '../terminal/title.ts';
import type { ScreenTerminal } from './input.ts';

export const NOTIFY_MODES = TUI_NOTIFY_MODES;

export type NotifyMode = TuiNotify;

export type TuiSettingsPort = {
  readonly initial: ResolvedTuiSettings;
  save<Name extends keyof ResolvedTuiSettings>(name: Name, value: ResolvedTuiSettings[Name], signal: AbortSignal): Promise<void>;
};

export const UNSTORED_TUI_SETTINGS: TuiSettingsPort = {
  initial: defaultTuiSettings(),
  save() {
    return Promise.reject(new Error('the settings file is not available in this interface'));
  },
};

export type FocusDirection = FocusEvent['direction'];

const NEEDS_THE_USER: ReadonlySet<TitleState> = new Set<TitleState>(['waiting for you', 'done', 'error']);

export type AttentionTerminal = { osc9: boolean; tmux: boolean };

export const signalDue = ({ notify, focus, state, osc9 }: { notify: NotifyMode; focus: FocusDirection | undefined; state: TitleState; osc9: boolean }): 'none' | 'bell' | 'notification' => {
  if (notify === 'off' || focus !== 'out' || !NEEDS_THE_USER.has(state)) return 'none';
  return notify === 'auto' && osc9 ? 'notification' : 'bell';
};

export type AttentionOptions = {
  terminal: Pick<ScreenTerminal, 'state' | 'setTitle' | 'bell' | 'desktopNotification' | 'enable' | 'disable' | 'input'>;
  cwd: string;
  working: boolean;
  prompting: boolean;
  notify: NotifyMode;
  attentionTerminal: AttentionTerminal;
};

export type Attention = { runEnded(end: RunEnd | undefined): void };

export const useAttention = ({ terminal, cwd, working, prompting, notify, attentionTerminal }: AttentionOptions): Attention => {
  const [lastRun, setLastRun] = useState<RunEnd | undefined>(undefined);
  const lastFocus = useRef<FocusDirection | undefined>(undefined);
  const state = titleStateOf({ working, prompting, lastRun });
  const reportsFocus = notify !== 'off';

  const announce = useEffectEvent((next: TitleState): void => {
    const title = titleOf(cwd, next);
    terminal.setTitle(title);
    const signal = signalDue({ notify, focus: lastFocus.current, state: next, osc9: attentionTerminal.osc9 });
    if (signal === 'bell') terminal.bell();
    if (signal === 'notification') terminal.desktopNotification(title, { tmux: attentionTerminal.tmux });
  });

  useEffect(() => {
    announce(state);
  }, [state]);

  useEffect(
    () =>
      terminal.input.observe((event) => {
        if (event.type === 'focus') lastFocus.current = event.direction;
        if (event.type === 'key') setLastRun((end) => (end === 'error' ? undefined : end));
      }),
    [terminal],
  );

  useEffect(() => {
    if (!reportsFocus) {
      if (terminal.state().enabled.includes('focus')) terminal.disable('focus');
      return undefined;
    }
    terminal.enable('focus');
    return () => {
      terminal.disable('focus');
      lastFocus.current = undefined;
    };
  }, [terminal, reportsFocus]);

  return { runEnded: setLastRun };
};
