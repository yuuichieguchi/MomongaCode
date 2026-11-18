import type { ScreenTimers } from './timers.ts';

export type PromptIntent = 'enter' | 'choice' | 'text' | 'other';

export type PromptSource = 'key' | 'pointer';

export type PromptSettleView = { readonly drawn: boolean; readonly settling: boolean; readonly underHands: boolean };

export type PromptGate = {
  keyPressed(): void;
  keyReleased(): void;
  keyConsumed(): void;
  show(id: string | undefined): void;
  rendered(id: string | undefined): void;
  framed(): void;
  typedAside(id: string): void;
  view(id: string): PromptSettleView;
  takes(id: string, intent: PromptIntent, source: PromptSource): boolean;
  stop(): void;
};

export type PromptGateOptions = { timers: ScreenTimers; settleMs: number; onChange(): void };

type Shown = { id: string; underHands: boolean; rendered: boolean; drawn: boolean; settling: boolean; pressedSinceDrawn: boolean; engaged: boolean };

const UNSEEN: PromptSettleView = { drawn: false, settling: true, underHands: false };

export const UNDER_HANDS_LINE = 'This appeared while you were typing: what you typed stays in your input; enter does not choose here, a number does.';

export const UNDER_HANDS_PAUSE_LINE = 'This appeared while you were typing: what you typed stays in your input; pause, then choose.';

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

  const putUnderHands = (prompt: Shown): void => {
    if (prompt.underHands) return;
    prompt.underHands = true;
    onChange();
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
      if (shown === undefined) return;
      if (!shown.drawn) {
        putUnderHands(shown);
        return;
      }
      shown.pressedSinceDrawn = true;
      if (shown.settling) startWindow();
    },
    keyReleased: () => {
      keyEvent();
      if (shown?.drawn === true && shown.pressedSinceDrawn) endWindow();
    },
    keyConsumed: () => {
      quietTimer = stopTimer(quietTimer);
      keysQuiet = true;
    },
    show: (id) => {
      if (shown?.id === id) return;
      windowTimer = stopTimer(windowTimer);
      if (id === undefined) {
        shown = undefined;
        return;
      }
      shown = { id, underHands: !keysQuiet, rendered: false, drawn: false, settling: true, pressedSinceDrawn: false, engaged: false };
    },
    rendered: (id) => {
      if (shown !== undefined && shown.id === id) shown.rendered = true;
    },
    framed: () => {
      if (shown === undefined || !shown.rendered || shown.drawn) return;
      shown.drawn = true;
      startWindow();
    },
    typedAside: (id) => {
      if (shown?.id === id) putUnderHands(shown);
    },
    view: (id) => (shown?.id === id ? { drawn: shown.drawn, settling: shown.settling, underHands: shown.underHands } : UNSEEN),
    takes: (id, intent, source) => {
      if (shown?.id !== id || !shown.drawn || shown.settling) return false;
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
