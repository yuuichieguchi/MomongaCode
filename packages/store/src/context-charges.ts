import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '@momonga/foundation';
import { CONTEXT_CHARGE_PURPOSES } from '@momonga/protocol';
import type { BilledDetail } from '@momonga/protocol';
import { expectOneOf, expectRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { ContextCharge, ContextChargeInput, ContextChargeStore } from './types.ts';

const decodeCharge = (row: Row): ContextCharge => {
  const identity = String(row['id']);
  const reader = readerFor('context_charges', identity, row);
  const detail = reader.nullableJson('detail_json');
  return {
    id: reader.number('id'),
    purpose: expectOneOf('context_charges', identity, 'purpose', CONTEXT_CHARGE_PURPOSES, reader.string('purpose')),
    runId: reader.nullableString('run_id'),
    project: reader.string('project'),
    model: reader.string('model'),
    inputTokens: reader.number('input_tokens'),
    outputTokens: reader.number('output_tokens'),
    totalTokens: reader.number('total_tokens'),
    createdAt: reader.number('created_at'),
    ...(detail === null ? {} : { detail: expectRecord('context_charges', identity, 'detail_json', detail) as BilledDetail }),
  };
};

export const createContextChargeStore = (db: DatabaseSync, clock: Clock): ContextChargeStore => {
  const insert = db.prepare(
    `INSERT INTO context_charges (purpose, run_id, project, model, input_tokens, output_tokens, total_tokens, created_at, detail_json)
     VALUES (:purpose, :runId, :project, :model, :inputTokens, :outputTokens, :totalTokens, :now, :detailJson)`,
  );
  const select = db.prepare('SELECT * FROM context_charges WHERE id = :id');
  return {
    record: (input: ContextChargeInput) => {
      expectOneOf('context_charges', 'new', 'purpose', CONTEXT_CHARGE_PURPOSES, input.purpose);
      const { detail, ...columns } = input;
      const { lastInsertRowid } = insert.run({ ...columns, now: clock.now(), detailJson: detail === undefined ? null : JSON.stringify(detail) });
      const row = select.get({ id: Number(lastInsertRowid) });
      if (row === undefined) throw new Error('a context charge vanished after it was recorded');
      return decodeCharge(row);
    },
    list: (filter = {}) => {
      if (filter.runIds?.length === 0) return [];
      const clauses: string[] = [];
      const params: Record<string, string> = {};
      if (filter.runIds !== undefined) {
        clauses.push(`run_id IN (${filter.runIds.map((_runId, index) => `:run${index}`).join(', ')})`);
        filter.runIds.forEach((runId, index) => void (params[`run${index}`] = runId));
      }
      if (filter.project !== undefined) {
        clauses.push('project = :project');
        params['project'] = filter.project;
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
      return db.prepare(`SELECT * FROM context_charges${where} ORDER BY id`).all(params).map(decodeCharge);
    },
  };
};
