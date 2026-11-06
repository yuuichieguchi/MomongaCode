import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@momonga/foundation';
import { ERROR_WINDOW, UNKNOWN_ANSWERER, assistantTextOf } from '@momonga/protocol';
import type { RunEventPayload, SessionEventPayload } from '@momonga/protocol';
import { corrupt, expectRecord, isRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import { locationPathsOf } from './search-documents.ts';
import type { MeterKey, MeterRecord, SessionTouched, StartedCall } from './types.ts';

export type EventColumns = {
  callId: string | null;
  approvalId: string | null;
  toolName: string | null;
  noticeCode: string | null;
  modelCallJson: string | null;
};

const NO_COLUMNS: EventColumns = { callId: null, approvalId: null, toolName: null, noticeCode: null, modelCallJson: null };

export const columnsOf = (payload: RunEventPayload | SessionEventPayload): EventColumns => {
  switch (payload.type) {
    case 'tool.call':
      return { ...NO_COLUMNS, callId: payload.callId, toolName: payload.name };
    case 'tool.permission.requested':
      return { ...NO_COLUMNS, callId: payload.callId, approvalId: payload.approvalId };
    case 'tool.elicitation.requested':
      return { ...NO_COLUMNS, callId: payload.callId, approvalId: payload.inputId };
    case 'notice':
      return { ...NO_COLUMNS, noticeCode: payload.code ?? null };
    case 'model.requested':
      return {
        ...NO_COLUMNS,
        modelCallJson: canonicalJson({
          attempt: payload.attempt,
          ...(payload.anatomy === undefined ? {} : { anatomy: payload.anatomy }),
          ...(payload.prefix === undefined ? {} : { prefix: payload.prefix }),
        }),
      };
    case 'model.responded':
      return {
        ...NO_COLUMNS,
        modelCallJson: canonicalJson({
          attempt: payload.attempt,
          ...(payload.response.id === undefined ? {} : { responseId: payload.response.id }),
          ...('timing' in payload.response && payload.response.timing !== undefined ? { timing: payload.response.timing } : {}),
        }),
      };
    default:
      return NO_COLUMNS;
  }
};

export const lastTextOf = (output: readonly unknown[]): string | undefined => {
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const text = assistantTextOf([output[index]]);
    if (text !== '') return text;
  }
  return undefined;
};

export type RecordedEvent = { eventId: number; runId: string; sessionId: string; seq: number; step: number; payload: RunEventPayload | SessionEventPayload };

export type AppendRecords = {
  record(event: RecordedEvent): void;
  toolCallSeq(runId: string, callId: string): number | undefined;
  finalTextOf(runId: string): string;
  inFlightModelRequestOf(runId: string): { step: number; attempt: number } | undefined;
  startedCallsOf(runId: string): StartedCall[];
  hasNoticeCode(runId: string, code: string): boolean;
  meterRecordOf(sessionId: string, key: MeterKey): MeterRecord | undefined;
  answeringTargetsOf(runId: string): string[];
  touchedAfter(sessionId: string, afterEventId: number, limit: number, afterPath?: string): SessionTouched[];
  touchedNewest(sessionId: string, limit: number): SessionTouched[];
};

export const answerTargetOf = (payload: RunEventPayload | SessionEventPayload): string | undefined => {
  switch (payload.type) {
    case 'model.responded':
    case 'model.rejected':
    case 'usage.charged':
      return payload.target ?? UNKNOWN_ANSWERER;
    default:
      return undefined;
  }
};

const missesOf = (identity: string, parsed: unknown): { miss: number; uncounted: number }[] => {
  if (!Array.isArray(parsed)) throw corrupt('meter_records', identity, 'column misses_json must be a JSON array');
  return parsed.map((entry: unknown) => {
    const record = expectRecord('meter_records', identity, 'misses_json', entry);
    const { miss, uncounted } = record;
    if (typeof miss !== 'number' || typeof uncounted !== 'number') throw corrupt('meter_records', identity, 'a miss entry must carry numbers');
    return { miss, uncounted };
  });
};

export const createAppendRecords = (db: DatabaseSync, options: { onDecode?: (rows: number, bytes: number) => void } = {}): AppendRecords => {
  const sql = {
    toolCallSeq: db.prepare("SELECT seq FROM events WHERE run_id = :runId AND type = 'tool.call' AND call_id = :callId LIMIT 1"),
    toolCallRow: db.prepare("SELECT seq, tool_name FROM events WHERE run_id = :runId AND type = 'tool.call' AND call_id = :callId LIMIT 1"),
    runRecord: db.prepare('SELECT final_text, in_flight_step, in_flight_attempt FROM run_records WHERE run_id = :runId'),
    setFinalText: db.prepare(
      `INSERT INTO run_records (run_id, final_text) VALUES (:runId, :text)
       ON CONFLICT (run_id) DO UPDATE SET final_text = excluded.final_text`,
    ),
    setInFlight: db.prepare(
      `INSERT INTO run_records (run_id, in_flight_step, in_flight_attempt) VALUES (:runId, :step, :attempt)
       ON CONFLICT (run_id) DO UPDATE SET in_flight_step = excluded.in_flight_step, in_flight_attempt = excluded.in_flight_attempt`,
    ),
    startCall: db.prepare(
      `INSERT INTO started_calls (run_id, call_id, call_seq, name, idem_key) VALUES (:runId, :callId, :callSeq, :name, :idemKey)
       ON CONFLICT (run_id, call_id) DO UPDATE SET idem_key = excluded.idem_key`,
    ),
    finishCall: db.prepare('DELETE FROM started_calls WHERE run_id = :runId AND call_id = :callId'),
    startedCalls: db.prepare('SELECT call_id, name, idem_key FROM started_calls WHERE run_id = :runId ORDER BY call_seq'),
    insertTouched: db.prepare('INSERT OR IGNORE INTO session_touched (session_id, path, first_event_id) VALUES (:sessionId, :path, :eventId)'),
    touchedAfter: db.prepare(
      'SELECT path, first_event_id FROM session_touched WHERE session_id = :sessionId AND first_event_id > :after ORDER BY first_event_id, path LIMIT :limit',
    ),
    touchedAfterPath: db.prepare(
      'SELECT path, first_event_id FROM session_touched WHERE session_id = :sessionId AND (first_event_id, path) > (:after, :afterPath) ORDER BY first_event_id, path LIMIT :limit',
    ),
    touchedNewest: db.prepare('SELECT path, first_event_id FROM session_touched WHERE session_id = :sessionId ORDER BY first_event_id DESC, path DESC LIMIT :limit'),
    insertAnswerer: db.prepare('INSERT OR IGNORE INTO run_answerers (run_id, target) VALUES (:runId, :target)'),
    answerers: db.prepare('SELECT target FROM run_answerers WHERE run_id = :runId ORDER BY target'),
    noticeCode: db.prepare("SELECT 1 AS present FROM events WHERE run_id = :runId AND type = 'notice' AND notice_code = :code LIMIT 1"),
    meterRecord: db.prepare(
      `SELECT run_id, seq, event_json, misses_json FROM meter_records
       WHERE session_id = :sessionId AND counter = :counter AND context_window = :contextWindow
         AND COALESCE(token_error_ratio, -1) = COALESCE(:tokenErrorRatio, -1) AND token_counting = :tokenCounting`,
    ),
    insertMeter: db.prepare(
      `INSERT INTO meter_records (session_id, counter, context_window, token_error_ratio, token_counting, run_id, seq, event_json, misses_json)
       VALUES (:sessionId, :counter, :contextWindow, :tokenErrorRatio, :tokenCounting, :runId, :seq, :eventJson, :missesJson)`,
    ),
    updateMeter: db.prepare(
      `UPDATE meter_records SET run_id = :runId, seq = :seq, event_json = :eventJson, misses_json = :missesJson
       WHERE session_id = :sessionId AND counter = :counter AND context_window = :contextWindow
         AND COALESCE(token_error_ratio, -1) = COALESCE(:tokenErrorRatio, -1) AND token_counting = :tokenCounting`,
    ),
  };

  const inFlightOf = (runId: string): { step: number; attempt: number } | undefined => {
    const row: Row | undefined = sql.runRecord.get({ runId });
    if (row === undefined) return undefined;
    const reader = readerFor('run_records', runId, row);
    const step = reader.nullableNumber('in_flight_step');
    const attempt = reader.nullableNumber('in_flight_attempt');
    return step === null || attempt === null ? undefined : { step, attempt };
  };

  const clearInFlight = (runId: string): void => {
    sql.setInFlight.run({ runId, step: null, attempt: null });
  };

  const recordMeter = (event: { runId: string; sessionId: string; seq: number; payload: Extract<RunEventPayload, { type: 'meter.observed' }> }): void => {
    const { payload } = event;
    const key = { sessionId: event.sessionId, counter: payload.counter, contextWindow: payload.contextWindow, tokenErrorRatio: payload.tokenErrorRatio ?? null, tokenCounting: payload.tokenCounting };
    const existing: Row | undefined = sql.meterRecord.get(key);
    const previous = existing === undefined ? [] : missesOf(`${event.sessionId}/${payload.counter}`, readerFor('meter_records', event.sessionId, existing).json('misses_json'));
    const row = {
      ...key,
      runId: event.runId,
      seq: event.seq,
      eventJson: canonicalJson(payload),
      missesJson: canonicalJson([...previous, { miss: payload.miss, uncounted: payload.uncounted }].slice(-ERROR_WINDOW)),
    };
    (existing === undefined ? sql.insertMeter : sql.updateMeter).run(row);
  };

  const touchedOf = (rows: readonly Row[], sessionId: string): SessionTouched[] =>
    rows.map((row) => {
      const reader = readerFor('session_touched', sessionId, row);
      return { path: reader.string('path'), firstEventId: reader.number('first_event_id') };
    });

  const record = (event: RecordedEvent): void => {
    const { runId, payload } = event;
    const answerer = answerTargetOf(payload);
    if (answerer !== undefined) sql.insertAnswerer.run({ runId, target: answerer });
    switch (payload.type) {
      case 'tool.call':
        for (const path of locationPathsOf(payload)) sql.insertTouched.run({ sessionId: event.sessionId, path, eventId: event.eventId });
        return;
      case 'model.requested':
        sql.setInFlight.run({ runId, step: event.step, attempt: payload.attempt });
        return;
      case 'model.responded': {
        const text = lastTextOf(payload.response.output);
        if (text !== undefined) sql.setFinalText.run({ runId, text });
        const inFlight = inFlightOf(runId);
        if (inFlight !== undefined && inFlight.step === event.step && inFlight.attempt === payload.attempt) clearInFlight(runId);
        return;
      }
      case 'model.rejected': {
        const inFlight = inFlightOf(runId);
        if (inFlight !== undefined && inFlight.step === event.step && inFlight.attempt === payload.attempt) sql.setInFlight.run({ runId, step: inFlight.step, attempt: payload.attempt + 1 });
        return;
      }
      case 'context.compaction_rejected': {
        const inFlight = inFlightOf(runId);
        if (payload.attempt !== undefined && inFlight !== undefined && inFlight.step === event.step && inFlight.attempt === payload.attempt) clearInFlight(runId);
        return;
      }
      case 'tool.started': {
        const call: Row | undefined = sql.toolCallRow.get({ runId, callId: payload.callId });
        if (call === undefined) throw new Error(`run ${runId}: tool.started refers to unknown tool call ${payload.callId}`);
        const reader = readerFor('events', `${runId}/${payload.callId}`, call);
        sql.startCall.run({ runId, callId: payload.callId, callSeq: reader.number('seq'), name: reader.string('tool_name'), idemKey: payload.idemKey });
        return;
      }
      case 'tool.completed':
      case 'tool.reconciled':
        sql.finishCall.run({ runId, callId: payload.callId });
        return;
      case 'meter.observed':
        recordMeter({ runId, sessionId: event.sessionId, seq: event.seq, payload });
        return;
      default:
        return;
    }
  };

  return {
    record,
    toolCallSeq: (runId, callId) => {
      const row: Row | undefined = sql.toolCallSeq.get({ runId, callId });
      return row === undefined ? undefined : readerFor('events', `${runId}/${callId}`, row).number('seq');
    },
    finalTextOf: (runId) => {
      const row: Row | undefined = sql.runRecord.get({ runId });
      if (row === undefined) return '';
      const text = readerFor('run_records', runId, row).nullableString('final_text');
      return text ?? '';
    },
    inFlightModelRequestOf: inFlightOf,
    startedCallsOf: (runId) =>
      sql.startedCalls.all({ runId }).map((row) => {
        const reader = readerFor('started_calls', runId, row);
        return { callId: reader.string('call_id'), name: reader.string('name'), idemKey: reader.string('idem_key') };
      }),
    hasNoticeCode: (runId, code) => sql.noticeCode.get({ runId, code }) !== undefined,
    answeringTargetsOf: (runId) => sql.answerers.all({ runId }).map((row) => readerFor('run_answerers', runId, row).string('target')),
    touchedAfter: (sessionId, afterEventId, limit, afterPath) =>
      touchedOf(afterPath === undefined ? sql.touchedAfter.all({ sessionId, after: afterEventId, limit }) : sql.touchedAfterPath.all({ sessionId, after: afterEventId, afterPath, limit }), sessionId),
    touchedNewest: (sessionId, limit) => touchedOf(sql.touchedNewest.all({ sessionId, limit }), sessionId),
    meterRecordOf: (sessionId, key) => {
      const row: Row | undefined = sql.meterRecord.get({ sessionId, counter: key.counter, contextWindow: key.contextWindow, tokenErrorRatio: key.tokenErrorRatio ?? null, tokenCounting: key.tokenCounting });
      if (row === undefined) return undefined;
      const reader = readerFor('meter_records', sessionId, row);
      options.onDecode?.(1, Buffer.byteLength(reader.string('event_json')));
      const event = reader.json('event_json');
      if (!isRecord(event) || event['type'] !== 'meter.observed') throw corrupt('meter_records', sessionId, 'column event_json does not hold a meter.observed event');
      return {
        runId: reader.string('run_id'),
        seq: reader.number('seq'),
        event: event as MeterRecord['event'],
        misses: missesOf(sessionId, reader.json('misses_json')),
      };
    },
  };
};
