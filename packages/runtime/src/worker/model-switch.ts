import type { RuntimeStore } from '@momonga/store';

const PAGE = 500;

export type AliasChainInput = {
  runId: string;
  sessionId: string;
  pinned: string;
  current: string;
};

export const aliasChainReaches = (store: Pick<RuntimeStore, 'readRunEventsOfTypes' | 'readSessionEvents'>, input: AliasChainInput): boolean => {
  if (input.pinned === input.current) return true;
  const firstStart = store.readRunEventsOfTypes(input.runId, ['run.started'])[0];
  if (firstStart === undefined) return false;
  let alias = input.pinned;
  let after = firstStart.id;
  for (;;) {
    const page = store.readSessionEvents(input.sessionId, after, PAGE);
    for (const event of page) {
      if (event.type === 'model.changed' && event.previousModelAlias === alias) alias = event.modelAlias;
    }
    const last = page.at(-1);
    if (last === undefined || page.length < PAGE) break;
    after = last.id;
  }
  return alias === input.current;
};
