import type { RunState } from '@momonga/protocol';

export const ownEntries = (state: RunState): RunState['history'] => state.history.filter((entry) => entry.seq > state.taskSeq);
