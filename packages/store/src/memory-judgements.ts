import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '@momonga/foundation';
import { CLASSIFIER_CONFIDENCES, CLASSIFIER_VERDICTS, MEMORY_JUDGEMENT_OUTCOMES } from '@momonga/protocol';
import type { MemoryJudgement, MemoryRecord, RunEventPayload, SessionEventPayload, Stored } from '@momonga/protocol';
import { readerFor, storedOneOf } from './rows.ts';
import type { DecodeContext } from './decode-context.ts';
import type { Row } from './rows.ts';

type ClassifierVerdictValue = NonNullable<MemoryJudgement['verdict']>;

type ClassifierConfidenceValue = NonNullable<MemoryJudgement['confidence']>;

export type StoredMemoryJudgement = {
  memoryId: string;
  outcome: Stored<MemoryJudgement['outcome']>;
  classifier?: string;
  verdict?: Stored<ClassifierVerdictValue>;
  confidence?: Stored<ClassifierConfidenceValue>;
  failure?: string;
  judgedAt: number;
  owed: boolean;
  closed: boolean;
};

export type MemoryJudgementCommit = Omit<MemoryJudgement, 'judgedAt'> & {
  charge?: Extract<RunEventPayload, { type: 'usage.charged' }>;
  openSessionIds: readonly string[];
};

export type MemoryJudgementsStore = {
  next(project: string): MemoryRecord | undefined;
  commit(judgement: MemoryJudgementCommit): 'recorded' | 'discarded';
  get(memoryId: string): StoredMemoryJudgement | undefined;
  owed(project: string): StoredMemoryJudgement[];
  markShown(memoryIds: readonly string[]): void;
};

export type MemoryJudgementWriters = {
  transaction<T>(fn: () => T): T;
  memories: { get(id: string): MemoryRecord | undefined; candidates(filter: { project: string }): MemoryRecord[]; keepByClassifier(id: string, classifier: string): boolean };
  endedRun: { append(runId: string, payloads: readonly RunEventPayload[]): void };
  sessionEvent: { append(sessionId: string, payload: SessionEventPayload): void };
};

const judgementOf = (row: Row, context: DecodeContext): StoredMemoryJudgement => {
  const identity = String(row['memory_id']);
  const reader = readerFor('memory_judgements', identity, row);
  const classifier = reader.nullableString('classifier');
  const verdict = reader.nullableString('verdict');
  const confidence = reader.nullableString('confidence');
  const failure = reader.nullableString('failure');
  return {
    memoryId: reader.string('memory_id'),
    outcome: storedOneOf(context, 'memory_judgements', identity, 'outcome', MEMORY_JUDGEMENT_OUTCOMES, reader.string('outcome')),
    ...(classifier === null ? {} : { classifier }),
    ...(verdict === null ? {} : { verdict: storedOneOf(context, 'memory_judgements', identity, 'verdict', CLASSIFIER_VERDICTS, verdict) }),
    ...(confidence === null ? {} : { confidence: storedOneOf(context, 'memory_judgements', identity, 'confidence', CLASSIFIER_CONFIDENCES, confidence) }),
    ...(failure === null ? {} : { failure }),
    judgedAt: reader.number('judged_at'),
    owed: reader.nullableNumber('shown_at') === null && reader.nullableNumber('closed_at') === null,
    closed: reader.nullableNumber('closed_at') !== null,
  };
};

export const createMemoryJudgementsStore = (db: DatabaseSync, clock: Clock, context: DecodeContext, writers: MemoryJudgementWriters): MemoryJudgementsStore => {
  const waiting = db.prepare(
    "SELECT 1 AS found FROM memories m WHERE m.id = :id AND m.state = 'candidate' AND m.retired_at IS NULL AND NOT EXISTS (SELECT 1 FROM memory_judgements j WHERE j.memory_id = m.id)",
  );
  const sourceRun = db.prepare('SELECT source_run_id FROM memories WHERE id = :id');
  const insert = db.prepare(
    `INSERT INTO memory_judgements (memory_id, outcome, classifier, verdict, confidence, failure, judged_at)
     VALUES (:memoryId, :outcome, :classifier, :verdict, :confidence, :failure, :judgedAt)`,
  );
  const byId = db.prepare('SELECT * FROM memory_judgements WHERE memory_id = :memoryId');
  const owedInReviewOrder = db.prepare(
    `SELECT j.* FROM memory_judgements j JOIN memories m ON m.id = j.memory_id
     WHERE j.shown_at IS NULL AND j.closed_at IS NULL
     ORDER BY m.created_at, m.id`,
  );
  const markShown = db.prepare('UPDATE memory_judgements SET shown_at = :now WHERE memory_id IN (SELECT value FROM json_each(:ids)) AND shown_at IS NULL');

  const chargedRunOf = (memoryId: string): string => {
    const row = sourceRun.get({ id: memoryId });
    if (row === undefined) throw new Error(`memory ${memoryId} does not exist, so its judgement has no run to charge`);
    const runId = readerFor('memories', memoryId, row).nullableString('source_run_id');
    if (runId === null) throw new Error(`memory ${memoryId} has no source run to charge its judgement to`);
    return runId;
  };

  return {
    next: (project) => writers.memories.candidates({ project }).find((memory) => memory.retiredAt === null && byId.get({ memoryId: memory.id }) === undefined),
    commit: ({ memoryId, outcome, classifier, verdict, confidence, failure, charge, openSessionIds }) =>
      writers.transaction<'recorded' | 'discarded'>(() => {
        if (charge !== undefined) writers.endedRun.append(chargedRunOf(memoryId), [charge]);
        if (waiting.get({ id: memoryId }) === undefined) return 'discarded';
        const judgedAt = clock.now();
        insert.run({ memoryId, outcome, classifier: classifier ?? null, verdict: verdict ?? null, confidence: confidence ?? null, failure: failure ?? null, judgedAt });
        if (outcome === 'kept') {
          if (classifier === undefined) throw new RangeError(`memory ${memoryId} cannot be kept without the classifier that kept it`);
          if (!writers.memories.keepByClassifier(memoryId, classifier)) throw new Error(`memory ${memoryId} stopped waiting while it was kept`);
        }
        for (const sessionId of openSessionIds) writers.sessionEvent.append(sessionId, { type: 'memory.judged', memoryId });
        return 'recorded';
      }),
    get: (memoryId) => {
      const row = byId.get({ memoryId });
      return row === undefined ? undefined : judgementOf(row, context);
    },
    owed: (project) => owedInReviewOrder.all().map((row) => judgementOf(row, context)).filter((judgement) => writers.memories.get(judgement.memoryId)?.project === project),
    markShown: (memoryIds) => {
      markShown.run({ ids: JSON.stringify(memoryIds), now: clock.now() });
    },
  };
};
