import type { DatabaseSync } from 'node:sqlite';
import { immediateTx } from '@momonga/foundation';
import {
  APPROVAL_BASES,
  INDICATOR_DEFINITIONS_VERSION,
  PERMISSION_MODES,
  RECOVERY_CAUSES,
  RECOVERY_OUTCOMES,
  RUN_STATUSES,
  SIDE_EFFECTS,
  STOP_REASONS,
  TERMINAL_STATUSES,
} from '@momonga/protocol';
import type { RecoveryEpisodeView, ReportPage, RunCallView, RunFactsView } from '@momonga/protocol';
import { readerFor, refuseUnknown, storedOneOf } from './rows.ts';
import type { DecodeContext } from './decode-context.ts';
import type { Row } from './rows.ts';
import type { FactsBatch, FactsCommit, FactsCursor, RunFactsStore, StoredFacts } from './types.ts';

const TERMINAL_LIST = TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ');

const STOP_REASON_LIST = STOP_REASONS.map((reason) => `'${reason}'`).join(', ');

const optional = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } => (value === null ? {} : ({ [key]: value } as { [P in K]: V }));

const episodeOf = (row: Row, context: DecodeContext): RecoveryEpisodeView => {
  const reader = readerFor('run_recoveries', `${String(row['run_id'])}/${String(row['ordinal'])}`, row);
  const identity = `${String(row['run_id'])}/${String(row['ordinal'])}`;
  return {
    ordinal: reader.number('ordinal'),
    cause: storedOneOf(context, 'run_recoveries', identity, 'cause', RECOVERY_CAUSES, reader.string('cause')),
    failedAt: reader.number('failed_at'),
    progressAt: reader.nullableNumber('progress_at'),
    outcome: storedOneOf(context, 'run_recoveries', identity, 'outcome', RECOVERY_OUTCOMES, reader.string('outcome')),
    startedSeq: reader.number('started_seq'),
    progressSeq: reader.nullableNumber('progress_seq'),
  };
};

const callOf = (row: Row, context: DecodeContext): RunCallView => {
  const identity = `${String(row['run_id'])}/${String(row['call_id'])}`;
  const reader = readerFor('run_calls', identity, row);
  const basis = reader.nullableString('basis');
  const sideEffect = reader.nullableString('side_effect');
  return {
    runId: reader.string('run_id'),
    callId: reader.string('call_id'),
    basis: basis === null ? null : storedOneOf(context, 'run_calls', identity, 'basis', APPROVAL_BASES, basis),
    sideEffect: sideEffect === null ? null : storedOneOf(context, 'run_calls', identity, 'side_effect', SIDE_EFFECTS, sideEffect),
    asked: reader.flag('asked'),
  };
};

const factsOf = (row: Row, recoveries: RecoveryEpisodeView[], context: DecodeContext): RunFactsView => {
  const identity = String(row['run_id']);
  const reader = readerFor('run_facts', identity, row);
  const stopReason = reader.nullableString('stop_reason');
  const maxSteps = reader.nullableNumber('max_steps');
  const maxTotalTokens = reader.nullableNumber('max_total_tokens');
  const deadlineAt = reader.nullableNumber('deadline_at');
  return {
    runId: identity,
    rootRunId: reader.string('root_run_id'),
    sessionId: reader.string('session_id'),
    definitionsVersion: reader.number('definitions_version'),
    modelAlias: reader.string('model_alias'),
    mode: storedOneOf(context, 'run_facts', identity, 'mode', PERMISSION_MODES, reader.string('mode')),
    agent: reader.string('agent'),
    origin: reader.string('origin'),
    status: storedOneOf(context, 'run_facts', identity, 'status', RUN_STATUSES, reader.string('status')),
    ...(stopReason === null ? {} : { stopReason: storedOneOf(context, 'run_facts', identity, 'stop_reason', STOP_REASONS, stopReason) }),
    createdAt: reader.number('created_at'),
    endedAt: reader.number('ended_at'),
    elapsedMs: reader.number('elapsed_ms'),
    humanWaitMs: reader.number('human_wait_ms'),
    tokensTotal: reader.number('tokens_total'),
    steps: reader.number('steps'),
    limits: { ...optional('maxSteps', maxSteps), ...optional('maxTotalTokens', maxTotalTokens) },
    ...optional('deadlineAt', deadlineAt),
    asked: reader.number('asked'),
    elicited: reader.number('elicited'),
    authorizationRequired: reader.number('authorization_required'),
    sideEffectingCalls: reader.number('side_effecting_calls'),
    repeatedStarts: reader.number('repeated_starts'),
    reconciledAlreadyApplied: reader.number('reconciled_already_applied'),
    reconciledNotApplied: reader.number('reconciled_not_applied'),
    reconciledUnknown: reader.number('reconciled_unknown'),
    basis: {
      readOnly: reader.number('basis_read_only'),
      rule: reader.number('basis_rule'),
      mode: reader.number('basis_mode'),
      hook: reader.number('basis_hook'),
      classifier: reader.number('basis_classifier'),
      person: reader.number('basis_person'),
    },
    declared: reader.flag('declared'),
    met: reader.flag('met'),
    recoveries,
  };
};

export const createRunFactsStore = (db: DatabaseSync, context: DecodeContext): RunFactsStore => {
  const readCursor = db.prepare('SELECT definitions_version, after_event_id FROM facts_cursor WHERE id = 1');
  const writeCursor = db.prepare('UPDATE facts_cursor SET definitions_version = :version, after_event_id = :eventId WHERE id = 1');
  const nextTerminal = db.prepare(
    `SELECT e.id AS event_id, e.run_id
     FROM events e JOIN runs r ON r.id = e.run_id
     WHERE e.id > :cursor AND e.type = 'run.status' AND r.status IN (${TERMINAL_LIST}) AND (r.stop_reason IS NULL OR r.stop_reason IN (${STOP_REASON_LIST}))
       AND e.seq = (SELECT MAX(x.seq) FROM events x WHERE x.run_id = e.run_id AND x.type = 'run.status')
     ORDER BY e.id LIMIT :limit`,
  );
  const deleteRecoveries = db.prepare('DELETE FROM run_recoveries WHERE run_id = :runId');
  const insertRecovery = db.prepare(
    `INSERT INTO run_recoveries (run_id, ordinal, cause, failed_at, progress_at, outcome, started_seq, progress_seq)
     VALUES (:runId, :ordinal, :cause, :failedAt, :progressAt, :outcome, :startedSeq, :progressSeq)`,
  );
  const upsertFacts = db.prepare(
    `INSERT OR REPLACE INTO run_facts (
       run_id, unavailable, definitions_version, root_run_id, session_id, model_alias, mode, agent, origin, status, stop_reason,
       created_at, ended_at, elapsed_ms, human_wait_ms, tokens_total, steps, max_steps, max_total_tokens, deadline_at,
       asked, elicited, authorization_required, side_effecting_calls, repeated_starts,
       reconciled_already_applied, reconciled_not_applied, reconciled_unknown,
       basis_read_only, basis_rule, basis_mode, basis_hook, basis_classifier, basis_person, declared, met
     ) VALUES (
       :runId, 0, :definitionsVersion, :rootRunId, :sessionId, :modelAlias, :mode, :agent, :origin, :status, :stopReason,
       :createdAt, :endedAt, :elapsedMs, :humanWaitMs, :tokensTotal, :steps, :maxSteps, :maxTotalTokens, :deadlineAt,
       :asked, :elicited, :authorizationRequired, :sideEffectingCalls, :repeatedStarts,
       :reconciledAlreadyApplied, :reconciledNotApplied, :reconciledUnknown,
       :basisReadOnly, :basisRule, :basisMode, :basisHook, :basisClassifier, :basisPerson, :declared, :met
     )`,
  );
  const upsertUnavailable = db.prepare(
    `INSERT OR REPLACE INTO run_facts (run_id, unavailable, definitions_version, root_run_id) VALUES (
       :runId, 1, :version,
       (WITH RECURSIVE up (id, parent) AS (
          SELECT id, parent_run_id FROM runs WHERE id = :runId
          UNION ALL
          SELECT r.id, r.parent_run_id FROM runs r JOIN up ON r.id = up.parent
        ) SELECT id FROM up WHERE parent IS NULL)
     )`,
  );
  const deleteCalls = db.prepare('DELETE FROM run_calls WHERE run_id = :runId');
  const insertCall = db.prepare('INSERT INTO run_calls (run_id, call_id, basis, side_effect, asked) VALUES (:runId, :callId, :basis, :sideEffect, :asked)');
  const firstCalls = db.prepare('SELECT * FROM run_calls ORDER BY run_id, call_id LIMIT :limit');
  const nextCalls = db.prepare('SELECT * FROM run_calls WHERE run_id > :runId OR (run_id = :runId AND call_id > :callId) ORDER BY run_id, call_id LIMIT :limit');
  const factsRow = db.prepare('SELECT * FROM run_facts WHERE run_id = :runId');
  const recoveriesOf = db.prepare('SELECT * FROM run_recoveries WHERE run_id = :runId ORDER BY ordinal');
  const pageRows = db.prepare('SELECT * FROM run_facts WHERE run_id > :after ORDER BY run_id LIMIT :limit');
  const pageRecoveries = db.prepare('SELECT * FROM run_recoveries WHERE run_id > :after AND run_id <= :last ORDER BY run_id, ordinal');

  const cursor = (): FactsCursor => {
    const row = readCursor.get();
    if (row === undefined) throw new Error('the facts cursor row is missing');
    const reader = readerFor('facts_cursor', '1', row);
    if (reader.number('definitions_version') !== INDICATOR_DEFINITIONS_VERSION) return { definitionsVersion: INDICATOR_DEFINITIONS_VERSION, afterEventId: 0 };
    return { definitionsVersion: INDICATOR_DEFINITIONS_VERSION, afterEventId: reader.number('after_event_id') };
  };

  const storeFacts = (facts: RunFactsView): void => {
    refuseUnknown(`the facts of run ${facts.runId}`, [facts.mode, facts.status, facts.stopReason, ...facts.recoveries.flatMap((episode) => [episode.cause, episode.outcome])]);
    deleteRecoveries.run({ runId: facts.runId });
    upsertFacts.run({
      runId: facts.runId,
      definitionsVersion: facts.definitionsVersion,
      rootRunId: facts.rootRunId,
      sessionId: facts.sessionId,
      modelAlias: facts.modelAlias,
      mode: facts.mode,
      agent: facts.agent,
      origin: facts.origin,
      status: facts.status,
      stopReason: facts.stopReason ?? null,
      createdAt: facts.createdAt,
      endedAt: facts.endedAt,
      elapsedMs: facts.elapsedMs,
      humanWaitMs: facts.humanWaitMs,
      tokensTotal: facts.tokensTotal,
      steps: facts.steps,
      maxSteps: facts.limits.maxSteps ?? null,
      maxTotalTokens: facts.limits.maxTotalTokens ?? null,
      deadlineAt: facts.deadlineAt ?? null,
      asked: facts.asked,
      elicited: facts.elicited,
      authorizationRequired: facts.authorizationRequired,
      sideEffectingCalls: facts.sideEffectingCalls,
      repeatedStarts: facts.repeatedStarts,
      reconciledAlreadyApplied: facts.reconciledAlreadyApplied,
      reconciledNotApplied: facts.reconciledNotApplied,
      reconciledUnknown: facts.reconciledUnknown,
      basisReadOnly: facts.basis.readOnly,
      basisRule: facts.basis.rule,
      basisMode: facts.basis.mode,
      basisHook: facts.basis.hook,
      basisClassifier: facts.basis.classifier,
      basisPerson: facts.basis.person,
      declared: facts.declared ? 1 : 0,
      met: facts.met ? 1 : 0,
    });
    for (const episode of facts.recoveries) {
      insertRecovery.run({
        runId: facts.runId,
        ordinal: episode.ordinal,
        cause: episode.cause,
        failedAt: episode.failedAt,
        progressAt: episode.progressAt,
        outcome: episode.outcome,
        startedSeq: episode.startedSeq,
        progressSeq: episode.progressSeq,
      });
    }
  };

  return {
    cursor,

    nextBatch: (limit): FactsBatch => {
      const { afterEventId } = cursor();
      const rows = nextTerminal.all({ cursor: afterEventId, limit });
      const last = rows.at(-1);
      return {
        runIds: rows.map((row) => readerFor('events', String(row['event_id']), row).string('run_id')),
        throughEventId: last === undefined ? afterEventId : readerFor('events', String(last['event_id']), last).number('event_id'),
      };
    },

    commit: (batch: FactsCommit): void => {
      immediateTx(db, () => {
        for (const facts of batch.rows) {
          storeFacts(facts);
          deleteCalls.run({ runId: facts.runId });
        }
        for (const runId of batch.unavailable) {
          deleteCalls.run({ runId });
          deleteRecoveries.run({ runId });
          upsertUnavailable.run({ runId, version: INDICATOR_DEFINITIONS_VERSION });
        }
        for (const call of batch.calls) {
          refuseUnknown(`call ${call.callId} of run ${call.runId}`, [call.basis, call.sideEffect]);
          insertCall.run({ runId: call.runId, callId: call.callId, basis: call.basis, sideEffect: call.sideEffect, asked: call.asked ? 1 : 0 });
        }
        writeCursor.run({ version: INDICATOR_DEFINITIONS_VERSION, eventId: batch.throughEventId });
      });
    },

    get: (runId): StoredFacts | undefined => {
      const row = factsRow.get({ runId });
      if (row === undefined) return undefined;
      if (readerFor('run_facts', runId, row).flag('unavailable')) return { kind: 'unavailable' };
      return { kind: 'facts', facts: factsOf(row, recoveriesOf.all({ runId }).map((recovery) => episodeOf(recovery, context)), context) };
    },

    page: (after, limit): ReportPage => {
      const rows = pageRows.all({ after, limit: limit + 1 });
      const shown = rows.slice(0, limit);
      const last = shown.at(-1);
      if (last === undefined) return { rows: [], unavailable: [], nextCursor: null };
      const lastId = readerFor('run_facts', 'page', last).string('run_id');
      const episodes = new Map<string, RecoveryEpisodeView[]>();
      for (const row of pageRecoveries.all({ after, last: lastId })) {
        const runId = readerFor('run_recoveries', 'page', row).string('run_id');
        episodes.set(runId, [...(episodes.get(runId) ?? []), episodeOf(row, context)]);
      }
      const available = shown.filter((row) => !readerFor('run_facts', 'page', row).flag('unavailable'));
      const unavailable = shown.filter((row) => readerFor('run_facts', 'page', row).flag('unavailable'));
      return {
        rows: available.map((row) => factsOf(row, episodes.get(readerFor('run_facts', 'page', row).string('run_id')) ?? [], context)),
        unavailable: unavailable.map((row) => {
          const reader = readerFor('run_facts', 'page', row);
          return { runId: reader.string('run_id'), rootRunId: reader.string('root_run_id') };
        }),
        nextCursor: rows.length > limit ? lastId : null,
      };
    },

    calls: (after, limit): RunCallView[] =>
      (after === null ? firstCalls.all({ limit }) : nextCalls.all({ runId: after.runId, callId: after.callId, limit })).map((row) => callOf(row, context)),
  };
};
