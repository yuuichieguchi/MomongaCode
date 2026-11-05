import type { RunEvent } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';

const READ_CHUNK = 1000;

export const readAllRunEvents = (store: Pick<RuntimeStore, 'readRunEvents'>, runId: string): RunEvent[] => {
  const events: RunEvent[] = [];
  for (let after = 0; ; ) {
    const chunk = store.readRunEvents(runId, after, READ_CHUNK);
    events.push(...chunk);
    const last = chunk.at(-1);
    if (last === undefined || chunk.length < READ_CHUNK) return events;
    after = last.seq;
  }
};
