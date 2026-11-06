import type { RunCallView, RunEvent, RunFactsRecord } from '@momonga/protocol';
import { foldFacts } from './fold-facts.ts';
import type { RunInfo } from './types.ts';

export type CallsFold = { add(event: RunEvent): void; finish(): RunCallView[] };

export const createCallsFold = (runId: string): CallsFold => {
  const calls = new Map<string, RunCallView>();
  const callOf = (callId: string): RunCallView => {
    const known = calls.get(callId);
    if (known !== undefined) return known;
    const created: RunCallView = { runId, callId, basis: null, sideEffect: null, asked: false };
    calls.set(callId, created);
    return created;
  };
  const add = (event: RunEvent): void => {
    switch (event.type) {
      case 'tool.call':
        callOf(event.callId).sideEffect = event.sideEffect ?? null;
        break;
      case 'tool.permission.requested':
        callOf(event.callId).asked = true;
        break;
      case 'tool.started':
        callOf(event.callId).basis = event.basis ?? null;
        break;
      default:
        break;
    }
  };
  return { add, finish: () => [...calls.values()] };
};

export const foldCalls = (events: readonly RunEvent[], runId: string): RunCallView[] => {
  const fold = createCallsFold(runId);
  for (const event of events) fold.add(event);
  return fold.finish();
};

export const foldRunRecord = (events: readonly RunEvent[], info: RunInfo): RunFactsRecord => ({
  facts: foldFacts(events, info),
  calls: foldCalls(events, info.runId),
});
