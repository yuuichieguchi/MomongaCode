import type { ScreenTimers } from './timers.ts';

export type PromptIntent = 'enter' | 'choice' | 'text' | 'other';

export type PromptSource = 'key' | 'pointer';

export type PromptSettleView = { readonly settling: boolean; readonly underHands: boolean };

export type PromptGate = {
  keyPressed(): void;
  keyReleased(): void;
  show(id: string | undefined, draftHeld: boolean): void;
  view(id: string): PromptSettleView;
  takes(id: string, intent: PromptIntent, source: PromptSource): boolean;
  stop(): void;
};

export type PromptGateOptions = { timers: ScreenTimers; settleMs: number; onChange(): void };

type Shown = { id: string; underHands: boolean; settling: boolean; engaged: boolean };

const UNSEEN: PromptSettleView = { settling: true, underHands: false };

export const UNDER_HANDS_LINE = 'This appeared while you were typing: enter does not choose here, a number does.';

export const createPromptGate = ({ timers, settleMs, onChange }: PromptGateOptions): PromptGate => {
  let keysQuiet = true;
  let quietBeforeKey = true;
  let quietTimer: unknown;
  let windowTimer: unknown;
  let shown: Shown | undefined;

  const stopTimer = (timer: unknown): undefined => {
    if (timer !== undefined) timers.clearTimeout(timer);
    return undefined;
  };

  const endWindow = (): void => {
    windowTimer = stopTimer(windowTimer);
    if (shown === undefined || !shown.settling) return;
    shown.settling = false;
    onChange();
  };

  const startWindow = (): void => {
    windowTimer = stopTimer(windowTimer);
    windowTimer = timers.setTimeout(() => {
      windowTimer = undefined;
      endWindow();
    }, settleMs);
  };

  const keyEvent = (): void => {
    keysQuiet = false;
    quietTimer = stopTimer(quietTimer);
    quietTimer = timers.setTimeout(() => {
      quietTimer = undefined;
      keysQuiet = true;
    }, settleMs);
  };

  const calm = (source: PromptSource): boolean => (source === 'key' ? quietBeforeKey : keysQuiet);

  const engaged = (prompt: Shown, source: PromptSource): boolean => {
    prompt.engaged ||= calm(source);
    return prompt.engaged;
  };

  return {
    keyPressed: () => {
      quietBeforeKey = keysQuiet;
      keyEvent();
      if (shown?.settling === true) startWindow();
    },
    keyReleased: () => {
      keyEvent();
      endWindow();
    },
    show: (id, draftHeld) => {
      if (shown?.id === id) return;
      windowTimer = stopTimer(windowTimer);
      if (id === undefined) {
        shown = undefined;
        return;
      }
      shown = { id, underHands: draftHeld || !keysQuiet, settling: true, engaged: false };
      startWindow();
    },
    view: (id) => (shown?.id === id ? { settling: shown.settling, underHands: shown.underHands } : UNSEEN),
    takes: (id, intent, source) => {
      if (shown?.id !== id || shown.settling) return false;
      if (!shown.underHands) return true;
      if (intent === 'enter') return false;
      if (intent === 'choice') return calm(source);
      return intent === 'text' ? engaged(shown, source) : true;
    },
    stop: () => {
      quietTimer = stopTimer(quietTimer);
      windowTimer = stopTimer(windowTimer);
    },
  };
};
