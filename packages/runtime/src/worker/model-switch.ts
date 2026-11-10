import type { RuntimeStore } from '@momonga/store';

export type ModelChainInput = {
  runId: string;
  sessionId: string;
  pinned: string;
  current: string;
};

export const modelChainReaches = (store: Pick<RuntimeStore, 'readRunEventsOfTypes' | 'readModelChanges'>, input: ModelChainInput): boolean => {
  if (input.pinned === input.current) return true;
  const firstStart = store.readRunEventsOfTypes(input.runId, ['run.started'])[0];
  if (firstStart === undefined) return false;
  let model = input.pinned;
  for (const event of store.readModelChanges(input.sessionId, firstStart.id)) {
    if (event.previousModel === model) model = event.model;
  }
  return model === input.current;
};
