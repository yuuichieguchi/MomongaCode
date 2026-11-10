import type { TerminalEvent } from '../terminal/events.ts';
import type { TerminalLayer } from '../terminal/layer.ts';

export type EventClaim = (event: TerminalEvent) => boolean;

export type EventObserver = (event: TerminalEvent) => void;

export type ScreenInput = {
  push(events: readonly TerminalEvent[]): void;
  claim(handler: EventClaim): () => void;
  observe(observer: EventObserver): () => void;
};

export type ScreenTerminal = Pick<TerminalLayer, 'state' | 'subscribe' | 'subscribeScreen' | 'setScreen' | 'setTitle' | 'bell' | 'enable' | 'disable'> & { input: Pick<ScreenInput, 'claim' | 'observe'> };

export const createScreenInput = (): ScreenInput => {
  const claims: EventClaim[] = [];
  const observers = new Set<EventObserver>();
  return {
    observe: (observer) => {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    push: (events) => {
      for (const event of events) for (const observer of [...observers]) observer(event);
      for (const event of events) claims.some((claim) => claim(event));
    },
    claim: (handler) => {
      claims.unshift(handler);
      return () => {
        const index = claims.indexOf(handler);
        if (index >= 0) claims.splice(index, 1);
      };
    },
  };
};
