import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { AttributeValue } from '@opentelemetry/api';
import { immediateTx, migrate, openDatabase, isRecord } from '@momonga/foundation';
import type { Clock, Migration } from '@momonga/foundation';
import { reportError } from './errors.ts';
import { UNKNOWN_BILLING } from './semconv.ts';

export const SPAN_KINDS = ['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'] as const;
export const SPAN_STATUSES = ['UNSET', 'OK', 'ERROR'] as const;
export const BODY_KINDS = ['input', 'output', 'tool_arguments', 'tool_result'] as const;

export type SpanKindName = (typeof SPAN_KINDS)[number];
export type SpanStatusName = (typeof SPAN_STATUSES)[number];
export type BodyKind = (typeof BODY_KINDS)[number];

export type SpanEventRecord = {
  name: string;
  timeMs: number;
  attributes: Record<string, AttributeValue>;
};

export type SpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKindName;
  startMs: number;
  endMs: number;
  status: SpanStatusName;
  attributes: Record<string, AttributeValue>;
  events: SpanEventRecord[];
  runId: string | null;
};

export type BodyRecord = {
  traceId: string;
  spanId: string;
  kind: BodyKind;
  content: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type TraceStore = {
  writeSpans(records: readonly SpanRecord[], bodies?: readonly BodyRecord[]): void;
  spansForRun(runId: string): SpanRecord[];
  spansWithoutRun(): SpanRecord[];
  spansForTrace(traceId: string): SpanRecord[];
  bodiesForSpan(spanId: string): BodyRecord[];
  purgeBodies(nowMs: number): number;
  purgeExpired(): number;
  compact(): void;
  close(): void;
};

export type OpenTraceStoreOptions = { path: string; clock: Clock };

const INITIAL_SCHEMA = `
CREATE TABLE spans (
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER')),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('UNSET', 'OK', 'ERROR')),
  attributes_json TEXT NOT NULL,
  events_json TEXT NOT NULL,
  run_id TEXT,
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX spans_by_run ON spans (run_id, start_ms);

CREATE TABLE bodies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('input', 'output', 'tool_arguments', 'tool_result')),
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX bodies_by_span ON bodies (span_id, id);
CREATE INDEX bodies_by_expiry ON bodies (expires_at_ms);
`;

const RECORD_BILLING_OF_EARLIER_CHAT_SPANS = `
UPDATE spans
SET attributes_json = json_set(attributes_json, '$."momonga.billing"', '${UNKNOWN_BILLING}')
WHERE json_extract(attributes_json, '$."gen_ai.operation.name"') = 'chat'
  AND json_extract(attributes_json, '$."momonga.billing"') IS NULL;
`;

export const TRACE_STORE_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: INITIAL_SCHEMA },
  { version: 2, name: 'chat-span-billing', sql: RECORD_BILLING_OF_EARLIER_CHAT_SPANS },
];

type Row = Record<string, SQLOutputValue>;

const corrupt = (table: string, identity: string, detail: string): Error =>
  new Error(`database row ${table}[${identity}] is corrupt: ${detail}`);

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const isAttributeValue = (value: unknown): value is AttributeValue =>
  isScalar(value) || (Array.isArray(value) && value.every((element) => element === null || isScalar(element)));

const readText = (table: string, identity: string, row: Row, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string') throw corrupt(table, identity, `column ${column} must be TEXT, got ${typeof value}`);
  return value;
};

const readNullableText = (table: string, identity: string, row: Row, column: string): string | null =>
  row[column] === null ? null : readText(table, identity, row, column);

const readInteger = (table: string, identity: string, row: Row, column: string): number => {
  const value = row[column];
  if (typeof value !== 'number') throw corrupt(table, identity, `column ${column} must be INTEGER, got ${typeof value}`);
  return value;
};

const readOneOf = <T extends string>(
  table: string,
  identity: string,
  row: Row,
  column: string,
  allowed: readonly T[],
): T => {
  const text = readText(table, identity, row, column);
  const match = allowed.find((candidate) => candidate === text);
  if (match === undefined) throw corrupt(table, identity, `column ${column} has unexpected value "${text}"`);
  return match;
};

const parseJson = (table: string, identity: string, column: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw corrupt(table, identity, `column ${column} is not valid JSON (${(error as Error).message})`);
  }
};

const toAttributes = (
  table: string,
  identity: string,
  column: string,
  value: unknown,
): Record<string, AttributeValue> => {
  if (!isRecord(value)) throw corrupt(table, identity, `column ${column} must be a JSON object`);
  const attributes: Record<string, AttributeValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isAttributeValue(entry)) throw corrupt(table, identity, `column ${column} key ${key} is not an attribute value`);
    attributes[key] = entry;
  }
  return attributes;
};

const toEvents = (table: string, identity: string, column: string, value: unknown): SpanEventRecord[] => {
  if (!Array.isArray(value)) throw corrupt(table, identity, `column ${column} must be a JSON array`);
  return value.map((entry: unknown, index) => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['timeMs'] !== 'number') {
      throw corrupt(table, identity, `column ${column}[${index}] must have a string name and a numeric timeMs`);
    }
    return {
      name: entry['name'],
      timeMs: entry['timeMs'],
      attributes: toAttributes(table, identity, `${column}[${index}].attributes`, entry['attributes']),
    };
  });
};

const decodeSpan = (row: Row): SpanRecord => {
  const table = 'spans';
  const identity = `${String(row['trace_id'])}/${String(row['span_id'])}`;
  return {
    traceId: readText(table, identity, row, 'trace_id'),
    spanId: readText(table, identity, row, 'span_id'),
    parentSpanId: readNullableText(table, identity, row, 'parent_span_id'),
    name: readText(table, identity, row, 'name'),
    kind: readOneOf(table, identity, row, 'kind', SPAN_KINDS),
    startMs: readInteger(table, identity, row, 'start_ms'),
    endMs: readInteger(table, identity, row, 'end_ms'),
    status: readOneOf(table, identity, row, 'status', SPAN_STATUSES),
    attributes: toAttributes(
      table,
      identity,
      'attributes_json',
      parseJson(table, identity, 'attributes_json', readText(table, identity, row, 'attributes_json')),
    ),
    events: toEvents(
      table,
      identity,
      'events_json',
      parseJson(table, identity, 'events_json', readText(table, identity, row, 'events_json')),
    ),
    runId: readNullableText(table, identity, row, 'run_id'),
  };
};

const decodeBody = (row: Row): BodyRecord => {
  const table = 'bodies';
  const identity = String(row['id']);
  return {
    traceId: readText(table, identity, row, 'trace_id'),
    spanId: readText(table, identity, row, 'span_id'),
    kind: readOneOf(table, identity, row, 'kind', BODY_KINDS),
    content: readText(table, identity, row, 'content'),
    createdAtMs: readInteger(table, identity, row, 'created_at_ms'),
    expiresAtMs: readInteger(table, identity, row, 'expires_at_ms'),
  };
};

const prepareStatements = (db: DatabaseSync) => ({
  insertSpan: db.prepare(
    `INSERT INTO spans (
       trace_id, span_id, parent_span_id, name, kind, start_ms, end_ms, status, attributes_json, events_json, run_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (trace_id, span_id) DO NOTHING`,
  ),
  insertBody: db.prepare(
    `INSERT INTO bodies (trace_id, span_id, kind, content, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  ),
  spansForRun: db.prepare('SELECT * FROM spans WHERE run_id = ? ORDER BY start_ms, end_ms DESC, rowid'),
  spansWithoutRun: db.prepare('SELECT * FROM spans WHERE run_id IS NULL ORDER BY start_ms, end_ms DESC, rowid'),
  spansForTrace: db.prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ms, end_ms DESC, rowid'),
  bodiesForSpan: db.prepare('SELECT * FROM bodies WHERE span_id = ? AND expires_at_ms > ? ORDER BY id'),
  purgeBodies: db.prepare('DELETE FROM bodies WHERE expires_at_ms <= ?'),
  checkpointPassive: db.prepare('PRAGMA wal_checkpoint(PASSIVE)'),
  checkpointTruncate: db.prepare('PRAGMA wal_checkpoint(TRUNCATE)'),
});

const all = (statement: StatementSync, ...parameters: Array<string | number>): Row[] => statement.all(...parameters);

type Statements = ReturnType<typeof prepareStatements>;

const createStore = (db: DatabaseSync, statements: Statements, clock: Clock): TraceStore => {
  let closed = false;

  const checkpoint = (mode: 'PASSIVE' | 'TRUNCATE'): void => {
    const statement = mode === 'PASSIVE' ? statements.checkpointPassive : statements.checkpointTruncate;
    const row = statement.get();
    const busy = row?.['busy'];
    const log = row?.['log'];
    const checkpointed = row?.['checkpointed'];
    if (typeof busy !== 'number' || typeof log !== 'number' || typeof checkpointed !== 'number') {
      throw new Error(`wal_checkpoint(${mode}) returned an unexpected row: ${JSON.stringify(row)}`);
    }
    if (busy !== 0 || checkpointed < log) {
      reportError(
        new Error(`wal checkpoint (${mode}) incomplete: busy=${busy}, wal frames=${log}, checkpointed=${checkpointed}`),
      );
    }
  };

  const purgeBodies = (nowMs: number): number => {
    const deleted = Number(statements.purgeBodies.run(nowMs).changes);
    if (deleted > 0) checkpoint('PASSIVE');
    return deleted;
  };

  const compact = (): void => {
    try {
      checkpoint('TRUNCATE');
    } catch (error) {
      reportError(error);
    }
  };

  return {
    writeSpans: (records, bodies = []) => {
      immediateTx(db, () => {
        for (const record of records) {
          statements.insertSpan.run(
            record.traceId,
            record.spanId,
            record.parentSpanId,
            record.name,
            record.kind,
            record.startMs,
            record.endMs,
            record.status,
            JSON.stringify(record.attributes),
            JSON.stringify(record.events),
            record.runId,
          );
        }
        for (const body of bodies) {
          statements.insertBody.run(
            body.traceId,
            body.spanId,
            body.kind,
            body.content,
            body.createdAtMs,
            body.expiresAtMs,
          );
        }
      });
    },
    spansForRun: (runId) => all(statements.spansForRun, runId).map(decodeSpan),
    spansWithoutRun: () => all(statements.spansWithoutRun).map(decodeSpan),
    spansForTrace: (traceId) => all(statements.spansForTrace, traceId).map(decodeSpan),
    bodiesForSpan: (spanId) => all(statements.bodiesForSpan, spanId, clock.now()).map(decodeBody),
    purgeBodies,
    purgeExpired: () => purgeBodies(clock.now()),
    compact,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        compact();
      } finally {
        db.close();
      }
    },
  };
};

export const openTraceStore = (options: OpenTraceStoreOptions): TraceStore => {
  const db = openDatabase(options.path);
  try {
    migrate(db, TRACE_STORE_MIGRATIONS);
    db.exec('PRAGMA secure_delete = ON');
    const store = createStore(db, prepareStatements(db), options.clock);
    try {
      store.purgeExpired();
    } catch (error) {
      reportError(error);
    }
    return store;
  } catch (error) {
    db.close();
    throw error;
  }
};
