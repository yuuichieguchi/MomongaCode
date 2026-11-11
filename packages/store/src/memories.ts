import type { DatabaseSync } from 'node:sqlite';
import { immediateTx, joinedTx, readTx, uuidv7 } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { DEFAULT_MEMORY_KIND, MEMORY_EVIDENCE_KINDS, MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_SCOPES, MEMORY_STATES, MEMORY_STATUSES } from '@momonga/protocol';
import type { MemoryEvidence, MemoryOrigin, MemoryScope, MemorySource, MemoryState, MemoryStatus, Stored, StoredMemoryEvidence, StoredMemorySource } from '@momonga/protocol';
import { UNKNOWN_VALUE, corrupt, readerFor, storedOneOf } from './rows.ts';
import type { DecodeContext } from './decode-context.ts';
import type { Row, RowReader } from './rows.ts';
import { createDerivedSnapshot } from './derived-repair.ts';
import { revisionChain } from './revision-chain.ts';
import { asciiLower, instrFilters, partitionTerms, quoted } from './search-terms.ts';
import { MEMORY_MATCH_LIMIT, MEMORY_SCAN_LIMIT } from './memory-constants.ts';
import type { MemoryChange, MemoryRecord, MemoryStore, MemoryVisibility, RecallCursor, RecallPage, SaveMemoryInput } from './types.ts';

const REFLECTION_SOURCE_STEP = 0;

const REFLECTION_SOURCE_SEQ = 0;

const REFLECTION_CALL_ID = /^reflection:(\d+)$/;

const SOURCE_KINDS = ['tool', 'reflection', 'command'] as const;

const decodeSource = (context: DecodeContext, identity: string, reader: RowReader): StoredMemorySource => {
  const kind = storedOneOf(context, 'memories', identity, 'source_kind', SOURCE_KINDS, reader.string('source_kind'));
  if (kind === UNKNOWN_VALUE) return { kind };
  if (kind === 'command') return { kind, at: reader.number('created_at') };
  const sessionId = reader.string('source_session_id');
  const runId = reader.string('source_run_id');
  const callId = reader.string('source_call_id');
  if (kind === 'tool') return { kind, sessionId, runId, step: reader.number('source_step'), callId, seq: reader.number('source_seq') };
  const match = REFLECTION_CALL_ID.exec(callId);
  if (match === null) throw corrupt('memories', identity, `reflection source_call_id ${callId} does not name an ordinal`);
  return { kind, sessionId, runId, ordinal: Number(match[1]) };
};

const decodeStringList = (identity: string, reader: RowReader, column: string): string[] => {
  const value = reader.json(column);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw corrupt('memories', identity, `column ${column} must be a JSON array of strings`);
  return value as string[];
};

const decodeEvidence = (context: DecodeContext, memoryId: string, row: Row): StoredMemoryEvidence => {
  const identity = `${memoryId}/${String(row['ordinal'])}`;
  const reader = readerFor('memory_evidence', identity, row);
  const kind = storedOneOf(context, 'memory_evidence', identity, 'kind', MEMORY_EVIDENCE_KINDS, reader.string('kind'));
  switch (kind) {
    case UNKNOWN_VALUE:
      return { kind };
    case 'file':
      return { kind, project: reader.string('project'), path: reader.string('path'), sha256: reader.string('sha256') };
    case 'commit':
      return { kind, sha: reader.string('sha') };
    case 'check':
      return { kind, runId: reader.string('run_id'), conditionId: reader.string('call_id'), seq: reader.number('seq'), command: reader.string('command'), exitCode: reader.number('exit_code') };
  }
};

const decodeObservedStatus = (context: DecodeContext, identity: string, reader: RowReader): Stored<MemoryStatus> | null => {
  const status = reader.nullableString('observed_status');
  return status === null ? null : storedOneOf(context, 'memories', identity, 'observed_status', MEMORY_STATUSES, status);
};

const decodeMemory = (context: DecodeContext, row: Row, evidence: StoredMemoryEvidence[], supersededBy: string[]): MemoryRecord => {
  const identity = String(row['id']);
  const reader = readerFor('memories', identity, row);
  const scope = storedOneOf(context, 'memories', identity, 'scope', MEMORY_SCOPES, reader.string('scope'));
  const origin = storedOneOf(context, 'memories', identity, 'origin', MEMORY_ORIGINS, reader.string('origin'));
  const project = reader.nullableString('project');
  if (scope !== UNKNOWN_VALUE && (scope === 'project') !== (project !== null)) throw corrupt('memories', identity, `scope ${scope} does not match project ${String(project)}`);
  return {
    id: reader.string('id'),
    scope,
    origin,
    project,
    text: reader.string('text'),
    source: decodeSource(context, identity, reader),
    createdAt: reader.number('created_at'),
    keptAt: reader.number('kept_at'),
    kind: storedOneOf(context, 'memories', identity, 'kind', MEMORY_KINDS, reader.string('kind')),
    state: storedOneOf(context, 'memories', identity, 'state', MEMORY_STATES, reader.string('state')),
    duplicateOf: reader.nullableString('duplicate_of'),
    supersedes: decodeStringList(identity, reader, 'supersedes_json'),
    supersededBy,
    retiredAt: reader.nullableNumber('retired_at'),
    contributedAt: reader.nullableNumber('contributed_at'),
    observedStatus: decodeObservedStatus(context, identity, reader),
    evidence,
  };
};

const RECENCY = 'ORDER BY kept_at DESC, created_at DESC, id';

const recallableUntil = (successorBound: string): string => `state = 'active' AND retired_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM memory_replacements AS r JOIN memories AS successor ON successor.id = r.successor_id
  WHERE r.replaced_id = memories.id AND successor.state <> 'candidate'${successorBound}
)`;

const RECALLABLE = recallableUntil('');

const SEARCHABLE_WITH_HISTORY = "state <> 'candidate'";

const VISIBLE_TRUSTED = "((scope = 'user' AND origin = 'trusted') OR (scope = 'project' AND project = :project))";

const VISIBLE_UNTRUSTED = "scope = 'user'";

const LANE = "(CASE WHEN scope = 'user' THEN 'user:' || origin WHEN scope = 'project' THEN 'project:' || project END)";

const TIER = `(CASE observed_status ${MEMORY_STATUSES.map((status, tier) => `WHEN '${status}' THEN ${tier}`).join(' ')} ELSE ${MEMORY_STATUSES.length} END)`;

const CONTRIBUTED_KEY = '(-COALESCE(contributed_at, -1))';

const KEPT_KEY = '(-kept_at)';

const RECALL_KEYS = `${TIER}, ${CONTRIBUTED_KEY}, ${KEPT_KEY}, id`;

const RECALL_ORDER = `ORDER BY ${RECALL_KEYS}`;

const lanesOf = (visibility: MemoryVisibility): string[] => (visibility.trusted ? ['user:trusted', `project:${visibility.project}`] : ['user:trusted', 'user:untrusted']);

const cursorKeys = (cursor: RecallCursor): Record<string, string | number> => ({ cursorTier: cursor.tier, cursorContributed: cursor.contributed, cursorKept: cursor.kept, cursorId: cursor.id });

const cursorOf = (part: RecallCursor['part'], row: Row): RecallCursor => {
  const reader = readerFor('memories', String(row['id']), row);
  return { part, tier: reader.number('recall_tier'), contributed: reader.number('recall_contributed'), kept: reader.number('recall_kept'), id: reader.string('id') };
};

export const createMemoryStore = (db: DatabaseSync, clock: Clock, context: DecodeContext): MemoryStore => {
  const derived = createDerivedSnapshot(db, context);
  const insert = db.prepare(
    `INSERT INTO memories (id, scope, origin, project, text, source_session_id, source_run_id, source_step, source_call_id, source_seq, created_at, kept_at, kind, supersedes_json)
     VALUES (:id, :scope, :origin, :project, :text, :sessionId, :runId, :step, :callId, :seq, :now, :now, :kind, :supersedesJson)`,
  );
  const insertByCommand = db.prepare(
    `INSERT INTO memories (id, scope, origin, project, text, created_at, kept_at, kind, source_kind)
     VALUES (:id, :scope, 'trusted', :project, :text, :now, :now, :kind, 'command')`,
  );
  const insertEvidence = db.prepare(
    `INSERT INTO memory_evidence (memory_id, ordinal, kind, project, path, sha256, sha, run_id, call_id, seq, command, exit_code)
     VALUES (:memoryId, :ordinal, :kind, :project, :path, :sha256, :sha, :runId, :callId, :seq, :command, :exitCode)`,
  );
  const successors = db.prepare('SELECT m.* FROM memory_replacements r JOIN memories m ON m.id = r.successor_id WHERE r.replaced_id = :id');
  const retireOnce = db.prepare('UPDATE memories SET retired_at = :now WHERE id = :id AND retired_at IS NULL');
  const bySource = db.prepare('SELECT * FROM memories WHERE source_run_id = :runId AND source_call_id = :callId');
  const byId = db.prepare('SELECT * FROM memories WHERE id = :id');
  const all = db.prepare('SELECT * FROM memories ORDER BY created_at, id');
  const byScope = db.prepare('SELECT * FROM memories WHERE scope = :scope ORDER BY created_at, id');
  const byProject = db.prepare('SELECT * FROM memories WHERE project = :project ORDER BY created_at, id');
  const evidenceOf = db.prepare('SELECT * FROM memory_evidence WHERE memory_id = :id ORDER BY ordinal');
  const replacedBy = db.prepare(
    "SELECT m.id FROM memory_replacements r JOIN memories m ON m.id = r.successor_id WHERE r.replaced_id = :id AND m.state <> 'candidate' ORDER BY m.created_at, m.id",
  );
  const decode = (row: Row): MemoryRecord => {
    const id = String(row['id']);
    return decodeMemory(
      context,
      row,
      evidenceOf.all({ id }).map((evidenceRow) => decodeEvidence(context, id, evidenceRow)),
      replacedBy.all({ id }).map((successor) => readerFor('memories', id, successor).string('id')),
    );
  };
  const evidenceOfMany = db.prepare('SELECT * FROM memory_evidence WHERE memory_id IN (SELECT value FROM json_each(:ids)) ORDER BY memory_id, ordinal');
  const replacedByMany = db.prepare(
    `SELECT r.replaced_id AS replaced_id, m.id AS id FROM memory_replacements r JOIN memories m ON m.id = r.successor_id
     WHERE r.replaced_id IN (SELECT value FROM json_each(:ids)) AND m.state <> 'candidate' ORDER BY m.created_at, m.id`,
  );
  const decodeMany = (rows: readonly Row[]): MemoryRecord[] => {
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map((row) => String(row['id'])));
    const evidenceById = new Map<string, StoredMemoryEvidence[]>();
    for (const evidenceRow of evidenceOfMany.all({ ids })) {
      const memoryId = readerFor('memory_evidence', 'page', evidenceRow).string('memory_id');
      evidenceById.set(memoryId, [...(evidenceById.get(memoryId) ?? []), decodeEvidence(context, memoryId, evidenceRow)]);
    }
    const successorsById = new Map<string, string[]>();
    for (const successorRow of replacedByMany.all({ ids })) {
      const reader = readerFor('memories', 'page', successorRow);
      const replacedId = reader.string('replaced_id');
      successorsById.set(replacedId, [...(successorsById.get(replacedId) ?? []), reader.string('id')]);
    }
    return rows.map((row) => {
      const id = String(row['id']);
      return decodeMemory(context, row, evidenceById.get(id) ?? [], successorsById.get(id) ?? []);
    });
  };
  const stamp = db.prepare('UPDATE memories SET contributed_at = :at WHERE id = :id AND (contributed_at IS NULL OR contributed_at < :at)');
  const supersededIds = db.prepare(
    "SELECT DISTINCT r.replaced_id AS id FROM memory_replacements r JOIN memories successor ON successor.id = r.successor_id WHERE successor.state <> 'candidate'",
  );
  const activePage = db.prepare(
    "SELECT * FROM memories WHERE state = 'active' AND retired_at IS NULL AND (created_at, id) > (:createdAt, :id) ORDER BY created_at, id LIMIT :limit",
  );
  let revision = 0;
  const insertCandidate = db.prepare(
    `INSERT INTO memories (id, scope, origin, project, text, source_session_id, source_run_id, source_step, source_call_id, source_seq, created_at, kept_at, kind, state, source_kind)
     VALUES (:id, :scope, :origin, :project, :text, :sessionId, :runId, ${REFLECTION_SOURCE_STEP}, :callId, ${REFLECTION_SOURCE_SEQ}, :now, :now, :kind, 'candidate', 'reflection')`,
  );
  const sessionOfRun = db.prepare('SELECT session_id FROM runs WHERE id = :runId');
  const candidateRows = db.prepare("SELECT * FROM memories WHERE state = 'candidate' ORDER BY created_at, id");
  const candidateRowsOfProject = db.prepare("SELECT * FROM memories WHERE state = 'candidate' AND project = :project ORDER BY created_at, id");
  const moveState = db.prepare(
    'UPDATE memories SET state = :to, duplicate_of = :duplicateOf, kept_at = CASE WHEN :kept = 1 THEN :now ELSE kept_at END WHERE id = :id AND state = :from',
  );
  const newestObservation = db.prepare('SELECT status, ordinal FROM memory_observations WHERE memory_id = :id ORDER BY ordinal DESC LIMIT 1');
  const insertObservation = db.prepare('INSERT INTO memory_observations (memory_id, ordinal, status, observed_at) VALUES (:id, :ordinal, :status, :now)');
  const observationsOf = db.prepare('SELECT status, observed_at FROM memory_observations WHERE memory_id = :id ORDER BY ordinal');

  const appendObservation = (id: string, status: MemoryStatus): boolean => {
    const newest = newestObservation.get({ id });
    if (newest !== undefined) {
      const reader = readerFor('memory_observations', id, newest);
      if (reader.string('status') === status) return false;
      insertObservation.run({ id, ordinal: reader.number('ordinal') + 1, status, now: clock.now() });
      return true;
    }
    insertObservation.run({ id, ordinal: 0, status, now: clock.now() });
    return true;
  };

  const observeUnboundWithoutEvidence = (id: string, evidence: readonly MemoryEvidence[]): void => {
    if (evidence.length === 0) appendObservation(id, 'unbound');
  };

  const change = <Done extends string, Refused extends string>(
    id: string,
    from: MemoryState,
    to: MemoryState,
    outcome: { done: Done; refused: Refused },
    options: { duplicateOf?: string; kept?: boolean } = {},
  ): MemoryChange<Done, Refused> =>
    immediateTx(db, () => {
      if (byId.get({ id }) === undefined) return { kind: 'not_found' };
      const moved = Number(moveState.run({ id, from, to, duplicateOf: options.duplicateOf ?? null, kept: options.kept === true ? 1 : 0, now: clock.now() }).changes) === 1;
      const row = byId.get({ id });
      if (row === undefined) throw new Error(`memory ${id} vanished after it was changed`);
      if (moved) revision += 1;
      return moved ? { kind: outcome.done, memory: decode(row) } : { kind: outcome.refused, memory: decode(row) };
    });

  const requireSource = (input: SaveMemoryInput): { seq: number; sessionId: string } => {
    const call = derived.read((view) => view.toolCallOf(input.runId, input.callId));
    if (call === undefined) throw new Error(`memory source ${input.runId}/${input.callId} has no recorded tool.call event`);
    return { seq: call.seq, sessionId: call.sessionId };
  };

  const visibilityOf = (visibility: MemoryVisibility): { sql: string; params: Record<string, string> } =>
    visibility.trusted ? { sql: VISIBLE_TRUSTED, params: { project: visibility.project } } : { sql: VISIBLE_UNTRUSTED, params: {} };

  const evidenceParams = (memoryId: string, ordinal: number, entry: MemoryEvidence) => ({
    memoryId,
    ordinal,
    kind: entry.kind,
    project: entry.kind === 'file' ? entry.project : null,
    path: entry.kind === 'file' ? entry.path : null,
    sha256: entry.kind === 'file' ? entry.sha256 : null,
    sha: entry.kind === 'commit' ? entry.sha : null,
    runId: entry.kind === 'check' ? entry.runId : null,
    callId: entry.kind === 'check' ? entry.conditionId : null,
    seq: entry.kind === 'check' ? entry.seq : null,
    command: entry.kind === 'check' ? entry.command : null,
    exitCode: entry.kind === 'check' ? entry.exitCode : null,
  });

  const matchedCte = (visibility: MemoryVisibility, terms: readonly string[]): { sql: string; params: Record<string, string | number>; shortCount: number } | undefined => {
    const { indexed, short } = partitionTerms(terms.map(asciiLower));
    if (indexed.length === 0 && short.length === 0) return undefined;
    const scope = visibilityOf(visibility);
    const parts: string[] = [];
    const params: Record<string, string | number> = { ...scope.params };
    if (indexed.length > 0) {
      parts.push(
        `SELECT id FROM (SELECT memories.id AS id FROM memories_index JOIN memories ON memories.id = memories_index.memory_id
         WHERE memories_index MATCH :recallMatch AND ${scope.sql} AND ${RECALLABLE} ORDER BY memories_index.rowid DESC LIMIT :matchLimit)`,
      );
      params['recallMatch'] = indexed.map(quoted).join(' OR ');
      params['matchLimit'] = MEMORY_MATCH_LIMIT;
    }
    if (short.length > 0) {
      parts.push(
        `SELECT id FROM (SELECT id, text FROM memories INDEXED BY memories_by_created WHERE ${scope.sql} AND ${RECALLABLE} ORDER BY created_at DESC, id DESC LIMIT :scanLimit)
         WHERE ${short.map((_term, index) => `instr(lower(text), :recallShort${index}) > 0`).join(' OR ')}`,
      );
      params['scanLimit'] = MEMORY_SCAN_LIMIT;
      short.forEach((term, index) => {
        params[`recallShort${index}`] = term;
      });
    }
    return { sql: `matched(id) AS (${parts.join(' UNION ')})`, params, shortCount: short.length };
  };

  const recallPage: MemoryStore['recallPage'] = (visibility, { terms, after, limit, through }) =>
    readTx(db, () => {
      const matched = matchedCte(visibility, terms);
      const lanes = lanesOf(visibility);
      const fetch = limit + 1;
      const laneBranch = (part: RecallCursor['part'], lane: string, index: number, cursor: RecallCursor | null): { sql: string; params: Record<string, string | number> } => {
        const key = `${part}${index}`;
        const params: Record<string, string | number> = { [`lane_${key}`]: lane };
        const bound = through === undefined ? '' : ` AND memories.rowid <= :through_${key}`;
        const recallable = recallableUntil(through === undefined ? '' : ` AND successor.rowid <= :through_${key}`);
        if (through !== undefined) params[`through_${key}`] = through;
        const keyset = cursor === null ? '' : ` AND (${RECALL_KEYS}) > (:cursorTier_${key}, :cursorContributed_${key}, :cursorKept_${key}, :cursorId_${key})`;
        if (cursor !== null) for (const [name, value] of Object.entries(cursorKeys(cursor))) params[`${name}_${key}`] = value;
        const membership = part === 'matched' ? 'AND memories.id IN (SELECT id FROM matched)' : matched === undefined ? '' : 'AND memories.id NOT IN (SELECT id FROM matched)';
        return {
          sql: `SELECT * FROM (SELECT memories.*, ${TIER} AS recall_tier, ${CONTRIBUTED_KEY} AS recall_contributed, ${KEPT_KEY} AS recall_kept, '${part}' AS recall_part
             FROM memories WHERE ${LANE} = :lane_${key} AND ${recallable} ${membership}${bound}${keyset} ORDER BY ${RECALL_KEYS} LIMIT :fetch)`,
          params,
        };
      };
      const branches = lanes.flatMap((lane, index) => {
        const matchedPart = matched !== undefined && (after === null || after.part === 'matched') ? [laneBranch('matched', lane, index, after?.part === 'matched' ? after : null)] : [];
        const restPart = [laneBranch('rest', lane, index, after?.part === 'rest' ? after : null)];
        return [...matchedPart, ...restPart];
      });
      const statement = `${matched === undefined ? '' : `WITH ${matched.sql} `}
        SELECT *, ${matched === undefined ? '0' : '(SELECT COUNT(*) FROM matched)'} AS recall_matched_total FROM (${branches.map((branch) => branch.sql).join(' UNION ALL ')})
        ORDER BY (recall_part = 'rest'), recall_tier, recall_contributed, recall_kept, id LIMIT :fetch`;
      const params = Object.assign({}, matched?.params ?? {}, ...branches.map((branch) => branch.params), { fetch });
      const rows = db.prepare(statement).all(params);
      const shown = rows.slice(0, limit);
      const last = shown[shown.length - 1];
      const part = (row: Row): RecallCursor['part'] => (readerFor('memories', String(row['id']), row).string('recall_part') === 'matched' ? 'matched' : 'rest');
      const first = rows[0];
      const matchedTotal = first === undefined ? 0 : readerFor('memories', 'page', first).number('recall_matched_total');
      return {
        memories: decodeMany(shown),
        next: rows.length > limit && last !== undefined ? cursorOf(part(last), last) : null,
        matchCapped: matchedTotal >= MEMORY_MATCH_LIMIT,
      } satisfies RecallPage;
    });

  return {
    save: (input) =>
      joinedTx(db, () => {
        if ((input.scope === 'project') !== (input.project !== null)) {
          throw new RangeError(`a ${input.scope} memory ${input.scope === 'project' ? 'requires' : 'cannot carry'} a project`);
        }
        const existing = bySource.get({ runId: input.runId, callId: input.callId });
        if (existing !== undefined) return { memory: decode(existing), created: false };
        const source = requireSource(input);
        const supersedes = input.supersedes ?? [];
        for (const id of supersedes) {
          if (byId.get({ id }) === undefined) throw new RangeError(`memory ${id} cannot be superseded: it does not exist`);
        }
        const id = uuidv7(clock);
        insert.run({
          id,
          scope: input.scope,
          origin: input.origin,
          project: input.project,
          text: input.text,
          sessionId: source.sessionId,
          runId: input.runId,
          step: input.step,
          callId: input.callId,
          seq: source.seq,
          now: clock.now(),
          kind: input.kind ?? DEFAULT_MEMORY_KIND,
          supersedesJson: JSON.stringify(supersedes),
        });
        (input.evidence ?? []).forEach((entry, ordinal) => void insertEvidence.run(evidenceParams(id, ordinal, entry)));
        observeUnboundWithoutEvidence(id, input.evidence ?? []);
        const row = bySource.get({ runId: input.runId, callId: input.callId });
        if (row === undefined) throw new Error(`memory ${input.runId}/${input.callId} vanished after it was saved`);
        revision += 1;
        return { memory: decode(row), created: true };
      }),
    addByCommand: (input) =>
      immediateTx(db, () => {
        if ((input.scope === 'project') !== (input.project !== null)) {
          throw new RangeError(`a ${input.scope} memory ${input.scope === 'project' ? 'requires' : 'cannot carry'} a project`);
        }
        const id = uuidv7(clock);
        insertByCommand.run({ id, scope: input.scope, project: input.project, text: input.text, now: clock.now(), kind: input.kind ?? DEFAULT_MEMORY_KIND });
        input.evidence.forEach((entry, ordinal) => void insertEvidence.run(evidenceParams(id, ordinal, entry)));
        observeUnboundWithoutEvidence(id, input.evidence);
        const row = byId.get({ id });
        if (row === undefined) throw new Error(`memory ${id} vanished after it was added`);
        revision += 1;
        return decode(row);
      }),
    saveCandidate: (input) =>
      joinedTx(db, () => {
        if ((input.scope === 'project') !== (input.project !== null)) {
          throw new RangeError(`a ${input.scope} memory ${input.scope === 'project' ? 'requires' : 'cannot carry'} a project`);
        }
        const callId = `reflection:${input.ordinal}`;
        const existing = bySource.get({ runId: input.runId, callId });
        if (existing !== undefined) return { memory: decode(existing), created: false };
        const session = sessionOfRun.get({ runId: input.runId });
        if (session === undefined) throw new Error(`memory source run ${input.runId} does not exist`);
        const id = uuidv7(clock);
        insertCandidate.run({
          id,
          scope: input.scope,
          origin: input.origin,
          project: input.project,
          text: input.text,
          sessionId: readerFor('runs', input.runId, session).string('session_id'),
          runId: input.runId,
          callId,
          now: clock.now(),
          kind: input.kind,
        });
        input.evidence.forEach((entry, ordinal) => void insertEvidence.run(evidenceParams(id, ordinal, entry)));
        observeUnboundWithoutEvidence(id, input.evidence);
        const row = bySource.get({ runId: input.runId, callId });
        if (row === undefined) throw new Error(`memory ${input.runId}/${callId} vanished after it was saved`);
        revision += 1;
        return { memory: decode(row), created: true };
      }),
    revision: () => revision,
    supersededIds: () => new Set(supersededIds.all().map((row) => String(row['id']))),
    activePage: (after, limit) =>
      activePage.all({ createdAt: after?.createdAt ?? -1, id: after?.id ?? '', limit }).map((row) => {
        const id = String(row['id']);
        return decodeMemory(context, row, evidenceOf.all({ id }).map((evidenceRow) => decodeEvidence(context, id, evidenceRow)), []);
      }),
    candidates: (filter = {}) => (filter.project === undefined ? candidateRows.all() : candidateRowsOfProject.all({ project: filter.project })).map(decode),
    accept: (id) => change(id, 'candidate', 'active', { done: 'accepted', refused: 'not_candidate' }, { kept: true }),
    reject: (id) => change(id, 'candidate', 'rejected', { done: 'rejected', refused: 'not_candidate' }),
    markDuplicate: (id, of) => {
      if (byId.get({ id: of }) === undefined) throw new RangeError(`memory ${of} cannot be the original of ${id}: it does not exist`);
      return change(id, 'active', 'duplicate', { done: 'marked', refused: 'not_active' }, { duplicateOf: of });
    },
    archive: (id) => change(id, 'active', 'archived', { done: 'archived', refused: 'not_active' }),
    restore: (id) => change(id, 'archived', 'active', { done: 'restored', refused: 'not_archived' }, { kept: true }),
    get: (id) => {
      const row = byId.get({ id });
      return row === undefined ? undefined : decode(row);
    },
    list: (filter = {}) => {
      if (filter.project !== undefined) return byProject.all({ project: filter.project }).map(decode);
      if (filter.scope !== undefined) return byScope.all({ scope: filter.scope }).map(decode);
      return all.all().map(decode);
    },
    listPage: (filter, after, limit) =>
      readTx(db, () => {
        const conditions = [
          'retired_at IS NULL',
          filter.state === undefined ? "state <> 'candidate'" : 'state = :state',
          ...(filter.scope === undefined ? [] : ['scope = :scope']),
          ...(filter.project === undefined ? [] : ['project = :project']),
          ...(after === null ? [] : ['(created_at, id) > (:createdAt, :cursorId)']),
        ];
        const params = {
          limit: limit + 1,
          ...(filter.state === undefined ? {} : { state: filter.state }),
          ...(filter.scope === undefined ? {} : { scope: filter.scope }),
          ...(filter.project === undefined ? {} : { project: filter.project }),
          ...(after === null ? {} : { createdAt: after.createdAt, cursorId: after.id }),
        };
        const rows = db.prepare(`SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY created_at, id LIMIT :limit`).all(params);
        const shown = rows.slice(0, limit);
        const last = shown[shown.length - 1];
        const reader = last === undefined ? undefined : readerFor('memories', String(last['id']), last);
        return { memories: decodeMany(shown), next: rows.length > limit && reader !== undefined ? { createdAt: reader.number('created_at'), id: reader.string('id') } : null };
      }),
    recallPage,
    watermark: () =>
      readTx(db, () => {
        const row = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS high FROM memories').get();
        if (row === undefined) throw new Error('the memory watermark query returned no row');
        return readerFor('memories', 'watermark', row).number('high');
      }),
    matchingIds: (visibility, terms) =>
      readTx(db, () => {
        const matched = matchedCte(visibility, terms);
        if (matched === undefined) return new Set<string>();
        return new Set(db.prepare(`WITH ${matched.sql} SELECT id FROM matched`).all(matched.params).map((row) => readerFor('memories', 'matching', row).string('id')));
      }),
    search: (visibility, terms, { include = 'live', limit } = {}) =>
      readTx(db, () => {
        const { indexed, short } = partitionTerms(terms.map(asciiLower));
        const scope = visibilityOf(visibility);
        const live = ` AND ${include === 'live' ? RECALLABLE : SEARCHABLE_WITH_HISTORY}`;
        const filters = instrFilters('text', short);
        const params: Record<string, string | number> = { ...scope.params, ...filters.params, fetch: limit === undefined ? -1 : limit };
        const candidates =
          indexed.length > 0
            ? `SELECT memories.* FROM memories_index JOIN memories ON memories.id = memories_index.memory_id
               WHERE memories_index MATCH :match AND ${scope.sql}${live} ORDER BY memories_index.rowid DESC LIMIT :matchLimit`
            : `SELECT * FROM memories INDEXED BY memories_by_created WHERE ${scope.sql}${live} ORDER BY created_at DESC, id DESC LIMIT :scanLimit`;
        if (indexed.length > 0) {
          params['match'] = indexed.map(quoted).join(' ');
          params['matchLimit'] = MEMORY_MATCH_LIMIT;
        } else {
          params['scanLimit'] = MEMORY_SCAN_LIMIT;
        }
        const rows = db.prepare(`SELECT * FROM (${candidates}) AS memories WHERE 1 = 1${filters.sql} ${RECALL_ORDER} LIMIT :fetch`).all(params);
        return decodeMany(rows);
      }),
    retire: (id) =>
      immediateTx(db, () => {
        const before = byId.get({ id });
        if (before === undefined) return undefined;
        const retired = Number(retireOnce.run({ id, now: clock.now() }).changes) === 1;
        const row = byId.get({ id });
        if (row === undefined) throw new Error(`memory ${id} vanished after it was retired`);
        if (retired) revision += 1;
        return { retired, memory: decode(row) };
      }),
    history: (id) => {
      const start = byId.get({ id });
      if (start === undefined) return [];
      const lookup = {
        byId: (memoryId: string): MemoryRecord | undefined => {
          const row = byId.get({ id: memoryId });
          return row === undefined ? undefined : decode(row);
        },
        successorsOf: (memoryId: string): MemoryRecord[] => successors.all({ id: memoryId }).map(decode),
      };
      return revisionChain(decode(start), lookup, (memory) => memory.createdAt);
    },
    observe: (id, status) => immediateTx(db, () => appendObservation(id, status)),
    observations: (id) =>
      observationsOf.all({ id }).map((row) => {
        const reader = readerFor('memory_observations', id, row);
        return { status: storedOneOf(context, 'memory_observations', id, 'status', MEMORY_STATUSES, reader.string('status')), observedAt: reader.number('observed_at') };
      }),
    stampContributed: (ids, at) => {
      for (const id of ids) stamp.run({ id, at });
    },
  };
};
