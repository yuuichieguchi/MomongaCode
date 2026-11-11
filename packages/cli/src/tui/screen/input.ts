import type { TerminalEvent } from '../terminal/events.ts';
import type { TerminalLayer } from '../terminal/layer.ts';

export type EventClaim = (event: TerminalEvent) => boolean;

export type EventObserver = (event: TerminalEvent) => void;

export const CLAIM_PRIORITY = ['chord', 'input-caret', 'prompt-pointer', 'tool-view', 'transcript', 'typing'] as const;

export type ClaimPriority = (typeof CLAIM_PRIORITY)[number];

export type ScreenInput = {
  push(events: readonly TerminalEvent[]): void;
  claim(priority: ClaimPriority, handler: EventClaim): () => void;
  observe(observer: EventObserver): () => void;
};

export type ScreenTerminal = Pick<TerminalLayer, 'state' | 'subscribe' | 'subscribeScreen' | 'setScreen' | 'setTitle' | 'bell' | 'enable' | 'disable'> & { input: Pick<ScreenInput, 'claim' | 'observe'> };

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
  return {
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
  };
};
