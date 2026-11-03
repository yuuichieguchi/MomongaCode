import type { RuntimeStore } from '@momonga/store';

export type AliasChainInput = {
  runId: string;
  sessionId: string;
  pinned: string;
  current: string;
};

export const aliasChainReaches = (store: Pick<RuntimeStore, 'readRunEventsOfTypes' | 'readModelChanges'>, input: AliasChainInput): boolean => {
  if (input.pinned === input.current) return true;
  const firstStart = store.readRunEventsOfTypes(input.runId, ['run.started'])[0];
  if (firstStart === undefined) return false;
  let alias = input.pinned;
  for (const event of store.readModelChanges(input.sessionId, firstStart.id)) {
    if (event.previousModelAlias === alias) alias = event.modelAlias;
  }
  return alias === input.current;
};
