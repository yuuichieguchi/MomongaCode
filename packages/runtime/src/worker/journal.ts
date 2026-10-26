import type { RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import type { Claim, RuntimeStore } from '@momonga/store';

const SNAPSHOT_INTERVAL_EVENTS = 200;
const READ_CHUNK = 1000;

export type Journal = {
  readonly state: RunState;
  countRecorded(type: RunEventPayload['type']): number;
  append(payloads: readonly RunEventPayload[]): void;
  sync(): void;
  verifyLease(): void;
  snapshot(): void;
};

export type JournalOptions = {
  store: RuntimeStore;
  claim: Claim;
  lost(): never;
};

export const openJournal = ({ store, claim, lost }: JournalOptions): Journal => {
  const loaded = store.load(claim.runId);
  const run = store.getRun(claim.runId);
  if (run === undefined) throw new Error(`unknown run ${claim.runId}`);
  let state = loaded.tail.reduce(foldRunState, loaded.snapshot?.state ?? initialRunState({ runId: run.id, sessionId: run.sessionId }));
  let snapshotSeq = loaded.snapshot?.seq ?? 0;

  const sync = (): void => {
    for (;;) {
      const events = store.readRunEvents(claim.runId, state.lastSeq, READ_CHUNK);
      state = events.reduce(foldRunState, state);
      if (events.length < READ_CHUNK) return;
    }
  };

  const countRecorded = (type: RunEventPayload['type']): number => {
    let count = 0;
    for (let after = 0; ; ) {
      const events = store.readRunEvents(claim.runId, after, READ_CHUNK);
      for (const event of events) if (event.type === type) count += 1;
      const last = events.at(-1);
      if (last === undefined || events.length < READ_CHUNK) return count;
      after = last.seq;
    }
  };

  const snapshot = (): void => {
    const result = store.writeSnapshot(claim, state.lastSeq, state);
    if (result.kind === 'lease_lost') lost();
    if (result.kind === 'conflict') throw new Error(`snapshot of run ${claim.runId} at seq ${state.lastSeq} was refused: ${result.reason ?? 'conflict'}`);
    snapshotSeq = state.lastSeq;
  };

  return {
    get state() {
      return state;
    },
    countRecorded,
    sync,
    verifyLease: () => {
      if (store.append(claim, []).kind === 'lease_lost') lost();
    },
    append: (payloads) => {
      const result = store.append(claim, payloads);
      if (result.kind === 'lease_lost') lost();
      sync();
      if (state.lastSeq - snapshotSeq >= SNAPSHOT_INTERVAL_EVENTS) snapshot();
    },
    snapshot,
  };
};
