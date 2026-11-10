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

export type FocusKnowledge = FocusDirection | 'unreported';

export const focusKnowledgeOf = (reportingEnabled: boolean, lastEvent: FocusDirection | undefined): FocusKnowledge => (reportingEnabled && lastEvent !== undefined ? lastEvent : 'unreported');

const NEEDS_THE_USER: ReadonlySet<TitleState> = new Set<TitleState>(['waiting for you', 'done', 'error']);

export const bellDue = ({ notify, focus, state }: { notify: NotifyMode; focus: FocusKnowledge; state: TitleState }): boolean => notify === 'bell' && focus !== 'in' && NEEDS_THE_USER.has(state);

export type AttentionOptions = {
  terminal: Pick<ScreenTerminal, 'state' | 'setTitle' | 'bell' | 'enable' | 'disable' | 'input'>;
  cwd: string;
  working: boolean;
  prompting: boolean;
  notify: NotifyMode;
};

export type Attention = { runEnded(end: RunEnd | undefined): void };

export const useAttention = ({ terminal, cwd, working, prompting, notify }: AttentionOptions): Attention => {
  const [lastRun, setLastRun] = useState<RunEnd | undefined>(undefined);
  const lastFocus = useRef<FocusDirection | undefined>(undefined);
  const state = titleStateOf({ working, prompting, lastRun });

  const announce = useEffectEvent((next: TitleState): void => {
    terminal.setTitle(titleOf(cwd, next));
    if (bellDue({ notify, focus: focusKnowledgeOf(terminal.state().enabled.includes('focus'), lastFocus.current), state: next })) terminal.bell();
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
    if (notify !== 'bell') return undefined;
    terminal.enable('focus');
    return () => {
      terminal.disable('focus');
      lastFocus.current = undefined;
    };
  }, [terminal, notify]);

  return { runEnded: setLastRun };
};
