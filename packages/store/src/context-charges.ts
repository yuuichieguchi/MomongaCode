import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { CONTEXT_CHARGE_PURPOSES } from '@momonga/protocol';
import type { BilledDetail } from '@momonga/protocol';
import { expectOneOf, expectRecord, readerFor, storedOneOf } from './rows.ts';
import type { DecodeContext } from './decode-context.ts';
import type { Row } from './rows.ts';
import type { ContextCharge, ContextChargeInput, ContextChargeStore } from './types.ts';

const decodeCharge = (row: Row, context: DecodeContext): ContextCharge => {
  const identity = String(row['id']);
  const reader = readerFor('context_charges', identity, row);
  const detail = reader.nullableJson('detail_json');
  return {
    id: reader.number('id'),
    purpose: storedOneOf(context, 'context_charges', identity, 'purpose', CONTEXT_CHARGE_PURPOSES, reader.string('purpose')),
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

export class DuplicateChargeError extends Error {
  readonly responseId: string;

  constructor(responseId: string, options?: ErrorOptions) {
    super(`the response ${responseId} is already charged with different fields, so the call is not charged twice`, options);
    this.name = 'DuplicateChargeError';
    this.responseId = responseId;
  }
}

const SQLITE_CONSTRAINT_UNIQUE = 2067;

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === SQLITE_CONSTRAINT_UNIQUE;

const billedFieldsOf = (input: ContextChargeInput | ContextCharge): string => {
  const { timing: _timing, ...detail } = input.detail ?? {};
  return canonicalJson({
    purpose: input.purpose,
    runId: input.runId,
    project: input.project,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.totalTokens,
    detail,
  });
};

export const createContextChargeStore = (db: DatabaseSync, clock: Clock, context: DecodeContext): ContextChargeStore => {
  const insert = db.prepare(
    `INSERT INTO context_charges (purpose, run_id, project, model, input_tokens, output_tokens, total_tokens, created_at, detail_json)
     VALUES (:purpose, :runId, :project, :model, :inputTokens, :outputTokens, :totalTokens, :now, :detailJson)`,
  );
  const select = db.prepare('SELECT * FROM context_charges WHERE id = :id');
  const selectByResponse = db.prepare("SELECT * FROM context_charges WHERE json_extract(detail_json, '$.responseId') = :responseId");
  return {
    record: (input: ContextChargeInput) => {
      expectOneOf('context_charges', 'new', 'purpose', CONTEXT_CHARGE_PURPOSES, input.purpose);
      const { detail, ...columns } = input;
      let lastInsertRowid: number | bigint;
      try {
        ({ lastInsertRowid } = insert.run({ ...columns, now: clock.now(), detailJson: detail === undefined ? null : JSON.stringify(detail) }));
      } catch (error) {
        if (detail?.responseId === undefined || !isUniqueViolation(error)) throw error;
        const row = selectByResponse.get({ responseId: detail.responseId });
        if (row === undefined) throw error;
        const stored = decodeCharge(row, context);
        if (billedFieldsOf(stored) !== billedFieldsOf(input)) throw new DuplicateChargeError(detail.responseId, { cause: error });
        return stored;
      }
      const row = select.get({ id: Number(lastInsertRowid) });
      if (row === undefined) throw new Error('a context charge vanished after it was recorded');
      return decodeCharge(row, context);
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
      return db.prepare(`SELECT * FROM context_charges${where} ORDER BY id`).all(params).map((row) => decodeCharge(row, context));
    },
  };
};
