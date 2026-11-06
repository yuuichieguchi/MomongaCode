import type { PublicRunEvent, RunEvent } from '@momonga/protocol';

type CompletedEvent = Extract<RunEvent, { type: 'tool.completed' }> | Extract<PublicRunEvent, { type: 'tool.completed' }>;

export type CallRunTracker = {
  observe(event: RunEvent | PublicRunEvent): void;
  started(callId: string): boolean;
  ran(completed: CompletedEvent): boolean;
};

export const createCallRunTracker = (): CallRunTracker => {
  const startedCalls = new Set<string>();
  const started = (callId: string): boolean => startedCalls.has(callId);
  return {
    observe: (event) => {
      if (event.type === 'tool.started') startedCalls.add(event.callId);
    },
    started,
    ran: (completed) => started(completed.callId) && completed.denial === undefined,
  };
};
