import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, openDatabase, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { RunState } from '@momonga/protocol';
import { createJournalReader, decodeRunState, encodeRunState } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { dbPathOf } from './helpers.ts';

const PAGE_EVENTS = 200;

export type EncodedRunState = {
  json(): Record<string, unknown>;
  mutate(expression: string): void;
  read(): RunState | undefined;
};

export const encodedRunState = (state: RunState): EncodedRunState => {
  let text = canonicalJson(encodeRunState(state));
  const db = new DatabaseSync(':memory:');
  return {
    json: () => JSON.parse(text) as Record<string, unknown>,
    mutate: (expression) => {
      const row = db.prepare(`SELECT ${expression} AS state_json FROM (SELECT :state AS state_json)`).get({ state: text });
      text = String(row?.['state_json']);
    },
    read: () => decodeRunState(state.runId, JSON.parse(text)),
  };
};

export const roundTripped = (state: RunState): RunState | undefined => encodedRunState(state).read();

export const foldedRunState = async (store: RuntimeStore, runId: string): Promise<RunState> => foldedRunStateAt(dbPathOf(store), runId);

export const foldedRunStateAt = async (dbPath: string, runId: string): Promise<RunState> => {
  const db = openDatabase(dbPath, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
  try {
    return (await createJournalReader(db).runState(runId, { pageEvents: PAGE_EVENTS, pause: async () => undefined })).state;
  } finally {
    db.close();
  }
};
