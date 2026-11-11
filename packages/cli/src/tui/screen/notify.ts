import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { TUI_NOTIFY_MODES, defaultTuiSettings } from '@momonga/config';
import type { ResolvedTuiSettings, TuiNotify } from '@momonga/config';
import type { FocusEvent } from '../terminal/events.ts';
import { titleOf, titleStateOf } from '../terminal/title.ts';
import type { RunEnd, TitleState } from '../terminal/title.ts';
import type { ScreenTerminal } from './input.ts';
import type { ScreenTimers } from './timers.ts';

export const FOCUS_REPORT_WAIT_MS = 1000;

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

export type FocusKnowledge = FocusDirection | 'unknown' | 'unreported';

export const focusKnowledgeOf = (reportingEnabled: boolean, lastEvent: FocusDirection | undefined, waitEnded: boolean): FocusKnowledge => {
  if (!reportingEnabled) return 'unreported';
  if (lastEvent !== undefined) return lastEvent;
  return waitEnded ? 'unreported' : 'unknown';
};

const NEEDS_THE_USER: ReadonlySet<TitleState> = new Set<TitleState>(['waiting for you', 'done', 'error']);

export const bellDue = ({ notify, focus, state }: { notify: NotifyMode; focus: FocusKnowledge; state: TitleState }): boolean => notify === 'bell' && focus !== 'in' && focus !== 'unknown' && NEEDS_THE_USER.has(state);

export type AttentionOptions = {
  terminal: Pick<ScreenTerminal, 'state' | 'setTitle' | 'bell' | 'enable' | 'disable' | 'input'>;
  cwd: string;
  working: boolean;
  prompting: boolean;
  notify: NotifyMode;
  timers: ScreenTimers;
};

export type Attention = { runEnded(end: RunEnd | undefined): void };

export const useAttention = ({ terminal, cwd, working, prompting, notify, timers }: AttentionOptions): Attention => {
  const [lastRun, setLastRun] = useState<RunEnd | undefined>(undefined);
  const lastFocus = useRef<FocusDirection | undefined>(undefined);
  const waitEnded = useRef(false);
  const heldBell = useRef<{ timer: unknown } | undefined>(undefined);
  const state = titleStateOf({ working, prompting, lastRun });

  const focusNow = (): FocusKnowledge => focusKnowledgeOf(terminal.state().enabled.includes('focus'), lastFocus.current, waitEnded.current);

  const dropHeldBell = (): void => {
    if (heldBell.current === undefined) return;
    timers.clearTimeout(heldBell.current.timer);
    heldBell.current = undefined;
  };

  const ringHeldBell = (): void => {
    dropHeldBell();
    terminal.bell();
  };

  const announce = useEffectEvent((next: TitleState): void => {
    terminal.setTitle(titleOf(cwd, next));
    const focus = focusNow();
    if (bellDue({ notify, focus, state: next })) terminal.bell();
    else if (notify === 'bell' && focus === 'unknown' && NEEDS_THE_USER.has(next) && heldBell.current === undefined) {
      heldBell.current = {
        timer: timers.setTimeout(() => {
          waitEnded.current = true;
          ringHeldBell();
        }, FOCUS_REPORT_WAIT_MS),
      };
    }
  });

  const focusReported = useEffectEvent((direction: FocusDirection): void => {
    lastFocus.current = direction;
    if (heldBell.current === undefined) return;
    if (direction === 'out') ringHeldBell();
    else dropHeldBell();
  });

  useEffect(() => {
    announce(state);
  }, [state]);

  useEffect(
    () =>
      terminal.input.observe((event) => {
        if (event.type === 'focus') focusReported(event.direction);
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
      waitEnded.current = false;
      dropHeldBell();
    };
  }, [terminal, notify]);

  return { runEnded: setLastRun };
};
