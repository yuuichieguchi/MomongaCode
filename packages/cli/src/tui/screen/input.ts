import type { TerminalEvent } from '../terminal/events.ts';
import type { TerminalLayer } from '../terminal/layer.ts';

export type EventClaim = (event: TerminalEvent) => boolean;

export type EventObserver = (event: TerminalEvent) => void;

export const CLAIM_PRIORITY = ['chord', 'input-caret', 'agent-list', 'prompt-pointer', 'tool-view', 'transcript', 'typing', 'early'] as const;

export type ClaimPriority = (typeof CLAIM_PRIORITY)[number];

export type ScreenInput = {
  push(events: readonly TerminalEvent[]): void;
  claim(priority: ClaimPriority, handler: EventClaim): () => void;
  observe(observer: EventObserver): () => void;
  framed(): void;
  observeFrames(listener: () => void): () => void;
  arrived(): void;
  observeArrivals(listener: () => void): () => void;
};

export type ScreenTerminal = Pick<TerminalLayer, 'state' | 'subscribe' | 'subscribeScreen' | 'setScreen' | 'setTitle' | 'bell' | 'desktopNotification' | 'enable' | 'disable'> & { input: Pick<ScreenInput, 'claim' | 'observe' | 'observeFrames'> & Partial<Pick<ScreenInput, 'observeArrivals'>> };

export type ClaimTable = { claim(priority: ClaimPriority, handler: EventClaim): () => void; offer(event: TerminalEvent): boolean };

export const createClaimTable = (): ClaimTable => {
  const claims: { priority: ClaimPriority; handler: EventClaim }[] = [];
  return {
    claim: (priority, handler) => {
      const entry = { priority, handler };
      const rank = CLAIM_PRIORITY.indexOf(priority);
      const before = claims.findIndex((other) => CLAIM_PRIORITY.indexOf(other.priority) >= rank);
      claims.splice(before === -1 ? claims.length : before, 0, entry);
      return () => {
        const index = claims.indexOf(entry);
        if (index >= 0) claims.splice(index, 1);
      };
    },
    offer: (event) => [...claims].some((entry) => entry.handler(event)),
  };
};

export const createScreenInput = (): ScreenInput => {
  const claims = createClaimTable();
  const observers = new Set<EventObserver>();
  const frameListeners = new Set<() => void>();
  const arrivalListeners = new Set<() => void>();
  return {
    arrived: () => {
      for (const listener of [...arrivalListeners]) listener();
    },
    observeArrivals: (listener) => {
      arrivalListeners.add(listener);
      return () => {
        arrivalListeners.delete(listener);
      };
    },
    observe: (observer) => {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    push: (events) => {
      for (const event of events) for (const observer of [...observers]) observer(event);
      for (const event of events) claims.offer(event);
    },
    claim: claims.claim,
    framed: () => {
      for (const listener of [...frameListeners]) listener();
    },
    observeFrames: (listener) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
  };
};

export const untilNextKey = (input: Pick<ScreenInput, 'observe'>): AbortSignal => {
  const watch = new AbortController();
  const stop = input.observe((event) => {
    if (event.type !== 'key') return;
    stop();
    watch.abort();
  });
  return watch.signal;
};
