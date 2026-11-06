import type { DatabaseSync } from 'node:sqlite';
import { readTx } from '@momonga/foundation/sqlite';
import type { Clock } from '@momonga/foundation';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { decodeContextOf, decodeRun, decodeRunEvents } from './codec.ts';
import { foldRunState, initialRunState } from './fold.ts';
import { createGoverningFactStore } from './governing.ts';
import { copyDigestOf, isReferenceInherited } from './inherit.ts';
import type { InheritedPayload } from './inherit.ts';
import { createReferenceReader } from './inherit-reference.ts';
import type { ReferenceReader } from './inherit-reference.ts';
import { createVerdictReader } from './fidelity-verdicts.ts';
import { createMemoryStore } from './memories.ts';
import { createRecordWalker } from './record-walk.ts';
import type { RecordVisit, WalkUnits } from './record-walk.ts';
import { readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { ContributionMeasured, ContributionRequest, GoverningFactStore, MemoryStore, Run, TerminalContribution } from './types.ts';

export const payloadStep = (payload: RunEventPayload): number => ('step' in payload ? payload.step : 0);

const PINNED_ROLES = "'system', 'developer'";

const PINNED_REQUEST_PAYLOAD = `(SELECT json_object(
  'type', 'model.requested',
  'step', json_extract(x.j, '$.step'),
  'attempt', json_extract(x.j, '$.attempt'),
  'digest', json_extract(x.j, '$.digest'),
  'body', json_object(
    'input', json((SELECT json_group_array(json(json_extract(x.j, t.path))) FROM json_tree(x.j, '$.body.input') AS t WHERE t.key = 'role' AND t.atom IN (${PINNED_ROLES}) AND t.path GLOB '$.body.input[[]*]' AND t.path NOT GLOB '*.*.*.*')),
    'tools', json_extract(x.j, '$.body.tools'),
    'tool_choice', json_extract(x.j, '$.body.tool_choice')
  )
) FROM (SELECT jsonb(e.payload_json) AS j) AS x)`;

const HOOK_EVENT_COLUMNS = `e.id, e.run_id, e.session_id, e.seq, e.step, e.lease_token, e.created_at, e.type,
  CASE WHEN e.type = 'model.requested' THEN ${PINNED_REQUEST_PAYLOAD} ELSE e.payload_json END AS payload_json`;

const NO_CLOCK: Clock = {
  now: () => {
    throw new Error('the journal reader reads and has no clock');
  },
};

export const JOURNAL_SCAN_RANGE_ROWS = 1000;

export type JournalReaderOptions = {
  unit?: () => void;
  onRowsStepped?: (rows: number) => void;
  onDecode?: (rows: number, bytes: number) => void;
  onHop?: (runId: string) => void;
  lookups?: { memories: Pick<MemoryStore, 'get'>; governing: Pick<GoverningFactStore, 'get'> };
};

export type JournalReader = {
  measure(hook: TerminalContribution, request: ContributionRequest): ContributionMeasured;
  eventsOfTypes(runId: string, types: readonly RunEventPayload['type'][]): RunEvent[];
  visitRun(runId: string, types: readonly RunEventPayload['type'][], visit: (event: RunEvent) => void, throughSeq?: number): Run;
  walkRun(runId: string, types: readonly RunEventPayload['type'][], visit: RecordVisit, units: WalkUnits, range?: { throughSeq?: number; from?: number }): Promise<Run>;
  visitRecord: ReferenceReader['visitRecord'];
  verdictRows: ReturnType<typeof createVerdictReader>['rowsOf'];
  boundOf(runId: string, throughSeq: number): number;
  planInheritance: ReferenceReader['planInheritance'];
  readInheritedWindow: ReferenceReader['readInheritedWindow'];
};

const typePlaceholders = (types: readonly string[]): { list: string; bound: Record<string, string> } => ({
  list: types.map((_type, index) => `:type${index}`).join(', '),
  bound: Object.fromEntries(types.map((type, index) => [`type${index}`, type])),
});

export const createJournalReader = (db: DatabaseSync, options: JournalReaderOptions = {}): JournalReader => {
  const unit = options.unit ?? ((): void => undefined);
  const stepped = options.onRowsStepped ?? ((): void => undefined);
  const { memories, governing } = options.lookups ?? { memories: createMemoryStore(db, NO_CLOCK), governing: createGoverningFactStore(db, NO_CLOCK) };
  const selectRun = db.prepare('SELECT * FROM runs WHERE id = :id');
  const decodeContext = decodeContextOf(db);
  const reference = createReferenceReader(db, { unit, stepped, ...(options.onDecode === undefined ? {} : { onDecode: options.onDecode }), ...(options.onHop === undefined ? {} : { onHop: options.onHop }) });
  const pinnedDigests = db.prepare("SELECT seq, pinned_digest FROM events WHERE run_id = :runId AND type = 'model.requested' ORDER BY seq");

  const decodeEach = (rows: Iterable<Row>): RunEvent[] => {
    const events: RunEvent[] = [];
    for (const row of rows) {
      options.onDecode?.(1, typeof row['payload_json'] === 'string' ? Buffer.byteLength(row['payload_json']) : 0);
      events.push(...decodeRunEvents([row], decodeContext));
      unit();
    }
    return events;
  };

  const seqsOfNewPinnedLayers = (runId: string): number[] => {
    const known = new Set<string>();
    const wanted: number[] = [];
    for (const row of pinnedDigests.iterate({ runId })) {
      const reader = readerFor('events', runId, row);
      const digest = reader.nullableString('pinned_digest');
      if (digest !== null && known.has(digest)) continue;
      if (digest !== null) known.add(digest);
      wanted.push(reader.number('seq'));
      unit();
    }
    return wanted;
  };

  const lastSeqOf = (runId: string): number => {
    const row = selectRun.get({ id: runId });
    if (row === undefined) throw new Error(`unknown run ${runId}`);
    return decodeRun(row).lastSeq;
  };

  function* rangedRows(runId: string, lastSeq: number, types: readonly string[], excluding: boolean): Generator<Row> {
    const { list, bound } = typePlaceholders(types);
    const statement = db.prepare(
      excluding
        ? `SELECT * FROM events WHERE run_id = :runId AND seq >= :from AND seq < :until AND type NOT IN (${list}) ORDER BY seq`
        : `SELECT * FROM events WHERE run_id = :runId AND type IN (${list}) AND seq >= :from AND seq < :until`,
    );
    for (let from = 1; from <= lastSeq; from += JOURNAL_SCAN_RANGE_ROWS) {
      const until = Math.min(from + JOURNAL_SCAN_RANGE_ROWS, lastSeq + 1);
      const rows = statement.all({ runId, from, until, ...bound });
      yield* excluding ? rows : rows.sort((a, b) => Number(a['seq']) - Number(b['seq']));
      stepped(until - from);
      unit();
    }
  }

  const eventsOfTypes = (runId: string, types: readonly RunEventPayload['type'][]): RunEvent[] =>
    types.length === 0 ? [] : decodeEach(rangedRows(runId, lastSeqOf(runId), types, false));

  const visitRun = (runId: string, types: readonly RunEventPayload['type'][], visit: (event: RunEvent) => void, throughSeq?: number): Run =>
    readTx(db, () => {
      const row = selectRun.get({ id: runId });
      if (row === undefined) throw new Error(`unknown run ${runId}`);
      const run = decodeRun(row);
      if (types.length === 0) return run;
      for (const eventRow of rangedRows(runId, throughSeq === undefined ? run.lastSeq : Math.min(run.lastSeq, throughSeq), types, false)) {
        options.onDecode?.(1, typeof eventRow['payload_json'] === 'string' ? Buffer.byteLength(eventRow['payload_json']) : 0);
        for (const event of decodeRunEvents([eventRow], decodeContext)) visit(event);
        unit();
      }
      return run;
    });

  const walker = createRecordWalker(db, { unit, stepped, ...(options.onDecode === undefined ? {} : { onDecode: options.onDecode }) });

  const boundOf = (runId: string, throughSeq: number): number => Math.min(lastSeqOf(runId), throughSeq);

  const walkRun: JournalReader['walkRun'] = async (runId, types, visit, units, range = {}) => {
    const run = readTx(db, () => {
      const row = selectRun.get({ id: runId });
      if (row === undefined) throw new Error(`unknown run ${runId}`);
      return decodeRun(row);
    });
    await walker.walk(runId, range.throughSeq === undefined ? run.lastSeq : Math.min(run.lastSeq, range.throughSeq), types, visit, units, range.from === undefined ? {} : { from: range.from });
    return run;
  };

  const hookEventsOfTypes = (runId: string, types: readonly RunEventPayload['type'][]): RunEvent[] => {
    const plain = types.filter((type) => type !== 'model.requested');
    const events = eventsOfTypes(runId, plain);
    if (plain.length === types.length) return events;
    const requests = decodeEach(
      db
        .prepare(`SELECT ${HOOK_EVENT_COLUMNS} FROM events e WHERE e.run_id = :runId AND e.type = 'model.requested' AND e.seq IN (SELECT value FROM json_each(:seqs)) ORDER BY e.seq`)
        .iterate({ runId, seqs: JSON.stringify(seqsOfNewPinnedLayers(runId)) }),
    );
    return [...events, ...requests].sort((a, b) => a.seq - b.seq);
  };

  const replayRun = (run: Run, readEvents: readonly RunEvent[], visit: (state: RunState, event: RunEvent) => void, leading: readonly RunEvent[]): void => {
    const readTypes = [...new Set<string>([...readEvents.map((event) => event.type), 'model.requested'])];
    const rest = decodeEach(rangedRows(run.id, run.lastSeq, readTypes, true));
    const unread = leading.filter((event) => !readEvents.includes(event) && event.type !== 'model.requested');
    const journal = [...readEvents.filter((event) => event.type !== 'model.requested'), ...rest, ...unread].sort((a, b) => a.seq - b.seq);
    let state = initialRunState({ runId: run.id, sessionId: run.sessionId });
    for (const event of journal) {
      state = foldRunState(state, event);
      visit(state, event);
      unit();
    }
  };

  const copyOfInherited = (event: RunEvent): RunEvent => {
    if (event.type !== 'context.inherited' || !isReferenceInherited(event)) return event;
    const retained = reference.retainedOf(event);
    const copy: Omit<InheritedPayload, 'digest'> = {
      type: 'context.inherited',
      fromRunId: event.fromRunId,
      fromLastSeq: event.fromLastSeq,
      history: retained.entries,
      nextItemSeq: event.nextItemSeq,
      ...(retained.summary === undefined ? {} : { summary: retained.summary }),
      ...(event.workingFacts === undefined ? {} : { workingFacts: event.workingFacts }),
      evicted: retained.evicted,
      closures: event.closures,
      ...(event.partial === undefined ? {} : { partial: event.partial }),
      markers: event.markers,
      ...(event.fromMode === undefined ? {} : { fromMode: event.fromMode }),
      ...(event.mode === undefined ? {} : { mode: event.mode }),
      ...(event.activatedSkills === undefined ? {} : { activatedSkills: event.activatedSkills }),
    };
    return { ...copy, digest: copyDigestOf(copy), id: event.id, runId: event.runId, sessionId: event.sessionId, seq: event.seq, step: event.step, leaseToken: event.leaseToken, createdAt: event.createdAt };
  };

  const measure = (hook: TerminalContribution, request: ContributionRequest): ContributionMeasured =>
    readTx(db, () => {
      const row = selectRun.get({ id: request.runId });
      if (row === undefined) throw new Error(`unknown run ${request.runId}`);
      const run = decodeRun(row);
      const leading = request.leading.map(
        (payload, index): RunEvent => ({
          ...payload,
          id: 0,
          runId: run.id,
          sessionId: run.sessionId,
          seq: run.lastSeq + 1 + index,
          step: Math.max(run.step, payloadStep(payload)),
          leaseToken: run.leaseToken,
          createdAt: 0,
        }),
      );
      const events = [...hookEventsOfTypes(run.id, hook.eventTypes).map(copyOfInherited), ...leading.filter((event) => hook.eventTypes.includes(event.type))];
      const contribution = hook.measure({ run, events, replay: (visit) => replayRun(run, events, visit, leading), memories, governing, unit });
      return contribution === undefined ? { lastSeq: run.lastSeq } : { lastSeq: run.lastSeq, contribution };
    });

  return { measure, eventsOfTypes, visitRun, walkRun, visitRecord: reference.visitRecord, verdictRows: createVerdictReader(db).rowsOf, boundOf, planInheritance: reference.planInheritance, readInheritedWindow: reference.readInheritedWindow };
};
