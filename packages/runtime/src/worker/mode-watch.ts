import type { RuntimeStore } from '@momonga/store';

const PAGE = 200;

export type ModeWatch = { changed(): boolean };

export const watchMode = (store: Pick<RuntimeStore, 'readSessionEvents'>, sessionId: string, afterEventId: number): ModeWatch => {
  let cursor = afterEventId;
  return {
    changed: () => {
      let seen = false;
      for (;;) {
        const events = store.readSessionEvents(sessionId, cursor, PAGE);
        const last = events.at(-1);
        if (last === undefined) return seen;
        cursor = last.id;
        if (events.some((event) => event.type === 'mode.changed')) seen = true;
        if (events.length < PAGE) return seen;
      }
    },
  };
};
