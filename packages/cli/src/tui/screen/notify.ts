import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { TUI_NOTIFY_MODES, defaultTuiSettings } from '@momonga/config';
import type { ResolvedTuiSettings, TuiNotify } from '@momonga/config';
import type { FocusEvent } from '../terminal/events.ts';
import path from 'node:path';
import { TITLE_BLINK_MS, notificationText, titleOf, titleStateOf } from '../terminal/title.ts';
import type { TitleState } from '../terminal/title.ts';
import type { ScreenTerminal } from './input.ts';
import { every } from './timers.ts';
import type { ScreenTimers } from './timers.ts';
import { SPINNER_MS } from '../terminal/marks.ts';

export const NOTIFY_MODES = TUI_NOTIFY_MODES;

export const NOTIFY_DELAY_MS = 100;

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

export type RunOutcome = { kind: 'done'; elapsedMs: number } | { kind: 'error'; reason: string | undefined };

export type WaitingNotice = { heading: string; namesFolder: boolean };

const firstLine = (text: string): string => text.split(/\r?\n|\r/u, 1)[0] ?? '';

const outcomeDetail = (outcome: RunOutcome): string => {
  if (outcome.kind === 'done') return `Run complete in ${Math.floor(outcome.elapsedMs / 1000)}s`;
  const reason = outcome.reason === undefined ? '' : firstLine(outcome.reason).trim();
  return reason === '' ? 'Run failed' : `Run failed: ${reason}`;
};

export const noticeOf = ({ state, cwd, outcome, waiting }: { state: TitleState; cwd: string; outcome: RunOutcome | undefined; waiting: WaitingNotice | undefined }): string | undefined => {
  const folder = path.basename(cwd);
  if (state === 'waiting for you') return waiting === undefined ? undefined : notificationText(waiting.heading, waiting.namesFolder ? undefined : folder);
  if (state === 'done' || state === 'error') return outcome?.kind === state ? notificationText(outcomeDetail(outcome), folder) : undefined;
  return undefined;
};

export type AttentionOptions = {
  terminal: Pick<ScreenTerminal, 'state' | 'setTitle' | 'bell' | 'desktopNotification' | 'enable' | 'disable' | 'input'>;
  cwd: string;
  working: boolean;
  waiting: WaitingNotice | undefined;
  notify: NotifyMode;
  attentionTerminal: AttentionTerminal;
  timers: ScreenTimers;
  reducedMotion: boolean;
};

export type Attention = { runEnded(outcome: RunOutcome | undefined): void };

const animationStepOf = (state: TitleState): number | undefined => {
  if (state === 'working') return SPINNER_MS;
  if (state === 'waiting for you') return TITLE_BLINK_MS;
  return undefined;
};

export const useAttention = ({ terminal, cwd, working, waiting, notify, attentionTerminal, timers, reducedMotion }: AttentionOptions): Attention => {
  const [lastRun, setLastRun] = useState<RunOutcome | undefined>(undefined);
  const lastFocus = useRef<FocusDirection | undefined>(undefined);
  const writtenTitle = useRef<string | undefined>(undefined);
  const pendingSignal = useRef<unknown>(undefined);
  const state = titleStateOf({ working, prompting: waiting !== undefined, lastRun: lastRun?.kind });
  const reportsFocus = notify !== 'off';

  const writeTitle = useEffectEvent((next: TitleState, step: number): void => {
    const title = titleOf({ cwd, state: next, step, reducedMotion });
    if (title === writtenTitle.current) return;
    writtenTitle.current = title;
    terminal.setTitle(title);
  });

  const signal = useEffectEvent((next: TitleState): void => {
    const due = signalDue({ notify, focus: lastFocus.current, state: next, osc9: attentionTerminal.osc9 });
    if (due === 'bell') terminal.bell();
    if (due !== 'notification') return;
    const text = noticeOf({ state: next, cwd, outcome: lastRun, waiting });
    if (text !== undefined) terminal.desktopNotification(text, { tmux: attentionTerminal.tmux });
  });

  const dropSignal = useEffectEvent((): void => {
    if (pendingSignal.current === undefined) return;
    timers.clearTimeout(pendingSignal.current);
    pendingSignal.current = undefined;
  });

  const scheduleSignal = useEffectEvent((next: TitleState): void => {
    if (signalDue({ notify, focus: lastFocus.current, state: next, osc9: attentionTerminal.osc9 }) === 'none') return;
    pendingSignal.current = timers.setTimeout(() => {
      pendingSignal.current = undefined;
      signal(next);
    }, NOTIFY_DELAY_MS);
  });

  useEffect(() => {
    writeTitle(state, 0);
    const animationMs = animationStepOf(state);
    if (animationMs === undefined || reducedMotion) return undefined;
    let step = 0;
    return every(timers, animationMs, () => {
      step += 1;
      writeTitle(state, step);
    });
  }, [state, reducedMotion, timers]);

  useEffect(() => {
    scheduleSignal(state);
    return () => dropSignal();
  }, [state]);

  useEffect(() => () => dropSignal(), [notify]);

  const clearError = useEffectEvent((): void => {
    if (lastRun?.kind !== 'error') return;
    dropSignal();
    setLastRun(undefined);
  });

  useEffect(
    () =>
      terminal.input.observe((event) => {
        if (event.type === 'focus') lastFocus.current = event.direction;
        if (event.type === 'focus' && event.direction === 'in') dropSignal();
        if (event.type === 'key') clearError();
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
