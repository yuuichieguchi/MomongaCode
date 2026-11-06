import type { DatabaseSync } from 'node:sqlite';
import { readTx } from '@momonga/foundation/sqlite';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { decodeRunEvents } from './codec.ts';
import type { Row } from './rows.ts';

export const RECORD_RANGE_ROWS = 1000;

export type WalkUnits = {
  pause: () => Promise<void>;
  stop: () => boolean;
};

export type RecordVisit = (event: RunEvent) => void | Promise<void>;

export type WalkHooks = {
  unit: () => void;
  stepped: (rows: number) => void;
  onDecode?: (rows: number, bytes: number) => void;
};

export type WalkRange = { skipSeq?: number; from?: number };

export type RecordWalker = {
  walk(runId: string, bound: number, types: readonly RunEventPayload['type'][], visit: RecordVisit, units: WalkUnits, range?: WalkRange): Promise<void>;
};

export const createRecordWalker = (db: DatabaseSync, hooks: WalkHooks): RecordWalker => {
  const statements = new Map<number, ReturnType<DatabaseSync['prepare']>>();
  const statementFor = (count: number): ReturnType<DatabaseSync['prepare']> => {
    const known = statements.get(count);
    if (known !== undefined) return known;
    const list = Array.from({ length: count }, (_unused, index) => `:type${index}`).join(', ');
    const prepared = db.prepare(`SELECT * FROM events WHERE run_id = :runId AND type IN (${list}) AND seq >= :from AND seq < :until`);
    statements.set(count, prepared);
    return prepared;
  };

  const decode = (row: Row): RunEvent => {
    hooks.onDecode?.(1, typeof row['payload_json'] === 'string' ? Buffer.byteLength(row['payload_json']) : 0);
    const [event] = decodeRunEvents([row]);
    if (event === undefined) throw new Error('a journal row did not decode to an event');
    return event;
  };

  const walk: RecordWalker['walk'] = async (runId, bound, types, visit, units, range = {}) => {
    const { skipSeq, from: start = 1 } = range;
    if (types.length === 0) return;
    const typeBinds = Object.fromEntries(types.map((type, index) => [`type${index}`, type]));
    const statement = statementFor(types.length);
    for (let from = start; from <= bound && !units.stop(); from += RECORD_RANGE_ROWS) {
      const until = Math.min(from + RECORD_RANGE_ROWS, bound + 1);
      const rows = readTx(db, () => statement.all({ runId, from, until, ...typeBinds })).sort((a, b) => Number(a['seq']) - Number(b['seq']));
      let consumed = until - from;
      for (const row of rows) {
        if (units.stop()) {
          consumed = Number(row['seq']) - from;
          break;
        }
        if (skipSeq !== undefined && Number(row['seq']) === skipSeq) continue;
        const pending = visit(decode(row));
        if (pending !== undefined) await pending;
        hooks.unit();
      }
      hooks.stepped(consumed);
      hooks.unit();
      await units.pause();
    }
  };

  return { walk };
};
