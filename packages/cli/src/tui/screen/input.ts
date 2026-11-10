import type { TerminalEvent } from '../terminal/events.ts';
import type { TerminalLayer } from '../terminal/layer.ts';

export type EventClaim = (event: TerminalEvent) => boolean;

export type ScreenInput = {
  push(events: readonly TerminalEvent[]): void;
  claim(handler: EventClaim): () => void;
};

export type ScreenTerminal = Pick<TerminalLayer, 'state' | 'subscribe' | 'subscribeScreen' | 'setScreen'> & { input: Pick<ScreenInput, 'claim'> };

export const createScreenInput = (forward: (events: readonly TerminalEvent[]) => void): ScreenInput => {
  const claims: EventClaim[] = [];
  return {
    push: (events) => {
      const unclaimed = events.filter((event) => !claims.some((claim) => claim(event)));
      if (unclaimed.length > 0) forward(unclaimed);
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
