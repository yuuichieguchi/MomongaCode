import type { DatabaseSync } from 'node:sqlite';
import { immediateTx, readTx, safeSlice } from '@momonga/foundation';
import type { Redactor } from '@momonga/foundation';
import { TERMINAL_STATUSES } from '@momonga/protocol';
import type { MemoryOrigin, RunEvent } from '@momonga/protocol';
import { decodeRunEvents } from './codec.ts';
import { corrupt, expectOneOf, isRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import { HISTORY_CANDIDATE_LIMIT, HISTORY_READ_PAGE_CHARS, HISTORY_SCAN_LIMIT, HISTORY_SEARCH_ANCHOR_LIMIT, HISTORY_SNIPPET_MAX_CHARS, HISTORY_STEP_HITS_PER_ANCHOR } from './search-constants.ts';
import { asciiLower, instrFilters, partitionTerms, quoted, termsOf } from './search-terms.ts';
import { INDEXED_PAYLOAD_TYPES, buildDocuments, locationPathsOf } from './search-documents.ts';
import type { RecordedEvent } from './search-documents.ts';
import type { HistoryAnchor, HistoryQueryRequest, HistoryQueryResult, HistoryReadRequest, HistoryReadResult, HistoryScope, HistorySession, HistoryStepHit, HistoryVisibility, SearchStore } from './types.ts';

const ORIGINS = ['trusted', 'untrusted'] as const;

const TERMINAL_LIST = TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ');

const INDEXED_EVENT_TYPES = INDEXED_PAYLOAD_TYPES.map((type) => `'${type}'`).join(', ');

const ELLIPSIS = '…';

const snippetOf = (body: string, terms: readonly string[]): string => {
  const lowered = asciiLower(body);
  const positions = terms.map((term) => lowered.indexOf(term)).filter((position) => position >= 0);
  const hit = positions.length === 0 ? 0 : Math.min(...positions);
  const budget = HISTORY_SNIPPET_MAX_CHARS - 2 * ELLIPSIS.length;
  if (body.length <= HISTORY_SNIPPET_MAX_CHARS) return body.replace(/\s+/g, ' ').trimEnd();
  const start = Math.max(0, Math.min(hit - Math.floor(budget / 4), body.length - budget));
  const end = Math.min(body.length, start + budget);
  return `${start > 0 ? ELLIPSIS : ''}${safeSlice(body, start, end).replace(/\s+/g, ' ')}${end < body.length ? ELLIPSIS : ''}`;
};

const redactedEvent = (redactor: Redactor, event: RunEvent): RunEvent => JSON.parse(redactor.whole(JSON.stringify(event))) as RunEvent;

const withoutLines = (body: string, lines: ReadonlySet<string>): string =>
  body
    .split('\n')
    .filter((line) => !lines.has(line))
    .join('\n');

const holdsTerms = (body: string, terms: readonly string[]): boolean => {
  const lowered = asciiLower(body);
  return terms.every((term) => lowered.includes(term));
};

type Candidate = { id: number; runId: string; level: string; step: number | null; outcome: string; at: number; score: number };

type RunHits = { runId: string; outcome: string; at: number; score: number; runHit: boolean; steps: Candidate[] };

const visibleRun = (visibility: HistoryVisibility, project: string, origin: MemoryOrigin): boolean =>
  project === visibility.project || (visibility.trusted && origin === 'trusted');

const rankRuns = (candidates: readonly Candidate[]): RunHits[] => {
  const runs = new Map<string, RunHits>();
  for (const candidate of candidates) {
    const run = runs.get(candidate.runId) ?? { runId: candidate.runId, outcome: candidate.outcome, at: candidate.at, score: candidate.score, runHit: false, steps: [] };
    run.score = Math.min(run.score, candidate.score);
    if (candidate.level === 'run') run.runHit = true;
    else run.steps.push(candidate);
    runs.set(candidate.runId, run);
  }
  const completedFirst = (run: RunHits): number => (run.outcome === 'COMPLETED' ? 0 : 1);
  return [...runs.values()]
    .map((run) => ({ ...run, steps: run.steps.sort((left, right) => left.score - right.score || (left.step ?? 0) - (right.step ?? 0)) }))
    .sort((left, right) => left.score - right.score || completedFirst(left) - completedFirst(right) || right.at - left.at || left.runId.localeCompare(right.runId));
};

const sessionsOf = (anchors: readonly HistoryAnchor[]): HistorySession[] => {
  const sessions = new Map<string, HistorySession>();
  for (const anchor of anchors) {
    const known = sessions.get(anchor.sessionId);
    if (known === undefined) {
      sessions.set(anchor.sessionId, { sessionId: anchor.sessionId, project: anchor.project, span: { from: anchor.at, to: anchor.at }, runs: [anchor] });
      continue;
    }
    known.runs.push(anchor);
    known.span = { from: Math.min(known.span.from, anchor.at), to: Math.max(known.span.to, anchor.at) };
  }
  return [...sessions.values()];
};

export const createSearchStore = (db: DatabaseSync): SearchStore => {
  const readCursor = db.prepare('SELECT last_event_id FROM search_cursor WHERE id = 1');
  const writeCursor = db.prepare('UPDATE search_cursor SET last_event_id = :eventId WHERE id = 1');
  const nextTerminal = db.prepare(
    `SELECT e.id AS event_id, e.created_at AS ended_at, r.id AS run_id, r.session_id, r.status, r.origin, s.cwd AS project
     FROM events e JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id
     WHERE e.id > :cursor AND e.type = 'run.status' AND json_extract(e.payload_json, '$.to') IN (${TERMINAL_LIST})
     ORDER BY e.id LIMIT 1`,
  );
  const runEvents = db.prepare(
    `SELECT id, seq, step, type, CASE WHEN type IN (${INDEXED_EVENT_TYPES}) THEN payload_json ELSE '{}' END AS payload_json FROM events WHERE run_id = :runId ORDER BY seq`,
  );
  const insertDocument = db.prepare(
    `INSERT INTO search_docs (level, session_id, run_id, step, project, origin, outcome, seq_from, seq_to, at, body, paths_json)
     VALUES (:level, :sessionId, :runId, :step, :project, :origin, :outcome, :seqFrom, :seqTo, :at, :body, :pathsJson)`,
  );
  const documentById = db.prepare('SELECT * FROM search_docs WHERE id = :id');
  const runDocument = db.prepare("SELECT * FROM search_docs WHERE run_id = :runId AND level = 'run'");
  const runRow = db.prepare('SELECT r.id, r.origin, s.cwd AS project FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = :runId');
  const toolCallEvent = db.prepare(
    "SELECT payload_json FROM events WHERE run_id = :runId AND type = 'tool.call' AND call_id = :callId LIMIT 1",
  );
  const rangeEvents = db.prepare(
    `SELECT *, length(payload_json) AS payload_chars FROM events WHERE run_id = :runId AND seq >= :seqFrom AND seq <= :seqTo AND (:step IS NULL OR step = :step) ORDER BY seq LIMIT :limit`,
  );

  const recordedEventsOf = (runId: string): Iterable<RecordedEvent> => {
    const rows = runEvents.iterate({ runId });
    return {
      [Symbol.iterator]: function* () {
        for (const row of rows) {
          const reader = readerFor('events', String(row['id']), row);
          const payload = reader.json('payload_json');
          if (!isRecord(payload)) throw corrupt('events', String(row['id']), 'payload_json must be a JSON object');
          yield { seq: reader.number('seq'), step: reader.number('step'), type: reader.string('type'), payload };
        }
      },
    };
  };

  const indexedChars = db.prepare(`SELECT COALESCE(SUM(length(payload_json)), 0) AS chars FROM events WHERE run_id = :runId AND type IN (${INDEXED_EVENT_TYPES})`);

  const indexNext = (redactor: Redactor, budget: number): number | undefined =>
    immediateTx(db, () => {
      const cursorRow = readCursor.get();
      if (cursorRow === undefined) throw new Error('the search cursor row is missing');
      const cursor = readerFor('search_cursor', '1', cursorRow).number('last_event_id');
      const row = nextTerminal.get({ cursor });
      if (row === undefined) return undefined;
      const reader = readerFor('events', String(row['event_id']), row);
      const runId = reader.string('run_id');
      const sizeRow = indexedChars.get({ runId });
      if (sizeRow === undefined) throw new Error(`the size of run ${runId} could not be computed`);
      const chars = readerFor('events', runId, sizeRow).number('chars');
      if (chars > budget) return undefined;
      const outcome = reader.string('status');
      const common = {
        sessionId: reader.string('session_id'),
        runId,
        project: reader.string('project'),
        origin: expectOneOf('runs', runId, 'origin', ORIGINS, reader.string('origin')),
        outcome,
        at: reader.number('ended_at'),
      };
      for (const document of buildDocuments(recordedEventsOf(runId), outcome, redactor)) {
        insertDocument.run({
          ...common,
          level: document.level,
          step: document.step,
          seqFrom: document.seqFrom,
          seqTo: document.seqTo,
          body: document.body,
          pathsJson: JSON.stringify(document.paths),
        });
      }
      writeCursor.run({ eventId: reader.number('event_id') });
      return chars;
    });

  const visibilityClause = (visibility: HistoryVisibility, scope: HistoryScope): string =>
    visibility.trusted && scope === 'all' ? "(d.project = :project OR d.origin = 'trusted')" : 'd.project = :project';

  const candidateOf = (row: Row): Candidate => {
    const reader = readerFor('search_docs', String(row['id']), row);
    return {
      id: reader.number('id'),
      runId: reader.string('run_id'),
      level: reader.string('level'),
      step: reader.nullableNumber('step'),
      outcome: reader.string('outcome'),
      at: reader.number('at'),
      score: reader.number('score'),
    };
  };

  const candidatesFor = (visibility: HistoryVisibility, request: HistoryQueryRequest, terms: readonly string[]): { candidates: Candidate[]; searched?: number } => {
    const { indexed: indexedTerms, short: shortTerms } = partitionTerms(terms);
    const filters = instrFilters('d.body', shortTerms);
    const visible = visibilityClause(visibility, request.scope);
    if (indexedTerms.length > 0) {
      const candidateLimit = request.candidateLimit ?? HISTORY_CANDIDATE_LIMIT;
      const statement = db.prepare(
        `SELECT d.id, d.run_id, d.level, d.step, d.outcome, d.at, bm25(search_index) AS score
         FROM search_index JOIN search_docs d ON d.id = search_index.rowid
         WHERE search_index MATCH :match AND ${visible}${filters.sql}
         ORDER BY search_index.rowid DESC LIMIT :fetch`,
      );
      const rows = statement.all({ match: indexedTerms.map(quoted).join(' '), project: visibility.project, fetch: candidateLimit + 1, ...filters.params });
      const bounded = rows.length > candidateLimit;
      const candidates = rows.slice(0, candidateLimit).map(candidateOf);
      return bounded ? { candidates, searched: candidateLimit } : { candidates };
    }
    const scanLimit = request.scanLimit ?? HISTORY_SCAN_LIMIT;
    const probe = db.prepare(`SELECT count(*) AS visible FROM (SELECT 1 FROM search_docs d WHERE ${visible} LIMIT :probe)`).get({ project: visibility.project, probe: scanLimit + 1 });
    if (probe === undefined) throw new Error('the scan probe returned no row');
    const bounded = readerFor('search_docs', 'probe', probe).number('visible') > scanLimit;
    const statement = db.prepare(
      `SELECT d.id, d.run_id, d.level, d.step, d.outcome, d.at, 0.0 AS score
       FROM (SELECT * FROM search_docs d WHERE ${visible} ORDER BY d.at DESC, d.id DESC LIMIT :scanLimit) d
       WHERE 1 = 1${filters.sql}`,
    );
    const candidates = statement.all({ project: visibility.project, scanLimit, ...filters.params }).map(candidateOf);
    return bounded ? { candidates, searched: scanLimit } : { candidates };
  };

  const pathsOf = (row: Row): string[] => {
    const identity = String(row['id']);
    const paths = readerFor('search_docs', identity, row).json('paths_json');
    if (!Array.isArray(paths) || paths.some((entry: unknown) => typeof entry !== 'string')) throw corrupt('search_docs', identity, 'paths_json must be a JSON array of strings');
    return paths as string[];
  };

  const stepHitOf = (row: Row, terms: readonly string[]): HistoryStepHit => {
    const reader = readerFor('search_docs', String(row['id']), row);
    return { step: reader.number('step'), seqFrom: reader.number('seq_from'), seqTo: reader.number('seq_to'), snippet: snippetOf(reader.string('body'), terms) };
  };

  const anchorFor = (run: RunHits, request: HistoryQueryRequest, terms: readonly string[]): { anchor: HistoryAnchor | undefined; withheld: number } => {
    const runDocRow = runDocument.get({ runId: run.runId });
    if (runDocRow === undefined) throw corrupt('search_docs', run.runId, 'the run has step documents but no run document');
    const reader = readerFor('search_docs', run.runId, runDocRow);
    const project = reader.string('project');
    const { readDenied } = request;
    const deniedIn = (row: Row): string[] => (readDenied === undefined ? [] : pathsOf(row).filter((target) => readDenied(target, project)));
    const steps: HistoryStepHit[] = [];
    let withheld = 0;
    for (const candidate of run.steps) {
      if (steps.length === HISTORY_STEP_HITS_PER_ANCHOR) break;
      const row = documentById.get({ id: candidate.id });
      if (row === undefined) throw corrupt('search_docs', String(candidate.id), 'the document vanished during the query');
      if (deniedIn(row).length > 0) {
        withheld += 1;
        continue;
      }
      steps.push(stepHitOf(row, terms));
    }
    const droppedPaths = new Set(deniedIn(runDocRow));
    const body = withoutLines(reader.string('body'), droppedPaths);
    if (run.runHit && droppedPaths.size > 0 && !holdsTerms(body, terms)) withheld += 1;
    const runStillHits = run.runHit && holdsTerms(body, terms);
    if (!runStillHits && steps.length === 0) return { anchor: undefined, withheld };
    return {
      anchor: {
        runId: run.runId,
        sessionId: reader.string('session_id'),
        project,
        origin: expectOneOf('search_docs', run.runId, 'origin', ORIGINS, reader.string('origin')),
        outcome: reader.string('outcome'),
        at: reader.number('at'),
        seqFrom: reader.number('seq_from'),
        seqTo: reader.number('seq_to'),
        snippet: snippetOf(body, terms),
        steps,
      },
      withheld,
    };
  };

  const query = (visibility: HistoryVisibility, request: HistoryQueryRequest): HistoryQueryResult =>
    readTx(db, () => {
      const terms = termsOf(request.query);
      if (terms.length === 0) throw new RangeError('a history query needs at least one term');
      const { candidates, searched } = candidatesFor(visibility, request, terms);
      const anchors: HistoryAnchor[] = [];
      let withheld = 0;
      for (const run of rankRuns(candidates)) {
        if (anchors.length === HISTORY_SEARCH_ANCHOR_LIMIT) break;
        const found = anchorFor(run, request, terms);
        withheld += found.withheld;
        if (found.anchor !== undefined) anchors.push(found.anchor);
      }
      return { sessions: sessionsOf(anchors), ...(searched === undefined ? {} : { searched }), ...(withheld === 0 ? {} : { withheld }) };
    });

  const lookupRun = (visibility: HistoryVisibility, runId: string): { project: string; origin: MemoryOrigin } | undefined => {
    const row = runRow.get({ runId });
    if (row === undefined) return undefined;
    const reader = readerFor('runs', runId, row);
    const project = reader.string('project');
    const origin = expectOneOf('runs', runId, 'origin', ORIGINS, reader.string('origin'));
    return visibleRun(visibility, project, origin) ? { project, origin } : undefined;
  };

  const callPathsOf = (runId: string, events: readonly RunEvent[], redactor: Redactor): Record<string, string[]> => {
    const callIds = new Set(events.flatMap((event) => ('callId' in event && typeof event.callId === 'string' ? [event.callId] : [])));
    const found: Record<string, string[]> = {};
    for (const callId of callIds) {
      const row = toolCallEvent.get({ runId, callId });
      if (row === undefined) continue;
      const payload = readerFor('events', `${runId}/${callId}`, row).json('payload_json');
      const paths = isRecord(payload) ? locationPathsOf(payload) : [];
      if (paths.length > 0) found[redactor.whole(callId)] = paths;
    }
    return found;
  };

  const readRange = (visibility: HistoryVisibility, request: HistoryReadRequest): HistoryReadResult =>
    readTx(db, () => {
      const run = lookupRun(visibility, request.runId);
      if (run === undefined) return { kind: 'not_visible' };
      const rows = rangeEvents.all({
        runId: request.runId,
        seqFrom: request.seqFrom ?? 1,
        seqTo: request.seqTo ?? Number.MAX_SAFE_INTEGER,
        step: request.step ?? null,
        limit: request.limit + 1,
      });
      let taken = 0;
      let chars = 0;
      for (const row of rows.slice(0, request.limit)) {
        chars += readerFor('events', String(row['id']), row).number('payload_chars');
        if (taken > 0 && chars > HISTORY_READ_PAGE_CHARS) break;
        taken += 1;
      }
      const next = rows[taken];
      const events = decodeRunEvents(rows.slice(0, taken));
      return {
        kind: 'ok',
        runId: request.runId,
        project: run.project,
        origin: run.origin,
        events: events.map((event) => redactedEvent(request.redactor, event)),
        callPaths: callPathsOf(request.runId, events, request.redactor),
        nextSeq: next === undefined ? null : readerFor('events', String(next['id']), next).number('seq'),
      };
    });

  return {
    indexBatch: ({ limit, redactor, maxChars }) => {
      let runs = 0;
      let spent = 0;
      while (runs < limit) {
        const budget = maxChars === undefined || runs === 0 ? Number.POSITIVE_INFINITY : maxChars - spent;
        const chars = indexNext(redactor, budget);
        if (chars === undefined) break;
        runs += 1;
        spent += chars;
      }
      return { runs };
    },
    visibleProjects: (visibility, scope) => {
      const projects = db
        .prepare(`SELECT DISTINCT d.project FROM search_docs d WHERE ${visibilityClause(visibility, scope)}`)
        .all({ project: visibility.project })
        .map((row) => readerFor('search_docs', 'projects', row).string('project'));
      return [...new Set([visibility.project, ...projects])];
    },
    query,
    readRange,
    projectOf: (visibility, runId) => lookupRun(visibility, runId)?.project,
  };
};
