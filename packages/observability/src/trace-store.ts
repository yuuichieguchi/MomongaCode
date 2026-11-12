import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { AttributeValue } from '@opentelemetry/api';
import { immediateTx, migrate, openDatabase, isRecord } from '@momonga/foundation';
import type { Migration } from '@momonga/foundation';
import { reportError } from './errors.ts';
import { DEFAULT_MAX_QUEUED_BYTES } from './body-queue.ts';
import { GENAI_CONTENT_SEMCONV, GENAI_SEMCONV, OPERATIONS, UNKNOWN_BILLING } from './semconv.ts';

const A = GENAI_SEMCONV.attributes;

const jsonPath = (key: string): string => `$."${key}"`;

export const SPAN_KINDS = ['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'] as const;
export const SPAN_STATUSES = ['UNSET', 'OK', 'ERROR'] as const;
const CONTENT = GENAI_CONTENT_SEMCONV;

export const BODY_KINDS = [
  CONTENT.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  CONTENT.ATTR_GEN_AI_INPUT_MESSAGES,
  CONTENT.ATTR_GEN_AI_OUTPUT_MESSAGES,
  CONTENT.ATTR_GEN_AI_TOOL_DEFINITIONS,
  CONTENT.ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  CONTENT.ATTR_GEN_AI_TOOL_CALL_RESULT,
] as const;

const LEGACY_SPANS_PER_BATCH = 16;

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

export type IngestedSpan = { seq: number; span: SpanRecord };

export type BodyRecord = {
  traceId: string;
  spanId: string;
  kind: BodyKind;
  content: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type StoredBody = { id: number; body: BodyRecord };

export type TraceStore = {
  writeSpans(records: readonly SpanRecord[], bodies?: readonly BodyRecord[]): void;
  spansForRun(runId: string): SpanRecord[];
  spansWithoutRun(): SpanRecord[];
  billedChatSpansAfter(runId: string | null, afterSeq: number, limit: number): IngestedSpan[];
  bodiesOfRunAfter(runId: string, afterId: number, limit: number): StoredBody[];
  spansOfRunAfter(runId: string, afterSeq: number, count: number): IngestedSpan[];
  purgeRuns(runIds: readonly string[], cutoffMs: number): number;
  moveLegacyContent(options: { retentionMs: number }): number;
  compact(): void;
  close(): void;
};

export type OpenTraceStoreOptions = { path: string; busyTimeoutMs: number };

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

const INGEST_SEQUENCE = `
ALTER TABLE spans ADD COLUMN ingest_seq INTEGER;
UPDATE spans SET ingest_seq = rowid;
CREATE UNIQUE INDEX spans_by_ingest ON spans (ingest_seq);
`;

const RUN_INGEST_INDEX = `
CREATE INDEX spans_by_run_ingest ON spans (run_id, ingest_seq);
`;

const CONTENT_PRESENT = [
  'gen_ai.system_instructions',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]
  .map((name) => `json_extract(attributes_json, '$."${name}"') IS NOT NULL`)
  .join(' OR ');

const CONTENT_BODIES = `
DROP TABLE bodies;
CREATE TABLE bodies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'gen_ai.system_instructions',
    'gen_ai.input.messages',
    'gen_ai.output.messages',
    'gen_ai.tool.definitions',
    'gen_ai.tool.call.arguments',
    'gen_ai.tool.call.result'
  )),
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX bodies_by_span ON bodies (span_id, id);
CREATE INDEX bodies_by_expiry ON bodies (expires_at_ms);
CREATE INDEX spans_with_content ON spans (ingest_seq) WHERE ${CONTENT_PRESENT};
`;

export const TRACE_STORE_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: INITIAL_SCHEMA },
  { version: 2, name: 'chat-span-billing', sql: RECORD_BILLING_OF_EARLIER_CHAT_SPANS },
  { version: 3, name: 'span-ingest-sequence', sql: INGEST_SEQUENCE },
  { version: 4, name: 'run-ingest-index', sql: RUN_INGEST_INDEX },
  { version: 5, name: 'content-bodies', sql: CONTENT_BODIES },
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
       trace_id, span_id, parent_span_id, name, kind, start_ms, end_ms, status, attributes_json, events_json, run_id, ingest_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ingest_seq), 0) + 1 FROM spans))
     ON CONFLICT (trace_id, span_id) DO NOTHING`,
  ),
  billedChatSpansOfRun: db.prepare(
    `SELECT * FROM spans
     WHERE run_id = ? AND ingest_seq > ?
       AND json_extract(attributes_json, ?) = ? AND json_extract(attributes_json, ?) IS NOT NULL
     ORDER BY ingest_seq LIMIT ?`,
  ),
  billedChatSpansWithoutRun: db.prepare(
    `SELECT * FROM spans
     WHERE run_id IS NULL AND ingest_seq > ?
       AND json_extract(attributes_json, ?) = ? AND json_extract(attributes_json, ?) IS NOT NULL
     ORDER BY ingest_seq LIMIT ?`,
  ),
  legacyContentSpans: db.prepare(
    `SELECT trace_id, span_id, end_ms, attributes_json FROM spans WHERE ${CONTENT_PRESENT} ORDER BY ingest_seq LIMIT ?`,
  ),
  stripContent: db.prepare(
    `UPDATE spans SET attributes_json = json_remove(attributes_json, ${BODY_KINDS.map(() => '?').join(', ')}) WHERE trace_id = ? AND span_id = ?`,
  ),
  insertBody: db.prepare(
    `INSERT INTO bodies (trace_id, span_id, kind, content, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  ),
  spansForRun: db.prepare('SELECT * FROM spans WHERE run_id = ? ORDER BY start_ms, end_ms DESC, rowid'),
  spansOfRunAfter: db.prepare('SELECT * FROM spans WHERE run_id = ? AND ingest_seq > ? ORDER BY ingest_seq'),
  spansWithoutRun: db.prepare('SELECT * FROM spans WHERE run_id IS NULL ORDER BY start_ms, end_ms DESC, rowid'),
  bodiesOfRunAfter: db.prepare(
    `SELECT b.* FROM bodies b
     WHERE b.id > ?
       AND EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = b.trace_id AND s.span_id = b.span_id AND s.run_id = ?)
     ORDER BY b.id LIMIT ?`,
  ),
  purgeBodiesOfRun: db.prepare('DELETE FROM bodies WHERE EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = bodies.trace_id AND s.span_id = bodies.span_id AND s.run_id = ?)'),
  purgeSpansOfRun: db.prepare('DELETE FROM spans WHERE run_id = ?'),
  purgeRunlessBodies: db.prepare('DELETE FROM bodies WHERE EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = bodies.trace_id AND s.span_id = bodies.span_id AND s.run_id IS NULL AND s.end_ms <= ?)'),
  purgeRunlessSpans: db.prepare('DELETE FROM spans WHERE run_id IS NULL AND end_ms <= ?'),
  purgeUnspannedBodies: db.prepare('DELETE FROM bodies WHERE created_at_ms <= ? AND NOT EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = bodies.trace_id AND s.span_id = bodies.span_id)'),
  checkpointPassive: db.prepare('PRAGMA wal_checkpoint(PASSIVE)'),
  checkpointTruncate: db.prepare('PRAGMA wal_checkpoint(TRUNCATE)'),
});

const all = (statement: StatementSync, ...parameters: Array<string | number>): Row[] => statement.all(...parameters);

type Statements = ReturnType<typeof prepareStatements>;

const createStore = (db: DatabaseSync, statements: Statements): TraceStore => {
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

  const purgeRuns = (runIds: readonly string[], cutoffMs: number): number => {
    const deleted = immediateTx(db, () => {
      let rows = 0;
      for (const runId of runIds) {
        rows += Number(statements.purgeBodiesOfRun.run(runId).changes);
        rows += Number(statements.purgeSpansOfRun.run(runId).changes);
      }
      rows += Number(statements.purgeRunlessBodies.run(cutoffMs).changes);
      rows += Number(statements.purgeRunlessSpans.run(cutoffMs).changes);
      rows += Number(statements.purgeUnspannedBodies.run(cutoffMs).changes);
      return rows;
    });
    if (deleted > 0) checkpoint('PASSIVE');
    return deleted;
  };

  const moveLegacyContent = ({ retentionMs }: { retentionMs: number }): number =>
    immediateTx(db, () => {
      let bytes = 0;
      let moved = 0;
      for (const row of all(statements.legacyContentSpans, LEGACY_SPANS_PER_BATCH)) {
        const identity = `${String(row['trace_id'])}/${String(row['span_id'])}`;
        const attributes = toAttributes('spans', identity, 'attributes_json', parseJson('spans', identity, 'attributes_json', readText('spans', identity, row, 'attributes_json')));
        const endMs = readInteger('spans', identity, row, 'end_ms');
        const bodies = BODY_KINDS.flatMap((kind) => {
          const content = attributes[kind];
          if (content === undefined) return [];
          if (typeof content !== 'string') throw corrupt('spans', identity, `content attribute ${kind} must be a string`);
          return [{ kind, content }];
        });
        const size = bodies.reduce((sum, body) => sum + Buffer.byteLength(body.content, 'utf8'), 0);
        if (moved > 0 && bytes + size > DEFAULT_MAX_QUEUED_BYTES) break;
        const traceId = readText('spans', identity, row, 'trace_id');
        const spanId = readText('spans', identity, row, 'span_id');
        for (const body of bodies) statements.insertBody.run(traceId, spanId, body.kind, body.content, endMs, endMs + retentionMs);
        statements.stripContent.run(...BODY_KINDS.map(jsonPath), traceId, spanId);
        bytes += size;
        moved += 1;
      }
      return moved;
    });

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
    spansOfRunAfter: (runId, afterSeq, count) => {
      const found: IngestedSpan[] = [];
      for (const row of statements.spansOfRunAfter.iterate(runId, afterSeq)) {
        if (found.length === count) break;
        found.push({ seq: readInteger('spans', String(row['span_id']), row, 'ingest_seq'), span: decodeSpan(row) });
      }
      return found;
    },
    billedChatSpansAfter: (runId, afterSeq, limit) => {
      const filter = [jsonPath(A.ATTR_GEN_AI_OPERATION_NAME), OPERATIONS.chat, jsonPath(A.ATTR_GEN_AI_USAGE_INPUT_TOKENS), limit] as const;
      const rows =
        runId === null
          ? all(statements.billedChatSpansWithoutRun, afterSeq, ...filter)
          : all(statements.billedChatSpansOfRun, runId, afterSeq, ...filter);
      return rows.map((row) => ({ seq: readInteger('spans', String(row['span_id']), row, 'ingest_seq'), span: decodeSpan(row) }));
    },
    bodiesOfRunAfter: (runId, afterId, limit) =>
      all(statements.bodiesOfRunAfter, afterId, runId, limit).map((row) => ({ id: readInteger('bodies', String(row['id']), row, 'id'), body: decodeBody(row) })),
    purgeRuns,
    moveLegacyContent,
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
  const db = openDatabase(options.path, { busyTimeoutMs: options.busyTimeoutMs });
  try {
    migrate(db, TRACE_STORE_MIGRATIONS);
    db.exec('PRAGMA secure_delete = ON');
    return createStore(db, prepareStatements(db));
  } catch (error) {
    db.close();
    throw error;
  }
};

const wireText = (view: Record<string, unknown>, key: string): string => {
  const value = view[key];
  if (typeof value !== 'string') throw new TypeError(`a span on the wire has no text ${key}`);
  return value;
};

const wireTime = (view: Record<string, unknown>, key: string): number => {
  const value = view[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`a span on the wire has no integer ${key}`);
  return value;
};

const wireOneOf = <T extends string>(view: Record<string, unknown>, key: string, allowed: readonly T[]): T => {
  const match = allowed.find((candidate) => candidate === view[key]);
  if (match === undefined) throw new TypeError(`a span on the wire has ${key} ${JSON.stringify(view[key])}, not one of ${allowed.join(', ')}`);
  return match;
};

export const spanRecordOfView = (view: unknown, runId: string): SpanRecord => {
  if (!isRecord(view)) throw new TypeError('a span on the wire is not an object');
  const parentSpanId = view['parentSpanId'];
  if (parentSpanId !== null && typeof parentSpanId !== 'string') throw new TypeError('a span on the wire has a parentSpanId that is neither text nor null');
  const written = view['attributes'];
  if (!isRecord(written)) throw new TypeError('a span on the wire has no attributes object');
  const attributes: Record<string, AttributeValue> = {};
  for (const [key, entry] of Object.entries(written)) {
    if (!isAttributeValue(entry)) throw new TypeError(`a span on the wire has attribute ${key} that is not a span attribute value`);
    attributes[key] = entry;
  }
  return {
    traceId: wireText(view, 'traceId'),
    spanId: wireText(view, 'spanId'),
    parentSpanId,
    name: wireText(view, 'name'),
    kind: wireOneOf(view, 'kind', SPAN_KINDS),
    startMs: wireTime(view, 'startMs'),
    endMs: wireTime(view, 'endMs'),
    status: wireOneOf(view, 'status', SPAN_STATUSES),
    attributes,
    events: [],
    runId,
  };
};
