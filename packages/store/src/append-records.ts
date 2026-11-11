import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@momonga/foundation';
import { ERROR_WINDOW, UNKNOWN_ANSWERER, assistantTextOf } from '@momonga/protocol';
import type { RunEventPayload, SessionEventPayload } from '@momonga/protocol';
import { corrupt, expectRecord, isRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import { DRAFT_PART_KINDS, INDEXED_PAYLOAD_TYPES, eventDraftOf, locationPathsOf } from './search-documents.ts';
import type { DraftPart, StepDraft } from './search-documents.ts';
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
    case 'tool.reconciled':
      return { ...NO_COLUMNS, callId: payload.callId };
    case 'tool.unknown.requested':
      return { ...NO_COLUMNS, callId: payload.callIds[0] ?? null, approvalId: payload.approvalId };
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

export const APPEND_TIME_RECORDS_DERIVATION = 20;
export const SESSION_TOUCHED_DERIVATION = 23;
export const RUN_ANSWERERS_DERIVATION = 24;
export const INDEXED_CHARS_DERIVATION = 35;
export const SEARCH_DRAFT_DERIVATION = 36;

export const SEARCH_DRAFT_PAGE_STEPS = 500;

export type SearchDraftRun = { task: string; finalText: string; paths: string[] };

export type SearchDraftPage = { steps: StepDraft[]; more: boolean };

export const RECORD_DERIVATIONS = [SEARCH_DRAFT_DERIVATION, INDEXED_CHARS_DERIVATION, RUN_ANSWERERS_DERIVATION, SESSION_TOUCHED_DERIVATION, APPEND_TIME_RECORDS_DERIVATION] as const;

export type RecordDerivation = (typeof RECORD_DERIVATIONS)[number];

export type AppendRecords = {
  record(event: RecordedEvent): void;
  recordFor(derivation: RecordDerivation, event: RecordedEvent): void;
  toolCallSeq(runId: string, callId: string): number | undefined;
  modelCallRowsOf(runId: string): Row[];
  toolCallNamesOf(rootRunId: string): string[];
  finalTextOf(runId: string): string;
  inFlightModelRequestOf(runId: string): { step: number; attempt: number } | undefined;
  startedCallsOf(runId: string): StartedCall[];
  hasNoticeCode(runId: string, code: string): boolean;
  meterRecordOf(sessionId: string, key: MeterKey): MeterRecord | undefined;
  answeringTargetsOf(runId: string): string[];
  indexedCharsOf(runId: string): number;
  searchDraftRunOf(runId: string, throughSeq: number): SearchDraftRun;
  searchDraftPageOf(runId: string, maxChars: number): SearchDraftPage;
  consumeSearchDraftSteps(runId: string, steps: readonly number[]): void;
  consumeSearchDraftRun(runId: string): void;
  touchedAfter(sessionId: string, afterEventId: number, limit: number, afterPath?: string): SessionTouched[];
  touchedNewest(sessionId: string, limit: number): SessionTouched[];
  permissionRequestOf(runId: string, approvalId: string): Row | undefined;
  elicitationRequested(runId: string, approvalId: string): boolean;
  unknownRequestOf(runId: string, approvalId: string): Row | undefined;
  reconciledOf(runId: string, callId: string): Row | undefined;
  toolCallEventOf(runId: string, callId: string): Row | undefined;
};

export type AppendRecordReaders = Omit<AppendRecords, 'record' | 'recordFor'>;

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

type WindowMiss = { eventId: number; miss: number; uncounted: number };

const missesOf = (identity: string, parsed: unknown): WindowMiss[] => {
  if (!Array.isArray(parsed)) throw corrupt('meter_records', identity, 'column misses_json must be a JSON array');
  return parsed.map((entry: unknown) => {
    const record = expectRecord('meter_records', identity, 'misses_json', entry);
    const { eventId, miss, uncounted } = record;
    if (typeof eventId !== 'number' || typeof miss !== 'number' || typeof uncounted !== 'number') throw corrupt('meter_records', identity, 'a miss entry must carry numbers');
    return { eventId, miss, uncounted };
  });
};

const windowOf = (misses: readonly WindowMiss[]): WindowMiss[] => {
  const byEvent = new Map(misses.map((entry) => [entry.eventId, entry]));
  return [...byEvent.values()].sort((a, b) => a.eventId - b.eventId).slice(-ERROR_WINDOW);
};

export const createAppendRecords = (db: DatabaseSync, options: { onDecode?: (rows: number, bytes: number) => void } = {}): AppendRecords => {
  const sql = {
    permissionRequest: db.prepare("SELECT payload_json FROM events WHERE run_id = :runId AND type = 'tool.permission.requested' AND approval_id = :approvalId LIMIT 1"),
    elicitationRequest: db.prepare("SELECT 1 AS present FROM events WHERE run_id = :runId AND type = 'tool.elicitation.requested' AND approval_id = :approvalId LIMIT 1"),
    unknownRequest: db.prepare("SELECT payload_json FROM events WHERE run_id = :runId AND type = 'tool.unknown.requested' AND approval_id = :approvalId LIMIT 1"),
    reconciled: db.prepare("SELECT payload_json FROM events WHERE run_id = :runId AND call_id = :callId AND type = 'tool.reconciled' ORDER BY seq DESC LIMIT 1"),
    toolCallEvent: db.prepare("SELECT payload_json FROM events WHERE run_id = :runId AND type = 'tool.call' AND call_id = :callId LIMIT 1"),
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
    insertTouched: db.prepare(
      `INSERT INTO session_touched (session_id, path, first_event_id) VALUES (:sessionId, :path, :eventId)
       ON CONFLICT (session_id, path) DO UPDATE SET first_event_id = MIN(first_event_id, excluded.first_event_id)`,
    ),
    touchedAfter: db.prepare(
      'SELECT path, first_event_id FROM session_touched WHERE session_id = :sessionId AND first_event_id > :after ORDER BY first_event_id, path LIMIT :limit',
    ),
    touchedAfterPath: db.prepare(
      'SELECT path, first_event_id FROM session_touched WHERE session_id = :sessionId AND (first_event_id, path) > (:after, :afterPath) ORDER BY first_event_id, path LIMIT :limit',
    ),
    touchedNewest: db.prepare('SELECT path, first_event_id FROM session_touched WHERE session_id = :sessionId ORDER BY first_event_id DESC, path DESC LIMIT :limit'),
    insertAnswerer: db.prepare('INSERT OR IGNORE INTO run_answerers (run_id, target) VALUES (:runId, :target)'),
    answerers: db.prepare('SELECT target FROM run_answerers WHERE run_id = :runId ORDER BY target'),
    addIndexedChars: db.prepare(
      `INSERT INTO run_indexed_chars (run_id, chars) SELECT :runId, length(payload_json) FROM events WHERE id = :eventId
       ON CONFLICT (run_id) DO UPDATE SET chars = chars + excluded.chars`,
    ),
    indexedChars: db.prepare('SELECT COALESCE((SELECT chars FROM run_indexed_chars WHERE run_id = :runId), 0) AS chars'),
    setDraftTask: db.prepare(
      `INSERT INTO search_draft_runs (run_id, task, final_text) VALUES (:runId, :task, '')
       ON CONFLICT (run_id) DO UPDATE SET task = excluded.task WHERE task = ''`,
    ),
    setDraftFinalText: db.prepare(
      `INSERT INTO search_draft_runs (run_id, task, final_text) VALUES (:runId, '', :finalText)
       ON CONFLICT (run_id) DO UPDATE SET final_text = excluded.final_text`,
    ),
    extendDraftStep: db.prepare(
      `INSERT INTO search_draft_steps (run_id, step, seq_from, seq_to, chars) VALUES (:runId, :step, :seq, :seq, :chars)
       ON CONFLICT (run_id, step) DO UPDATE SET seq_from = MIN(seq_from, excluded.seq_from), seq_to = MAX(seq_to, excluded.seq_to), chars = chars + excluded.chars`,
    ),
    insertDraftPart: db.prepare('INSERT INTO search_draft_parts (run_id, step, seq, kind, body, paths_json) VALUES (:runId, :step, :seq, :kind, :body, :pathsJson)'),
    insertDraftPath: db.prepare('INSERT OR IGNORE INTO search_draft_paths (run_id, path, seq, position) VALUES (:runId, :path, :seq, :position)'),
    draftRun: db.prepare('SELECT task, final_text FROM search_draft_runs WHERE run_id = :runId'),
    draftPaths: db.prepare('SELECT path FROM search_draft_paths WHERE run_id = :runId AND seq <= :throughSeq ORDER BY seq, position'),
    runIndexed: db.prepare("SELECT 1 AS present FROM search_docs WHERE run_id = :runId AND level = 'run'"),
    draftSteps: db.prepare('SELECT step, seq_from, seq_to, chars FROM search_draft_steps WHERE run_id = :runId ORDER BY seq_from LIMIT :limit'),
    draftParts: db.prepare('SELECT kind, body, paths_json FROM search_draft_parts WHERE run_id = :runId AND step = :step ORDER BY seq'),
    dropDraftStep: db.prepare('DELETE FROM search_draft_steps WHERE run_id = :runId AND step = :step'),
    dropDraftParts: db.prepare('DELETE FROM search_draft_parts WHERE run_id = :runId AND step = :step'),
    dropDraftRun: db.prepare('DELETE FROM search_draft_runs WHERE run_id = :runId'),
    dropDraftPaths: db.prepare('DELETE FROM search_draft_paths WHERE run_id = :runId'),
    dropRunDraftSteps: db.prepare('DELETE FROM search_draft_steps WHERE run_id = :runId'),
    dropRunDraftParts: db.prepare('DELETE FROM search_draft_parts WHERE run_id = :runId'),
    modelCallRows: db.prepare(
      `SELECT seq, step, type, model_call_json
       FROM events WHERE run_id = :runId AND type IN ('model.requested', 'model.responded')`,
    ),
    toolCallNames: db.prepare(
      `WITH RECURSIVE tree(id) AS (SELECT :runId UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id)
       SELECT DISTINCT e.tool_name AS name FROM tree t CROSS JOIN events e ON e.run_id = t.id WHERE e.tool_name IS NOT NULL ORDER BY name`,
    ),
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

  const recordMeter = (event: { eventId: number; runId: string; sessionId: string; seq: number; payload: Extract<RunEventPayload, { type: 'meter.observed' }> }): void => {
    const { payload } = event;
    const key = { sessionId: event.sessionId, counter: payload.counter, contextWindow: payload.contextWindow, tokenErrorRatio: payload.tokenErrorRatio ?? null, tokenCounting: payload.tokenCounting };
    const existing: Row | undefined = sql.meterRecord.get(key);
    const previous = existing === undefined ? [] : missesOf(`${event.sessionId}/${payload.counter}`, readerFor('meter_records', event.sessionId, existing).json('misses_json'));
    const missesJson = canonicalJson(windowOf([...previous, { eventId: event.eventId, miss: payload.miss, uncounted: payload.uncounted }]));
    const observed = { ...key, runId: event.runId, seq: event.seq, eventJson: canonicalJson(payload), missesJson };
    if (existing === undefined) {
      sql.insertMeter.run(observed);
      return;
    }
    const greatest = previous.reduce((most, entry) => Math.max(most, entry.eventId), 0);
    const kept = readerFor('meter_records', event.sessionId, existing);
    sql.updateMeter.run(event.eventId > greatest ? observed : { ...key, runId: kept.string('run_id'), seq: kept.number('seq'), eventJson: kept.string('event_json'), missesJson });
  };

  const touchedOf = (rows: readonly Row[], sessionId: string): SessionTouched[] =>
    rows.map((row) => {
      const reader = readerFor('session_touched', sessionId, row);
      return { path: reader.string('path'), firstEventId: reader.number('first_event_id') };
    });

  const recordAnswerer = (event: RecordedEvent): void => {
    const answerer = answerTargetOf(event.payload);
    if (answerer !== undefined) sql.insertAnswerer.run({ runId: event.runId, target: answerer });
  };

  const recordIndexedChars = (event: RecordedEvent): void => {
    if (INDEXED_PAYLOAD_TYPES.some((type) => type === event.payload.type)) sql.addIndexedChars.run({ runId: event.runId, eventId: event.eventId });
  };

  const recordSearchDraft = (event: RecordedEvent): void => {
    const { runId, seq, step } = event;
    if (sql.runIndexed.get({ runId }) !== undefined) return;
    const draft = eventDraftOf({ step, type: event.payload.type, payload: event.payload });
    if (draft.task !== undefined) sql.setDraftTask.run({ runId, task: draft.task });
    if (draft.finalText !== undefined) sql.setDraftFinalText.run({ runId, finalText: draft.finalText });
    if (step === 0) return;
    const { part } = draft;
    sql.extendDraftStep.run({ runId, step, seq, chars: part === undefined ? 0 : part.body.length });
    if (part === undefined) return;
    sql.insertDraftPart.run({ runId, step, seq, kind: part.kind, body: part.body, pathsJson: JSON.stringify(part.paths) });
    part.paths.forEach((path, position) => sql.insertDraftPath.run({ runId, path, seq, position }));
  };

  const draftPartOf = (runId: string, row: Row): DraftPart => {
    const reader = readerFor('search_draft_parts', runId, row);
    const kind = DRAFT_PART_KINDS.find((known) => known === reader.string('kind'));
    const paths = reader.json('paths_json');
    if (kind === undefined) throw corrupt('search_draft_parts', runId, 'column kind names no part of a search document');
    if (!Array.isArray(paths) || paths.some((entry: unknown) => typeof entry !== 'string')) throw corrupt('search_draft_parts', runId, 'paths_json must be a JSON array of strings');
    return { kind, body: reader.string('body'), paths: paths as string[] };
  };

  const searchDraftPageOf = (runId: string, maxChars: number): SearchDraftPage => {
    const rows = sql.draftSteps.all({ runId, limit: SEARCH_DRAFT_PAGE_STEPS + 1 });
    const steps: StepDraft[] = [];
    let chars = 0;
    for (const row of rows.slice(0, SEARCH_DRAFT_PAGE_STEPS)) {
      const reader = readerFor('search_draft_steps', runId, row);
      chars += reader.number('chars');
      if (steps.length > 0 && chars > maxChars) break;
      const step = reader.number('step');
      steps.push({ step, seqFrom: reader.number('seq_from'), seqTo: reader.number('seq_to'), parts: sql.draftParts.all({ runId, step }).map((part) => draftPartOf(runId, part)) });
    }
    return { steps, more: steps.length < rows.length };
  };

  const recordTouched = (event: RecordedEvent): void => {
    if (event.payload.type !== 'tool.call') return;
    for (const path of locationPathsOf(event.payload)) sql.insertTouched.run({ sessionId: event.sessionId, path, eventId: event.eventId });
  };

  const recordRunFacts = (event: RecordedEvent): void => {
    const { runId, payload } = event;
    switch (payload.type) {
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
        recordMeter({ eventId: event.eventId, runId, sessionId: event.sessionId, seq: event.seq, payload });
        return;
      default:
        return;
    }
  };

  const RECORDERS: Record<RecordDerivation, (event: RecordedEvent) => void> = {
    [APPEND_TIME_RECORDS_DERIVATION]: recordRunFacts,
    [SESSION_TOUCHED_DERIVATION]: recordTouched,
    [RUN_ANSWERERS_DERIVATION]: recordAnswerer,
    [INDEXED_CHARS_DERIVATION]: recordIndexedChars,
    [SEARCH_DRAFT_DERIVATION]: recordSearchDraft,
  };

  const recordFor = (derivation: RecordDerivation, event: RecordedEvent): void => RECORDERS[derivation](event);

  const record = (event: RecordedEvent): void => {
    for (const derivation of RECORD_DERIVATIONS) recordFor(derivation, event);
  };

  return {
    record,
    recordFor,
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
    permissionRequestOf: (runId, approvalId) => sql.permissionRequest.get({ runId, approvalId }),
    elicitationRequested: (runId, approvalId) => sql.elicitationRequest.get({ runId, approvalId }) !== undefined,
    unknownRequestOf: (runId, approvalId) => sql.unknownRequest.get({ runId, approvalId }),
    reconciledOf: (runId, callId) => sql.reconciled.get({ runId, callId }),
    toolCallEventOf: (runId, callId) => sql.toolCallEvent.get({ runId, callId }),
    modelCallRowsOf: (runId) => sql.modelCallRows.all({ runId }).sort((a, b) => readerFor('events', runId, a).number('seq') - readerFor('events', runId, b).number('seq')),
    toolCallNamesOf: (rootRunId) => sql.toolCallNames.all({ runId: rootRunId }).map((row) => readerFor('events', rootRunId, row).string('name')),
    hasNoticeCode: (runId, code) => sql.noticeCode.get({ runId, code }) !== undefined,
    answeringTargetsOf: (runId) => sql.answerers.all({ runId }).map((row) => readerFor('run_answerers', runId, row).string('target')),
    indexedCharsOf: (runId) => {
      const row: Row | undefined = sql.indexedChars.get({ runId });
      if (row === undefined) throw new Error(`the indexed characters of run ${runId} could not be read`);
      return readerFor('run_indexed_chars', runId, row).number('chars');
    },
    searchDraftRunOf: (runId, throughSeq) => {
      const row: Row | undefined = sql.draftRun.get({ runId });
      const paths = sql.draftPaths.all({ runId, throughSeq }).map((path) => readerFor('search_draft_paths', runId, path).string('path'));
      if (row === undefined) return { task: '', finalText: '', paths };
      const reader = readerFor('search_draft_runs', runId, row);
      return { task: reader.string('task'), finalText: reader.string('final_text'), paths };
    },
    searchDraftPageOf,
    consumeSearchDraftSteps: (runId, steps) => {
      for (const step of steps) {
        sql.dropDraftParts.run({ runId, step });
        sql.dropDraftStep.run({ runId, step });
      }
    },
    consumeSearchDraftRun: (runId) => {
      sql.dropRunDraftParts.run({ runId });
      sql.dropRunDraftSteps.run({ runId });
      sql.dropDraftRun.run({ runId });
      sql.dropDraftPaths.run({ runId });
    },
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
        misses: missesOf(sessionId, reader.json('misses_json')).map(({ miss, uncounted }) => ({ miss, uncounted })),
      };
    },
  };
};
