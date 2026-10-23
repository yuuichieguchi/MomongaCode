import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { immediateTx, migrate, openDatabase } from '@momonga/foundation';
import type { Migration } from '@momonga/foundation';
import type { InputItem, ItemField, StreamEvent, UsageReport, UsageSource } from '@momonga/protocol';
import type { StoredDataChecks } from './validation.ts';

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'gateway-core',
    sql: `
      CREATE TABLE responses (
        id TEXT PRIMARY KEY,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE idempotency (
        key TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        stored_at_ms INTEGER NOT NULL,
        frames_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE usage (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        response_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step INTEGER,
        target TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        usage_source TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX usage_by_run ON usage (run_id, seq);
    `,
  },
];

export type StoredResponse = { input: InputItem[]; output: ItemField[] };

export type StoredIdempotency = { digest: string; storedAtMs: number; frames: StreamEvent[] };

export type UsageRecord = {
  responseId: string;
  runId: string;
  step: number | null;
  target: string;
  inputTokens: number;
  outputTokens: number;
  usageSource: UsageSource;
};

export type CommitRequest = {
  recordedAtMs: number;
  idempotencyExpiredBeforeMs: number;
  response?: { id: string; input: InputItem[]; output: ItemField[] };
  idempotency?: { key: string; digest: string; frames: StreamEvent[] };
  usage?: UsageRecord;
};

export type GatewayStore = {
  getResponse(id: string): StoredResponse | undefined;
  getIdempotency(key: string): StoredIdempotency | undefined;
  deleteIdempotency(key: string): void;
  commit(request: CommitRequest): void;
  usageReport(runId: string): UsageReport;
  close(): void;
};

const requireString = (value: unknown, column: string): string => {
  if (typeof value !== 'string') throw new TypeError(`gateway database column ${column} is not text`);
  return value;
};

const requireNumber = (value: unknown, column: string): number => {
  if (typeof value !== 'number') throw new TypeError(`gateway database column ${column} is not an integer`);
  return value;
};

type RowLocation = { table: string; keyColumn: string; key: string; column: string };

const parseChecked = (json: string, location: RowLocation, check: (value: unknown) => string | undefined): unknown[] => {
  const where = `gateway database table ${location.table} (${location.keyColumn} ${location.key}) column ${location.column}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`${where} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  const problem = check(parsed);
  if (problem !== undefined || !Array.isArray(parsed)) throw new Error(`${where} failed validation: ${problem ?? 'is not an array'}`);
  return parsed;
};

const requireUsageSource = (value: unknown): UsageSource => {
  if (value !== 'reported' && value !== 'estimated') throw new TypeError('gateway database column usage_source is invalid');
  return value;
};

type Statements = {
  getResponse: StatementSync;
  putResponse: StatementSync;
  getIdempotency: StatementSync;
  putIdempotency: StatementSync;
  deleteIdempotency: StatementSync;
  pruneIdempotency: StatementSync;
  putUsage: StatementSync;
  usageForRun: StatementSync;
};

const prepare = (db: DatabaseSync): Statements => ({
  getResponse: db.prepare('SELECT input_json, output_json FROM responses WHERE id = ?'),
  putResponse: db.prepare('INSERT INTO responses (id, input_json, output_json, created_at_ms) VALUES (?, ?, ?, ?)'),
  getIdempotency: db.prepare('SELECT digest, stored_at_ms, frames_json FROM idempotency WHERE key = ?'),
  putIdempotency: db.prepare('INSERT OR REPLACE INTO idempotency (key, digest, stored_at_ms, frames_json) VALUES (?, ?, ?, ?)'),
  deleteIdempotency: db.prepare('DELETE FROM idempotency WHERE key = ?'),
  pruneIdempotency: db.prepare('DELETE FROM idempotency WHERE stored_at_ms <= ?'),
  putUsage: db.prepare(
    'INSERT INTO usage (response_id, run_id, step, target, input_tokens, output_tokens, total_tokens, usage_source, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ),
  usageForRun: db.prepare(
    'SELECT response_id, step, target, input_tokens, output_tokens, total_tokens, usage_source FROM usage WHERE run_id = ? ORDER BY seq',
  ),
});

const PRIVATE_DIRECTORY_MODE = 0o700;

export const openGatewayStore = (dbPath: string, checks: StoredDataChecks): GatewayStore => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const db = openDatabase(dbPath);
  try {
    migrate(db, MIGRATIONS);
    const statements = prepare(db);
    return {
      getResponse: (id) => {
        const row = statements.getResponse.get(id);
        if (row === undefined) return undefined;
        return {
          input: parseChecked(
            requireString(row['input_json'], 'input_json'),
            { table: 'responses', keyColumn: 'id', key: id, column: 'input_json' },
            checks.inputItems,
          ) as InputItem[],
          output: parseChecked(
            requireString(row['output_json'], 'output_json'),
            { table: 'responses', keyColumn: 'id', key: id, column: 'output_json' },
            checks.outputItems,
          ) as ItemField[],
        };
      },
      getIdempotency: (key) => {
        const row = statements.getIdempotency.get(key);
        if (row === undefined) return undefined;
        return {
          digest: requireString(row['digest'], 'digest'),
          storedAtMs: requireNumber(row['stored_at_ms'], 'stored_at_ms'),
          frames: parseChecked(
            requireString(row['frames_json'], 'frames_json'),
            { table: 'idempotency', keyColumn: 'key', key, column: 'frames_json' },
            checks.streamEvents,
          ) as StreamEvent[],
        };
      },
      deleteIdempotency: (key) => {
        statements.deleteIdempotency.run(key);
      },
      commit: (request) => {
        immediateTx(db, () => {
          statements.pruneIdempotency.run(request.idempotencyExpiredBeforeMs);
          if (request.response !== undefined) {
            const { id, input, output } = request.response;
            statements.putResponse.run(id, JSON.stringify(input), JSON.stringify(output), request.recordedAtMs);
          }
          if (request.idempotency !== undefined) {
            const { key, digest, frames } = request.idempotency;
            statements.putIdempotency.run(key, digest, request.recordedAtMs, JSON.stringify(frames));
          }
          if (request.usage !== undefined) {
            const usage = request.usage;
            statements.putUsage.run(
              usage.responseId,
              usage.runId,
              usage.step,
              usage.target,
              usage.inputTokens,
              usage.outputTokens,
              usage.inputTokens + usage.outputTokens,
              usage.usageSource,
              request.recordedAtMs,
            );
          }
        });
      },
      usageReport: (runId) => {
        const responses = statements.usageForRun.all(runId).map((row) => {
          const step = row['step'];
          return {
            response_id: requireString(row['response_id'], 'response_id'),
            step: step === null ? null : requireNumber(step, 'step'),
            target: requireString(row['target'], 'target'),
            input_tokens: requireNumber(row['input_tokens'], 'input_tokens'),
            output_tokens: requireNumber(row['output_tokens'], 'output_tokens'),
            total_tokens: requireNumber(row['total_tokens'], 'total_tokens'),
            usage_source: requireUsageSource(row['usage_source']),
          };
        });
        const byStep = new Map<number, { input_tokens: number; output_tokens: number; total_tokens: number }>();
        const total = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        for (const entry of responses) {
          total.input_tokens += entry.input_tokens;
          total.output_tokens += entry.output_tokens;
          total.total_tokens += entry.total_tokens;
          if (entry.step === null) continue;
          const bucket = byStep.get(entry.step) ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
          bucket.input_tokens += entry.input_tokens;
          bucket.output_tokens += entry.output_tokens;
          bucket.total_tokens += entry.total_tokens;
          byStep.set(entry.step, bucket);
        }
        const steps = [...byStep.entries()]
          .sort(([left], [right]) => left - right)
          .map(([step, sums]) => ({ step, ...sums }));
        return { run_id: runId, responses, steps, total };
      },
      close: () => {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
};
